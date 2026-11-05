import { createHash, generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSetting, setSetting } from "@psyche/db";
import { approvalCode, presenceChallenge } from "@psyche/permissions";
import type { ApprovalRequest } from "@psyche/protocol";
import { FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { composeHelper, helperErrorFields, helperPresenceMessage } from "../src/compose/helper.ts";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import { PRESENCE_REMOVED_SETTING } from "../src/compose/presence-keys.ts";
import { silentLogger } from "../src/log.ts";
import { FakeNode, type FakeNodeHandler, pairNodeDevice } from "./fake-node.ts";
import { adminClient, ik, newDeviceKey, type TestClient, wsUrlOf } from "./helpers.ts";

/**
 * Allow in the desktop window on a card that needs Touch ID (security §3.7): the Gateway asks the
 * helper to sign the presence challenge for the window's own answer token, and the broker checks
 * it against the registered key exactly as for a notification answer. When the helper is down,
 * too old or has no key, the error names that reason so the card can offer the fix.
 */

const clients: TestClient[] = [];
const nodes: FakeNode[] = [];
let composed: ComposedGateway | null = null;
let home = "";

afterEach(() => reset());

function enclaveKey() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
  const x963 = Buffer.concat([
    Buffer.from([0x04]),
    Buffer.from(jwk.x, "base64url"),
    Buffer.from(jwk.y, "base64url"),
  ]);
  return {
    publicKey: x963.toString("base64url"),
    keyId: createHash("sha256").update(x963).digest("hex"),
    privateKey,
  };
}

function signChallenge(privateKey: KeyObject, challenge: string): string {
  return sign("sha256", helperPresenceMessage(challenge), {
    key: privateKey,
    dsaEncoding: "der",
  }).toString("base64url");
}

type Confirm = (p: { challenge: string; summary: string; code: string }) => unknown;

/** A different key the fake helper reports from now on (a reset made a new one). */
let helperKeyOverride: ReturnType<typeof enclaveKey> | undefined;

function helperHandlers(
  key: ReturnType<typeof enclaveKey>,
  confirm?: Confirm,
  kind?: string,
): FakeNodeHandler[] {
  return [
    {
      capability: { name: "presence.public_key", sideEffect: "read", streaming: false },
      run: () => {
        const k = helperKeyOverride ?? key;
        return { publicKey: k.publicKey, keyId: k.keyId, ...(kind ? { kind } : {}) };
      },
    },
    ...(confirm === undefined
      ? []
      : [
          {
            capability: {
              name: "presence.confirm",
              sideEffect: "write" as const,
              streaming: false,
            },
            run: (params: unknown) =>
              confirm(params as { challenge: string; summary: string; code: string }),
          },
        ]),
    {
      capability: { name: "notify.show", sideEffect: "write", streaming: false },
      run: () => ({ shown: true }),
    },
    {
      capability: { name: "notify.withdraw", sideEffect: "write", streaming: false },
      run: () => ({ withdrawn: true }),
    },
    {
      capability: { name: "notify.subscribe", sideEffect: "read", streaming: true },
      run: () => new Promise(() => undefined),
    },
  ];
}

