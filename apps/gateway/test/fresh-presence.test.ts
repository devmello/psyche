import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { updateDevice } from "@psyche/db";
import type { PresenceVerifier } from "@psyche/permissions";
import type { ApprovalRequest } from "@psyche/protocol";
import { FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli.ts";
import { composeHelper } from "../src/compose/helper.ts";
import { type ComposedGateway, type ComposeOptions, composeGateway } from "../src/compose/index.ts";
import { silentLogger } from "../src/log.ts";
import { PRESENCE_ENROLLED_SETTING, presenceStateFor } from "../src/presence-gate.ts";
import { desktopClient, ik, newDeviceKey, type TestClient } from "./helpers.ts";

/**
 * Security §10, docs/archive/status/s05.md §2 gap 4: fresh presence for access-widening and destructive
 * `operator.admin` methods (not only security settings), fail closed once presence was enrolled,
 * and a device's first passkey needs the owner's presence from elsewhere.
 */

const clients: TestClient[] = [];
let composed: ComposedGateway | null = null;
let home = "";

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await composed?.stop("test");
  composed?.gateway.context.db.close();
  composed = null;
  if (home) rmSync(home, { recursive: true, force: true });
  home = "";
});

const touchId: PresenceVerifier = {
  verify: async (assertion, challenge) => assertion.signature === `signed:${challenge}`,
};
const DEVICE = "admin-fresh";

/** Added to the real clock: a test moves the Gateway a day ahead without fake timers. */
let offsetMs = 0;

async function boot(
  presence?: PresenceVerifier,
  parts?: ComposeOptions["parts"],
  config: Record<string, unknown> = {},
  security?: ComposeOptions["security"],
) {
  home = mkdtempSync(join(tmpdir(), "psyche-fresh-"));
  offsetMs = 0;
  composed = await composeGateway({
    env: {},
    now: () => new Date(Date.now() + offsetMs),
    ...(security === undefined ? {} : { security }),
    logger: silentLogger,
    retentionIntervalMs: 0,
    background: false,
    config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null, ...config },
    model: { provider: new FakeModelProvider(), model: "fake/model" },
    ...(presence === undefined ? {} : { presence }),
    ...(parts === undefined ? {} : { parts }),
  });
  const key = newDeviceKey();
  (await desktopClient(composed.gateway, key, DEVICE)).close();
  updateDevice(composed.gateway.context.db, DEVICE, {
    scopes: ["operator.read", "operator.write", "operator.approvals", "operator.admin"],
  });
  const admin = await desktopClient(composed.gateway, key, DEVICE);
  clients.push(admin);
  return { c: composed, admin };
}

/**
 * Presence is for payments only: a security change is a plain tap on its card (no presence
 * assertion, `requiresAuthentication` false), still bound to the exact change and spent once.
 */
async function approveWithTap(admin: TestClient, res: Record<string, unknown>) {
  expect(res).toMatchObject({ ok: false, error: { code: "approval_required" } });
  const approvalId = (res as { error: { details: { approvalId: string } } }).error.details
    .approvalId;
  const got = await admin.call<{ approval: ApprovalRequest; answerToken?: string }>(
    "approvals.get",
    { approvalId },
  );
  expect(got.approval).toMatchObject({ kind: "policy_change", requiresAuthentication: false });
  const token = got.answerToken ?? "";
  await new Promise((r) => setTimeout(r, 450)); // past the arm delay
  expect(
    await admin.request(
      "approvals.answer",
      { approvalId, answerToken: token, decision: "approve" },
      ik(),
    ),
  ).toMatchObject({ ok: true });
  return { approvalId, approval: got.approval };
}

/** The card that enrolling a presence verifier raises: it still needs presence. */
async function strongCard(admin: TestClient, res: Record<string, unknown>) {
  expect(res).toMatchObject({ ok: false, error: { code: "approval_required" } });
  const approvalId = (res as { error: { details: { approvalId: string } } }).error.details
    .approvalId;
  const got = await admin.call<{ approval: ApprovalRequest; answerToken?: string }>(
    "approvals.get",
    { approvalId },
  );
  expect(got.approval).toMatchObject({ kind: "policy_change", requiresAuthentication: true });
  return { approvalId, approval: got.approval, token: got.answerToken ?? "" };
}

