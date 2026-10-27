import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { updateDevice } from "@psyche/db";
import { type PresenceVerifier, presenceChallenge } from "@psyche/permissions";
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

async function boot(presence?: PresenceVerifier, parts?: ComposeOptions["parts"]) {
  home = mkdtempSync(join(tmpdir(), "psyche-fresh-"));
  composed = await composeGateway({
    env: {},
    logger: silentLogger,
    retentionIntervalMs: 0,
    background: false,
    config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null },
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

async function approveWithPresence(admin: TestClient, res: Record<string, unknown>) {
  expect(res).toMatchObject({ ok: false, error: { code: "approval_required" } });
  const approvalId = (res as { error: { details: { approvalId: string } } }).error.details
    .approvalId;
  const got = await admin.call<{ approval: ApprovalRequest; answerToken?: string }>(
    "approvals.get",
    { approvalId },
  );
  expect(got.approval).toMatchObject({ kind: "policy_change", requiresAuthentication: true });
  const token = got.answerToken ?? "";
  await new Promise((r) => setTimeout(r, 450)); // past the arm delay
  const challenge = presenceChallenge(approvalId, got.approval.bindingHash, token);
  expect(
    await admin.request(
      "approvals.answer",
      {
        approvalId,
        answerToken: token,
        decision: "approve",
        presence: { kind: "webauthn", deviceId: DEVICE, signature: `signed:${challenge}` },
      },
      ik(),
    ),
  ).toMatchObject({ ok: true });
  return { approvalId, approval: got.approval };
}

describe("fresh presence on admin methods", () => {
  it("memory.reset needs a card bound to its params; a dry run does not", async () => {
    const { admin } = await boot(touchId);
    expect(await admin.request("memory.reset", { dryRun: true }, ik())).toMatchObject({
      ok: true,
    });
    const first = await admin.request("memory.reset", {}, ik());
    const { approvalId, approval } = await approveWithPresence(admin, first);
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
  it("losing the last verifier fails security changes presence_required, not admin-only", async () => {
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

    const res = await policy();
    expect(res).toMatchObject({ ok: false, error: { code: "presence_required" } });
    expect(await admin.request("memory.reset", {}, ik())).toMatchObject({
      ok: false,
      error: { code: "presence_required" },
    });
  });

  it("psyched presence reset clears the enrollment", async () => {
    const { c } = await boot();
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
      expect(runCli(["presence", "reset"], (l) => lines.push(l))).toBe(0);
    } finally {
      if (prev === undefined) delete process.env.PSYCHE_HOME;
      else process.env.PSYCHE_HOME = prev;
      if (prevDb === undefined) delete process.env.PSYCHE_DB;
      else process.env.PSYCHE_DB = prevDb;
    }
    expect(lines[0]).toMatch(/presence enrollment cleared/);
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