async function setup(
  opts: {
    helper?: boolean;
    confirm?: Confirm;
    register?: boolean;
    kind?: string;
    allowDevFileKey?: boolean;
  } = {},
) {
  home = mkdtempSync(join(tmpdir(), "psyche-touchid-"));
  composed = await composeGateway({
    env: {},
    logger: silentLogger,
    retentionIntervalMs: 0,
    background: false,
    config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null },
    model: { provider: new FakeModelProvider(), model: "fake/model" },
    parts: [(s) => composeHelper(s)],
  });
  const admin = await adminClient(composed.gateway);
  clients.push(admin);
  const key = enclaveKey();
  const helperDevice = `helper-${Math.random().toString(36).slice(2)}`;
  if (opts.helper !== false) {
    const node = await FakeNode.connect(composed.gateway.config.nodeSocketPath, {
      origin: composed.gateway.origin,
      secret: composed.gateway.handshakeSecret,
      handlers: helperHandlers(key, opts.confirm, opts.kind ?? "keychain"),
      deviceId: helperDevice,
    });
    nodes.push(node);
    await vi.waitFor(() =>
      expect(node.invocations.map((i) => i.capability)).toContain("notify.subscribe"),
    );
    if (opts.allowDevFileKey === true) {
      await admin.call(
        "settings.set",
        { key: "devices.presence.allowDevFileKey", value: true },
        ik(),
      );
    }
    if (opts.register !== false) {
      await admin.call(
        "devices.presenceKey.register",
        { deviceId: helperDevice, expectKeyId: key.keyId },
        ik(),
      );
    }
  }
  return { c: composed, admin, key, helperDevice };
}

/** A presence-gated change: a `policy_change` card that requires authentication. */
async function securityCard(admin: TestClient) {
  const first = await admin.request(
    "settings.set",
    { key: "permissions.policy", value: { allow: [] } },
    ik(),
  );
  const approvalId = (first as { error: { details: { approvalId: string } } }).error.details
    .approvalId;
  const got = await admin.call<{ approval: ApprovalRequest; answerToken?: string }>(
    "approvals.get",
    { approvalId },
  );
  await new Promise((r) => setTimeout(r, 450)); // past the arm delay
  return { approval: got.approval, token: got.answerToken ?? "" };
}

/** A card that requires authentication whether or not presence is enrolled yet. */
async function authCard(c: ComposedGateway, admin: TestClient) {
  const issued = await c.gateway.context.broker.requestApproval({
    kind: "policy_change",
    summary: "Change a security setting",
    details: {},
    bindingHash: "b".repeat(64),
    grantKey: "b".repeat(64),
    requestedBy: { runId: null, taskId: null, threadId: null },
    sideEffect: "destructive",
    surfaces: ["desktop", "web"],
    scopesOffered: ["once"],
    taint: false,
  });
  const got = await admin.call<{ approval: ApprovalRequest; answerToken?: string }>(
    "approvals.get",
    { approvalId: issued.approval.id },
  );
  return { approval: got.approval, token: got.answerToken ?? "" };
}

async function reset(): Promise<void> {
  for (const cl of clients.splice(0)) cl.close();
  for (const n of nodes.splice(0)) await n.close();
  await composed?.stop("test");
  composed = null;
  helperKeyOverride = undefined;
  if (home) rmSync(home, { recursive: true, force: true });
  home = "";
}