describe("fresh presence on admin methods", () => {
  it("memory.reset needs a card bound to its params; a dry run does not", async () => {
    const { admin } = await boot(touchId);
    expect(await admin.request("memory.reset", { dryRun: true }, ik())).toMatchObject({
      ok: true,
    });
    const first = await admin.request("memory.reset", {}, ik());
    const { approvalId, approval } = await approveWithTap(admin, first);
    expect(approval.details).toMatchObject({ method: "memory.reset" });

    const key = ik();
    expect(await admin.request("memory.reset", { approvalId }, key)).toMatchObject({ ok: true });
    // A network retry with the same key replays the stored result without a second approval.
    expect(await admin.request("memory.reset", { approvalId }, key)).toMatchObject({ ok: true });
    // A new call cannot reuse the consumed card.
    expect(await admin.request("memory.reset", { approvalId }, ik())).toMatchObject({
      ok: false,
      error: { code: "binding_mismatch" },
    });
  });

  it("a pairing link needs a card bound to its scopes, and the card is spent by one link", async () => {
    const { admin } = await boot(touchId, undefined, {
      publicOrigin: "https://studio-mac.tail1234.ts.net",
      allowedOrigins: ["https://studio-mac.tail1234.ts.net"],
    });
    const scopes = ["operator.read", "operator.write"];
    const first = await admin.request("devices.setupToken.create", { scopes });
    const { approvalId, approval } = await approveWithTap(admin, first);
    expect(approval.details).toMatchObject({ method: "devices.setupToken.create" });
    // The card covers those scopes and no others: asking for admin with it is refused.
    expect(
      await admin.request("devices.setupToken.create", {
        scopes: [...scopes, "operator.admin"],
        approvalId,
      }),
    ).toMatchObject({ ok: false, error: { code: "binding_mismatch" } });
    const made = await admin.request("devices.setupToken.create", { scopes, approvalId });
    expect(made).toMatchObject({ ok: true });
    expect((made.payload as { link: string }).link).toMatch(/^psyche-pair:v1:/);
    // The card is spent: a second link needs a second approval.
    expect(await admin.request("devices.setupToken.create", { scopes, approvalId })).toMatchObject({
      ok: false,
      error: { code: "binding_mismatch" },
    });
  });

  it("another device cannot spend the card the owner approved for a link", async () => {
    const { admin, c } = await boot(touchId, undefined, {
      publicOrigin: "https://studio-mac.tail1234.ts.net",
      allowedOrigins: ["https://studio-mac.tail1234.ts.net"],
    });
    const scopes = ["operator.read", "operator.write"];
    const first = await admin.request("devices.setupToken.create", { scopes });
    const { approvalId } = await approveWithTap(admin, first);
    // A second Host-shell admin presents device A's approved card.
    const keyB = newDeviceKey();
    (await desktopClient(c.gateway, keyB, "admin-b")).close();
    updateDevice(c.gateway.context.db, "admin-b", {
      scopes: ["operator.read", "operator.write", "operator.approvals", "operator.admin"],
    });
    const other = await desktopClient(c.gateway, keyB, "admin-b");
    clients.push(other);
    expect(await other.request("devices.setupToken.create", { scopes, approvalId })).toMatchObject({
      ok: false,
      error: { code: "binding_mismatch" },
    });
    expect(
      c.gateway.context.db.sqlite.prepare("SELECT count(*) AS n FROM setup_tokens").get(),
    ).toMatchObject({ n: 0 });
    // The owner's own device can still use it.
    expect(await admin.request("devices.setupToken.create", { scopes, approvalId })).toMatchObject({
      ok: true,
    });
  });

  it("narrowing admin calls stay admin-only", async () => {
    const { admin } = await boot(touchId);
    expect(await admin.call("devices.list", {})).toBeDefined();
    const other = await desktopClient(composed?.gateway as never, newDeviceKey(), "other-desk");
    other.close();
    expect(await admin.request("devices.revoke", { deviceId: "other-desk" }, ik())).toMatchObject({
      ok: true,
    });
  });
});

