import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { revokeDevice, updateDevice } from "@psyche/db";
import { type PresenceVerifier, presenceChallenge } from "@psyche/permissions";
import type { ApprovalRequest } from "@psyche/protocol";
import { FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it } from "vitest";
import { composeHelper } from "../src/compose/helper.ts";
import { type ComposedGateway, type ComposeOptions, composeGateway } from "../src/compose/index.ts";
import { silentLogger } from "../src/log.ts";
import { desktopClient, ik, newDeviceKey, type TestClient } from "./helpers.ts";

/**
 * Security §10: security settings need operator.admin plus fresh user presence. With a presence
 * verifier present, `settings.set` on a security key first creates a device-only `policy_change`
 * card bound to the exact key and value; the change goes through only once that card is approved
 * with a verified presence assertion, and only once.
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

/** Stands in for Touch ID / a passkey: a "signature" is valid for exactly one challenge. */
const touchId: PresenceVerifier = {
  verify: async (assertion, challenge) => assertion.signature === `signed:${challenge}`,
};

const DEVICE = "admin-presence";

async function boot(presence?: PresenceVerifier, parts?: ComposeOptions["parts"]) {
  home = mkdtempSync(join(tmpdir(), "psyche-presence-"));
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
  // What `psyched devices grant` does: every operator scope on a paired desktop.
  const key = newDeviceKey();
  (await desktopClient(composed.gateway, key, DEVICE)).close();
  updateDevice(composed.gateway.context.db, DEVICE, {
    scopes: ["operator.read", "operator.write", "operator.approvals", "operator.admin"],
  });
  const admin = await desktopClient(composed.gateway, key, DEVICE);
  clients.push(admin);
  return { c: composed, admin };
}

const POLICY = { allow: ["calendar.list"] };
const set = (admin: TestClient, params: Record<string, unknown>) =>
  admin.request("settings.set", params, ik());

async function cardFor(admin: TestClient, res: Record<string, unknown>) {
  expect(res).toMatchObject({ ok: false, error: { code: "approval_required" } });
  const approvalId = (res as { error: { details: { approvalId: string } } }).error.details
    .approvalId;
  const got = await admin.call<{ approval: ApprovalRequest; answerToken?: string }>(
    "approvals.get",
    { approvalId },
  );
  expect(got.answerToken).toEqual(expect.any(String));
  return { approvalId, approval: got.approval, token: got.answerToken ?? "" };
}

const armed = () => new Promise((r) => setTimeout(r, 450)); // past the arm delay

function answer(admin: TestClient, approvalId: string, token: string, signature?: string) {
  return admin.request(
    "approvals.answer",
    {
      approvalId,
      answerToken: token,
      decision: "approve",
      ...(signature === undefined
        ? {}
        : { presence: { kind: "webauthn", deviceId: DEVICE, signature } }),
    },
    ik(),
  );
}

describe("fresh presence on security settings (security §10)", () => {
  it("a security key needs a presence-verified card bound to the exact value, used once", async () => {
    const { admin } = await boot(touchId);
    const first = await set(admin, { key: "permissions.policy", value: POLICY });
    const { approvalId, approval, token } = await cardFor(admin, first);
    expect(approval).toMatchObject({
      kind: "policy_change",
      status: "pending",
      deviceOnly: true,
      requiresAuthentication: true,
      scopesOffered: ["once"],
    });
    expect(approval.details).toMatchObject({ setting: "permissions.policy" });

    // Not before the card is approved.
    expect(
      await set(admin, { key: "permissions.policy", value: POLICY, approvalId }),
    ).toMatchObject({ ok: false, error: { code: "binding_mismatch" } });

    await armed();
    // A click alone, or a forged assertion, is refused.
    expect(await answer(admin, approvalId, token)).toMatchObject({
      ok: false,
      error: { code: "forbidden" },
    });
    expect(await answer(admin, approvalId, token, "signed:other")).toMatchObject({
      ok: false,
      error: { code: "forbidden" },
    });
    const challenge = presenceChallenge(approvalId, approval.bindingHash, token);
    expect(await answer(admin, approvalId, token, `signed:${challenge}`)).toMatchObject({
      ok: true,
    });

    // A different value is not covered; the approved value is, once.
    expect(
      await set(admin, { key: "permissions.policy", value: { allow: ["*"] }, approvalId }),
    ).toMatchObject({ ok: false, error: { code: "binding_mismatch" } });
    expect(await set(admin, { key: "exec.mode", value: POLICY, approvalId })).toMatchObject({
      ok: false,
      error: { code: "binding_mismatch" },
    });
    expect(
      await set(admin, { key: "permissions.policy", value: POLICY, approvalId }),
    ).toMatchObject({ ok: true, payload: { entry: { key: "permissions.policy" } } });
    expect(
      await set(admin, { key: "permissions.policy", value: POLICY, approvalId }),
    ).toMatchObject({ ok: false, error: { code: "binding_mismatch" } });
  });

  it("channel allow policies and owner identities are security keys too", async () => {
    const { admin } = await boot(touchId);
    for (const key of [
      "channels.telegram.allowFrom",
      "commands.ownerAllowFrom",
      "vault.autoLock",
    ]) {
      expect(await set(admin, { key, value: [] })).toMatchObject({
        ok: false,
        error: { code: "approval_required" },
      });
    }
  });

  it("cosmetic and non-security admin keys need no card", async () => {
    const { admin } = await boot(touchId);
    expect(await set(admin, { key: "appearance.theme", value: "dark" })).toMatchObject({
      ok: true,
    });
    expect(await set(admin, { key: "models.default", value: "fake/model" })).toMatchObject({
      ok: true,
    });
  });

  it("an approval of another kind cannot authorize a setting", async () => {
    const { c, admin } = await boot(touchId);
    const { approval } = await c.broker.requestApproval({
      kind: "connector_action",
      summary: "x",
      details: {},
      bindingHash: `sha256:${"1".repeat(64)}`,
      grantKey: "k",
      requestedBy: { runId: null, taskId: null, threadId: null },
      sideEffect: "write",
      surfaces: ["desktop"],
      taint: false,
    });
    expect(
      await set(admin, { key: "permissions.policy", value: POLICY, approvalId: approval.id }),
    ).toMatchObject({ ok: false, error: { code: "forbidden" } });
  });

  it("the Mac helper gates security settings only once a paired device has a key", async () => {
    // psyched mounts the helper by default; with no registered key nobody could approve, so
    // gating would lock the owner out.
    const keys = new Map<string, string>();
    const { c, admin } = await boot(undefined, [
      (s) => composeHelper(s, { presenceKeys: (id) => keys.get(id) }),
    ]);
    const policy = (value: unknown) => set(admin, { key: "permissions.policy", value });
    expect(await policy(POLICY)).toMatchObject({ ok: true });

    // A key for an unknown or a revoked device verifies nothing either.
    keys.set("no-such-device", "registered-key");
    (await desktopClient(c.gateway, newDeviceKey(), "old-helper")).close();
    keys.set("old-helper", "registered-key");
    revokeDevice(c.gateway.context.db, "old-helper");
    expect(await policy({ allow: [] })).toMatchObject({ ok: true });

    keys.set(DEVICE, "registered-key");
    expect(await policy(POLICY)).toMatchObject({
      ok: false,
      error: { code: "approval_required" },
    });
  });

  it("without any presence verifier the old rule applies (operator.admin only)", async () => {
    const { admin } = await boot();
    expect(await set(admin, { key: "permissions.policy", value: POLICY })).toMatchObject({
      ok: true,
    });
  });
});