describe("approvals.approveWithTouchId (window Allow on a Touch ID card)", () => {
  it("the helper signs the window's own challenge after Touch ID and the broker approves", async () => {
    const asked: { challenge: string; summary: string; code: string }[] = [];
    const holder: { key?: ReturnType<typeof enclaveKey> } = {};
    const { c, admin, helperDevice, key } = await setup({
      confirm: (p) => {
        asked.push(p);
        const k = holder.key as ReturnType<typeof enclaveKey>;
        return { signature: signChallenge(k.privateKey, p.challenge), keyId: k.keyId };
      },
    });
    holder.key = key;
    const { approval, token } = await securityCard(admin);
    expect(approval.requiresAuthentication).toBe(true);
    const res = await admin.call<{ approval: ApprovalRequest }>(
      "approvals.approveWithTouchId",
      { approvalId: approval.id, answerToken: token },
      ik(),
    );
    expect(res.approval.status).toBe("approved");
    // Same challenge format as web passkeys, for this window's token; the header is the card's.
    expect(asked).toEqual([
      {
        challenge: presenceChallenge(approval.id, approval.bindingHash, token),
        summary: approval.summary,
        code: approvalCode(approval.bindingHash),
      },
    ]);
    expect(res.approval.decidedBy).toMatchObject({ deviceId: helperDevice, surface: "desktop" });
    expect((await c.audit.query({ kind: "approval.touch_id_from_window" }))[0]?.data).toMatchObject(
      { approvalId: approval.id, helperDeviceId: helperDevice, keyId: key.keyId },
    );
  });

  it("a signature by any other key is refused by the broker", async () => {
    const other = enclaveKey();
    const { admin } = await setup({
      confirm: (p) => ({
        signature: signChallenge(other.privateKey, p.challenge),
        keyId: other.keyId,
      }),
    });
    const { approval, token } = await securityCard(admin);
    expect(
      await admin.request(
        "approvals.approveWithTouchId",
        { approvalId: approval.id, answerToken: token },
        ik(),
      ),
    ).toMatchObject({
      ok: false,
      error: { code: "forbidden", details: { reason: "presence_invalid" } },
    });
  });

  it("names why it cannot run: no helper, an old helper, no registered key", async () => {
    const reasonOf = async (opts: Parameters<typeof setup>[0]) => {
      const { c, admin } = await setup(opts);
      const card = await authCard(c, admin);
      const r = await admin.request(
        "approvals.approveWithTouchId",
        { approvalId: card.approval.id, answerToken: card.token },
        ik(),
      );
      await reset();
      return (r as { error?: unknown }).error;
    };
    expect(await reasonOf({ helper: false })).toMatchObject({
      code: "unavailable",
      details: { reason: "helper_offline" },
    });
    expect(await reasonOf({})).toMatchObject({
      code: "unavailable",
      details: { reason: "helper_outdated" },
    });
    expect(await reasonOf({ confirm: () => ({ signature: "x" }), register: false })).toMatchObject({
      code: "unavailable",
      details: { reason: "no_presence_key" },
    });
  });

  it("a helper without a keychain access group says so", async () => {
    const { admin } = await setup({
      confirm: () => {
        throw Object.assign(new Error("missing entitlement"), {
          code: "unavailable",
          details: { reason: "missing_entitlement" },
        });
      },
    });
    const { approval, token } = await securityCard(admin);
    expect(
      await admin.request(
        "approvals.approveWithTouchId",
        { approvalId: approval.id, answerToken: token },
        ik(),
      ),
    ).toMatchObject({
      ok: false,
      error: { code: "unavailable", details: { reason: "presence_key_unavailable" } },
    });
  });

  it("a cancelled Touch ID leaves the card pending", async () => {
    const { admin } = await setup({
      confirm: () => {
        throw Object.assign(new Error("The user cancelled authentication"), {
          code: "cancelled",
        });
      },
    });
    const { approval, token } = await securityCard(admin);
    expect(
      await admin.request(
        "approvals.approveWithTouchId",
        { approvalId: approval.id, answerToken: token },
        ik(),
      ),
    ).toMatchObject({ ok: false, error: { code: "cancelled" } });
    expect(
      (
        await admin.call<{ approval: ApprovalRequest }>("approvals.get", {
          approvalId: approval.id,
        })
      ).approval.status,
    ).toBe("pending");
  });

  it("nodes.invoke can never reach presence.*", async () => {
    const { admin, c } = await setup({ confirm: () => ({ signature: "x" }) });
    const node = c.gateway.context.nodes.list()[0];
    for (const capability of ["presence.confirm", "presence.public_key"]) {
      expect(
        await admin.request(
          "nodes.invoke",
          {
            nodeId: node?.id,
            capability,
            params: { challenge: "0".repeat(64), summary: "x", code: "0000-0000" },
          },
          ik(),
        ),
      ).toMatchObject({ ok: false, error: { code: "forbidden" } });
    }
  });

  it("records which key the helper uses: keychain, or the Secure Enclave file on unprofiled builds", async () => {
    const { admin, helperDevice } = await setup({ kind: "enclave_file", allowDevFileKey: true });
    expect(await admin.call("devices.presenceKey.list", {})).toMatchObject({
      presenceKeys: [{ deviceId: helperDevice, kind: "enclave_file" }],
    });
    await reset();
    const old = await setup({ kind: "", allowDevFileKey: true });
    const listed = await old.admin.call<{ presenceKeys: Record<string, unknown>[] }>(
      "devices.presenceKey.list",
      {},
    );
    expect(listed.presenceKeys[0]).not.toHaveProperty("kind");
  });

  it("checks the window's token before any Touch ID sheet", async () => {
    let asked = 0;
    const { c, admin } = await setup({
      confirm: () => {
        asked++;
        return { signature: "x" };
      },
    });
    const { approval } = await securityCard(admin);
    expect(
      await admin.request(
        "approvals.approveWithTouchId",
        { approvalId: approval.id, answerToken: "not-this-windows-token" },
        ik(),
      ),
    ).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(asked).toBe(0);
    expect(
      (await c.audit.query({ kind: "approval.answer_rejected" })).map((e) => e.data.reason),
    ).toContain("unknown_token");
  });

  it("raises one sheet at a time, whatever the card", async () => {
    let release: (v: unknown) => void = () => undefined;
    const { admin } = await setup({
      confirm: () =>
        new Promise((r) => {
          release = r;
        }),
    });
    const first = await securityCard(admin);
    const pending = admin.request(
      "approvals.approveWithTouchId",
      { approvalId: first.approval.id, answerToken: first.token },
      ik(),
    );
    await new Promise((r) => setTimeout(r, 100));
    const second = await admin.request(
      "settings.set",
      { key: "permissions.policy", value: { deny: [] } },
      ik(),
    );
    const secondId = (second as { error: { details: { approvalId: string } } }).error.details
      .approvalId;
    const got = await admin.call<{ answerToken?: string }>("approvals.get", {
      approvalId: secondId,
    });
    await new Promise((r) => setTimeout(r, 450));
    expect(
      await admin.request(
        "approvals.approveWithTouchId",
        { approvalId: secondId, answerToken: got.answerToken ?? "" },
        ik(),
      ),
    ).toMatchObject({ ok: false, error: { code: "conflict" } });
    release({ signature: "x" });
    await pending;
  });

  it("two calls at the same moment raise one sheet (the guard is taken before the precheck)", async () => {
    let asked = 0;
    let release: (v: unknown) => void = () => undefined;
    const { admin } = await setup({
      confirm: () => {
        asked++;
        return new Promise((r) => {
          release = r;
        });
      },
    });
    const first = await securityCard(admin);
    const second = await admin.request(
      "settings.set",
      { key: "permissions.policy", value: { deny: [] } },
      ik(),
    );
    const secondId = (second as { error: { details: { approvalId: string } } }).error.details
      .approvalId;
    const got = await admin.call<{ answerToken?: string }>("approvals.get", {
      approvalId: secondId,
    });
    await new Promise((r) => setTimeout(r, 450));
    // Both sent before either is answered: no await between them.
    const a = admin.request(
      "approvals.approveWithTouchId",
      { approvalId: first.approval.id, answerToken: first.token },
      ik(),
    );
    const b = admin.request(
      "approvals.approveWithTouchId",
      { approvalId: secondId, answerToken: got.answerToken ?? "" },
      ik(),
    );
    await new Promise((r) => setTimeout(r, 150));
    expect(asked).toBe(1);
    release({ signature: "x" });
    const results = await Promise.all([a, b]);
    expect(
      results.filter((r) => (r as { error?: { code?: string } }).error?.code === "conflict"),
    ).toHaveLength(1);
    expect(asked).toBe(1);
  });

  it("a cancelled or failed sheet counts as a rejected answer", async () => {
    const { c, admin } = await setup({
      confirm: () => {
        throw Object.assign(new Error("cancelled"), { code: "cancelled" });
      },
    });
    const { approval, token } = await securityCard(admin);
    await admin.request(
      "approvals.approveWithTouchId",
      { approvalId: approval.id, answerToken: token },
      ik(),
    );
    expect(
      (await c.audit.query({ kind: "approval.answer_rejected" })).map((e) => e.data.reason),
    ).toContain("presence_cancelled");
  });

  it("approves once only and refuses UNSANDBOXED (neither is in the signed challenge)", async () => {
    let asked = 0;
    const holder: { key?: ReturnType<typeof enclaveKey> } = {};
    const { admin, key } = await setup({
      confirm: (p) => {
        asked++;
        const k = holder.key as ReturnType<typeof enclaveKey>;
        return { signature: signChallenge(k.privateKey, p.challenge), keyId: k.keyId };
      },
    });
    holder.key = key;
    const { approval, token } = await securityCard(admin);
    for (const extra of [{ scope: "always" }, { unsandboxed: "UNSANDBOXED" }]) {
      expect(
        await admin.request(
          "approvals.approveWithTouchId",
          { approvalId: approval.id, answerToken: token, ...extra },
          ik(),
        ),
      ).toMatchObject({ ok: false, error: { code: "invalid_params" } });
    }
    expect(asked).toBe(0);
    const res = await admin.call<{ approval: ApprovalRequest }>(
      "approvals.approveWithTouchId",
      { approvalId: approval.id, answerToken: token, scope: "once" },
      ik(),
    );
    expect(res.approval.scopeGranted).toBe("once");
  });

  it("asks only the helper the desktop launched (helperDeviceId)", async () => {
    let asked = 0;
    const { admin } = await setup({
      confirm: () => {
        asked++;
        return { signature: "x" };
      },
    });
    const { approval, token } = await securityCard(admin);
    expect(
      await admin.request(
        "approvals.approveWithTouchId",
        { approvalId: approval.id, answerToken: token, helperDeviceId: "dev_someone_else" },
        ik(),
      ),
    ).toMatchObject({
      ok: false,
      error: { code: "unavailable", details: { reason: "helper_offline" } },
    });
    expect(asked).toBe(0);
  });

  it("refuses a development file key unless devices.presence.allowDevFileKey is on", async () => {
    const { admin, helperDevice, key } = await setup({ kind: "enclave_file", register: false });
    expect(
      await admin.request(
        "devices.presenceKey.register",
        { deviceId: helperDevice, expectKeyId: key.keyId },
        ik(),
      ),
    ).toMatchObject({
      ok: false,
      error: { code: "forbidden", details: { reason: "dev_file_key_off" } },
    });
    await admin.call(
      "settings.set",
      { key: "devices.presence.allowDevFileKey", value: true },
      ik(),
    );
    expect(
      await admin.call(
        "devices.presenceKey.register",
        { deviceId: helperDevice, expectKeyId: key.keyId },
        ik(),
      ),
    ).toMatchObject({ presenceKey: { kind: "enclave_file" } });
  });

  it("accepts a login-keychain ACL key without the dev setting, and a release build never needs it", async () => {
    const { admin, helperDevice, key } = await setup({
      kind: "enclave_keychain_acl",
      register: false,
    });
    // devices.presence.allowDevFileKey stays off: only the plain-file key needs it.
    expect(
      await admin.call(
        "devices.presenceKey.register",
        { deviceId: helperDevice, expectKeyId: key.keyId },
        ik(),
      ),
    ).toMatchObject({ presenceKey: { kind: "enclave_keychain_acl" } });
    expect(await admin.call("devices.presenceKey.list", {})).toMatchObject({
      presenceKeys: [{ deviceId: helperDevice, kind: "enclave_keychain_acl" }],
    });
  });

  it("refuses an unknown kind outright and a missing one unless the dev setting is on", async () => {
    const unknown = await setup({ kind: "something-else", allowDevFileKey: true, register: false });
    expect(
      await unknown.admin.request(
        "devices.presenceKey.register",
        { deviceId: unknown.helperDevice, expectKeyId: unknown.key.keyId },
        ik(),
      ),
    ).toMatchObject({
      ok: false,
      error: { code: "forbidden", details: { reason: "unknown_key_kind" } },
    });
    await reset();
    const missing = await setup({ kind: "", register: false });
    expect(
      await missing.admin.request(
        "devices.presenceKey.register",
        { deviceId: missing.helperDevice, expectKeyId: missing.key.keyId },
        ik(),
      ),
    ).toMatchObject({
      ok: false,
      error: { code: "forbidden", details: { reason: "missing_key_kind" } },
    });
  });

  it("a registration that replaces a different key says REPLACE on the card and names the old key", async () => {
    const { admin, helperDevice, key } = await setup({
      confirm: () => ({ signature: "x", keyId: "x" }),
    });
    const other = enclaveKey();
    helperKeyOverride = other; // the helper now shows a different key
    const first = await admin.request(
      "devices.presenceKey.register",
      { deviceId: helperDevice, expectKeyId: other.keyId },
      ik(),
    );
    expect(first).toMatchObject({ ok: false, error: { code: "approval_required" } });
    const approvalId = (first as { error: { details: { approvalId: string } } }).error.details
      .approvalId;
    const got = await admin.call<{ approval: ApprovalRequest }>("approvals.get", { approvalId });
    expect(got.approval.summary).toContain("REPLACE");
    expect(got.approval.details).toMatchObject({ replacesKeyId: key.keyId, keyId: other.keyId });
    // The same key again is a plain registration, not a replacement.
    helperKeyOverride = undefined;
    const same = await admin.request(
      "devices.presenceKey.register",
      { deviceId: helperDevice, expectKeyId: key.keyId },
      ik(),
    );
    const sameId = (same as { error: { details: { approvalId: string } } }).error.details
      .approvalId;
    const plain = await admin.call<{ approval: ApprovalRequest }>("approvals.get", {
      approvalId: sameId,
    });
    expect(plain.approval.summary).not.toContain("REPLACE");
    expect(plain.approval.details).not.toHaveProperty("replacesKeyId");
  });

  it("Remove is audited with who asked and remembered, so a later Register still says it replaces", async () => {
    const { c, admin, helperDevice, key } = await setup();
    expect(
      await admin.call("devices.presenceKey.remove", { deviceId: helperDevice }, ik()),
    ).toEqual({
      removed: true,
    });
    const removed = (await c.audit.query({ kind: "presence_key.removed" }))[0];
    expect(removed?.data).toMatchObject({ deviceId: helperDevice, keyId: key.keyId });
    expect(removed?.actor).toMatchObject({ type: "device" });
    const record = JSON.stringify(
      getSetting(c.gateway.context.db, PRESENCE_REMOVED_SETTING)?.value,
    );
    expect(record).toContain(key.keyId);
  });

  it("with no presence card possible, replacing a forgotten key needs the owner to name it", async () => {
    const { c, admin, helperDevice, key } = await setup({ register: false });
    const forgotten = "a".repeat(64);
    setSetting(c.gateway.context.db, PRESENCE_REMOVED_SETTING, {
      [helperDevice]: { previousKeyId: forgotten, previousKind: "enclave_file", removedAt: "x" },
    });
    const params = { deviceId: helperDevice, expectKeyId: key.keyId };
    expect(await admin.request("devices.presenceKey.register", params, ik())).toMatchObject({
      ok: false,
      error: {
        code: "conflict",
        details: { reason: "replace_confirmation_required", replacesKeyId: forgotten },
      },
    });
    // The wrong id does not confirm it.
    expect(
      await admin.request(
        "devices.presenceKey.register",
        { ...params, confirmReplacesKeyId: "b".repeat(64) },
        ik(),
      ),
    ).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(
      await admin.call(
        "devices.presenceKey.register",
        { ...params, confirmReplacesKeyId: forgotten },
        ik(),
      ),
    ).toMatchObject({ presenceKey: { keyId: key.keyId } });
    const replaced = (await c.audit.query({ kind: "presence_key.replaced" }))[0];
    expect(replaced?.data).toMatchObject({ previousKeyId: forgotten, previousVia: "removed" });
    expect(replaced?.actor).toMatchObject({ type: "device" });
  });

  it("registering the very key a Remove forgot is not a replacement", async () => {
    const { c, admin, helperDevice, key } = await setup({ register: false });
    setSetting(c.gateway.context.db, PRESENCE_REMOVED_SETTING, {
      [helperDevice]: { previousKeyId: key.keyId, removedAt: "x" },
    });
    expect(
      await admin.call(
        "devices.presenceKey.register",
        { deviceId: helperDevice, expectKeyId: key.keyId },
        ik(),
      ),
    ).toMatchObject({ presenceKey: { keyId: key.keyId } });
    expect(await c.audit.query({ kind: "presence_key.replaced" })).toHaveLength(0);
  });

  it("a key the fingerprint change killed says so, so the card can send the owner to Devices", async () => {
    const { admin } = await setup({
      confirm: () => {
        throw Object.assign(new Error("Touch ID changed"), {
          code: "unavailable",
          details: { reason: "presence_key_invalidated" },
        });
      },
    });
    const { approval, token } = await securityCard(admin);
    expect(
      await admin.request(
        "approvals.approveWithTouchId",
        { approvalId: approval.id, answerToken: token },
        ik(),
      ),
    ).toMatchObject({
      ok: false,
      error: { code: "unavailable", details: { reason: "presence_key_invalidated" } },
    });
  });

  describe("with a second Mac's helper", () => {
    /** A second Mac: an approved node device that says `mac-helper` over the WebSocket. */
    async function secondMac(c: ComposedGateway, confirm: Confirm) {
      const key = enclaveKey();
      const deviceId = "second-mac";
      const deviceKey = newDeviceKey();
      pairNodeDevice(c.gateway, deviceId, deviceKey);
      const node = await FakeNode.connectWs(wsUrlOf(c.gateway), {
        origin: c.gateway.origin,
        handlers: helperHandlers(key, confirm),
        key: deviceKey,
        deviceId,
        deviceFamily: "mac-helper",
      });
      nodes.push(node);
      return { node, key, deviceId };
    }

    it("never asks it to confirm, with or without a pin, and refuses to register its key", async () => {
      const hostAsked: unknown[] = [];
      const { c, admin } = await setup({
        confirm: (p) => {
          hostAsked.push(p);
          return { signature: "x" };
        },
      });
      // It connects last, so "the newest helper" would be this one.
      const other = await secondMac(c, () => ({ signature: "y" }));
      const { approval, token } = await securityCard(admin);

      // Pinned to the second Mac: it is not the Host's helper, so there is nothing to ask.
      expect(
        await admin.request(
          "approvals.approveWithTouchId",
          { approvalId: approval.id, answerToken: token, helperDeviceId: other.deviceId },
          ik(),
        ),
      ).toMatchObject({
        ok: false,
        error: { code: "unavailable", details: { reason: "helper_offline" } },
      });
      // Not pinned: the Host's helper is asked, never the newer second Mac.
      await admin.request(
        "approvals.approveWithTouchId",
        { approvalId: approval.id, answerToken: token },
        ik(),
      );
      expect(hostAsked).toHaveLength(1);
      expect(other.node.invocations.map((i) => i.capability)).not.toContain("presence.confirm");

      // Its Touch ID key is never registered as a verifier for approvals.
      expect(
        await admin.request(
          "devices.presenceKey.register",
          { deviceId: other.deviceId, expectKeyId: other.key.keyId },
          ik(),
        ),
      ).toMatchObject({ ok: false, error: { code: "unavailable" } });
      expect(other.node.invocations.map((i) => i.capability)).not.toContain("presence.public_key");
    });

    it("never receives the approval notifications", async () => {
      const { c, admin } = await setup({ confirm: () => ({ signature: "x" }) });
      const other = await secondMac(c, () => ({ signature: "y" }));
      const issued = await c.gateway.context.broker.requestApproval({
        kind: "policy_change",
        summary: "Change a security setting",
        details: {},
        bindingHash: "c".repeat(64),
        grantKey: "c".repeat(64),
        requestedBy: { runId: null, taskId: null, threadId: null },
        sideEffect: "destructive",
        surfaces: ["desktop", "notification"],
        scopesOffered: ["once"],
        taint: false,
      });
      expect(issued.approval.id).toBeTruthy();
      const host = nodes[0] as FakeNode;
      await vi.waitFor(() =>
        expect(host.invocations.map((i) => i.capability)).toContain("notify.show"),
      );
      expect(other.node.invocations.map((i) => i.capability)).not.toContain("notify.show");
      expect(admin).toBeDefined();
    });
  });

  it("with two Host helpers and no pin it asks neither; a pin names one", async () => {
    const asked: string[] = [];
    const { c, admin, helperDevice } = await setup({
      confirm: () => {
        asked.push("first");
        return { signature: "x" };
      },
    });
    const secondKey = enclaveKey();
    const second = await FakeNode.connect(c.gateway.config.nodeSocketPath, {
      origin: c.gateway.origin,
      secret: c.gateway.handshakeSecret,
      handlers: helperHandlers(secondKey, () => {
        asked.push("second");
        return { signature: "y" };
      }),
      deviceId: "helper-two",
    });
    nodes.push(second);
    await vi.waitFor(() =>
      expect(second.invocations.map((i) => i.capability)).toContain("notify.subscribe"),
    );
    const { approval, token } = await securityCard(admin);
    const unpinned = await admin.request(
      "approvals.approveWithTouchId",
      { approvalId: approval.id, answerToken: token },
      ik(),
    );
    expect(unpinned).toMatchObject({
      ok: false,
      error: { code: "unavailable", details: { reason: "helper_offline" } },
    });
    expect(JSON.stringify(unpinned)).toContain("More than one");
    expect(asked).toEqual([]);
    // The desktop's own helper, by device id, is unambiguous.
    await admin.request(
      "approvals.approveWithTouchId",
      { approvalId: approval.id, answerToken: token, helperDeviceId: helperDevice },
      ik(),
    );
    expect(asked).toEqual(["first"]);

    // The owner pinned a Host helper (devices.hostHelperDeviceId): with no pin from the window
    // the registry's choice settles it, as for every other Host-bound call.
    setSetting(c.gateway.context.db, "devices.hostHelperDeviceId", "helper-two");
    // The pinned helper has no registered Touch ID key here, so the refusal names it: the
    // first helper (keyed, and the newest-or-oldest pick of the old code) was not chosen.
    expect(
      await admin.request(
        "approvals.approveWithTouchId",
        { approvalId: approval.id, answerToken: token },
        ik(),
      ),
    ).toMatchObject({
      ok: false,
      error: { code: "unavailable", details: { reason: "no_presence_key" } },
    });
    expect(asked).toEqual(["first"]);
  });

  it("keeps only short, word-like helper error codes and reasons", () => {
    expect(
      helperErrorFields({ code: "x".repeat(500), details: { reason: "a\nb; rm -rf" } }),
    ).toEqual({ code: "unknown" });
    expect(helperErrorFields({ code: "cancelled", details: { reason: "user_cancelled" } })).toEqual(
      {
        code: "cancelled",
        reason: "user_cancelled",
      },
    );
  });
});