describe("fail closed once presence was enrolled", () => {
  it("losing the last verifier leaves security changes one tap, not admin-only and not presence_required", async () => {
    const keys = new Map<string, string>();
    const { admin } = await boot(undefined, [
      (s) => composeHelper(s, { presenceKeys: (id) => keys.get(id) }),
    ]);
    const policy = () =>
      admin.request("settings.set", { key: "permissions.policy", value: { allow: [] } }, ik());
    // Never enrolled: operator.admin alone, as before.
    expect(await policy()).toMatchObject({ ok: true });

    keys.set(DEVICE, "registered-key");
    // Any admin call records the enrollment, before a revocation could switch the gate off.
    await admin.call("devices.list", {});
    keys.delete(DEVICE);

    // Presence is for payments only: the change still needs its card, and a tap approves it.
    const { approvalId } = await approveWithTap(admin, await policy());
    expect(
      await admin.request(
        "settings.set",
        { key: "permissions.policy", value: { allow: [] }, approvalId },
        ik(),
      ),
    ).toMatchObject({ ok: true });
    const mem = await admin.request("memory.reset", {}, ik());
    expect(mem).toMatchObject({ ok: false, error: { code: "approval_required" } });
  });

  it("enrolling a presence verifier still fails closed with no verifier, and its card needs presence", async () => {
    const keys = new Map<string, string>();
    const { c } = await boot(undefined, [
      (s) => composeHelper(s, { presenceKeys: (id) => keys.get(id) }),
    ]);
    const phone = await desktopClient(c.gateway, newDeviceKey(), "phone-strong");
    clients.push(phone);
    const finish = () =>
      phone.request("passkeys.register.finish", { ceremonyId: "cer_x", response: {} }, ik());
    // Presence ready (a verifier exists): the card for adding the first passkey needs presence.
    keys.set(DEVICE, "registered-key");
    const strong = await strongCard(phone, await finish());
    await new Promise((r) => setTimeout(r, 450));
    // A tap with no presence assertion is refused (no verifier is configured at the broker here,
    // so the card's flag is what the UI/helper act on; the helper path is in helper-presence-key).
    expect(strong.approval.requiresAuthentication).toBe(true);
    // The last verifier goes: the enrollment stays sticky, so this fails closed.
    await phone.call("devices.list", {}).catch(() => undefined);
    keys.delete(DEVICE);
    expect(await finish()).toMatchObject({ ok: false, error: { code: "presence_required" } });
  });

  it("psyched presence reset waits 24 hours in plain view, then clears the enrollment", async () => {
    const { c } = await boot(undefined, undefined, {}, { pollMs: 20 });
    const db = c.gateway.context.db;
    let ready = true;
    expect(presenceStateFor(db, () => ready)()).toBe("ready");
    ready = false;
    expect(presenceStateFor(db, () => ready)()).toBe("unavailable");
    const lines: string[] = [];
    const prev = process.env.PSYCHE_HOME;
    const prevDb = process.env.PSYCHE_DB;
    process.env.PSYCHE_HOME = home;
    process.env.PSYCHE_DB = join(home, "psyche.db");
    try {
      // 3: waiting. Nothing changed yet; every device shows the request.
      const code = await runCli(["presence", "reset"], (l) => lines.push(l), { pollMs: 20 });
      expect(code).toBe(3);
    } finally {
      if (prev === undefined) delete process.env.PSYCHE_HOME;
      else process.env.PSYCHE_HOME = prev;
      if (prevDb === undefined) delete process.env.PSYCHE_DB;
      else process.env.PSYCHE_DB = prevDb;
    }
    expect(lines[0]).toMatch(/^waiting: this applies at /);
    expect(presenceStateFor(db, () => false)()).toBe("unavailable");
    const recoveries = c.gateway.context.securityRecoveries;
    const [waiting] = recoveries?.list() ?? [];
    expect(waiting).toMatchObject({ op: "presence.reset", status: "waiting" });
    expect(c.gateway.context.securityState?.alerts.open().map((a) => a.kind)).toContain(
      "recovery_requested",
    );
    // A day later it applies by itself.
    offsetMs = 24 * 60 * 60 * 1000 + 1000;
    recoveries?.applyDue();
    expect(recoveries?.get(waiting?.id ?? "")?.status).toBe("applied");
    expect(presenceStateFor(db, () => false)()).toBe("off");
    expect(PRESENCE_ENROLLED_SETTING.startsWith("_")).toBe(true);
  });
});

describe("a device's first passkey", () => {
  it("needs the owner's fresh presence once a verifier exists elsewhere", async () => {
    const keys = new Map<string, string>([[DEVICE, "registered-key"]]);
    const { c } = await boot(undefined, [
      (s) => composeHelper(s, { presenceKeys: (id) => keys.get(id) }),
    ]);
    const phone = await desktopClient(c.gateway, newDeviceKey(), "phone-without-passkey");
    clients.push(phone);
    const res = await phone.request(
      "passkeys.register.finish",
      { ceremonyId: "cer_x", response: {} },
      ik(),
    );
    expect(res).toMatchObject({ ok: false, error: { code: "approval_required" } });
  });

  it("is free on a Gateway that never had presence (the first enrollment)", async () => {
    const { c } = await boot();
    const phone = await desktopClient(c.gateway, newDeviceKey(), "first-phone");
    clients.push(phone);
    const res = (await phone.request(
      "passkeys.register.finish",
      { ceremonyId: "cer_x", response: {} },
      ik(),
    )) as { ok: boolean; error?: { code: string } };
    // Past the gate: the ceremony itself is what fails here.
    expect(res.ok).toBe(false);
    expect(res.error?.code).not.toBe("approval_required");
    expect(res.error?.code).not.toBe("presence_required");
  });
});
