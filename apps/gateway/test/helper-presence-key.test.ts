import { createHash, generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { revokeDevice } from "@psyche/db";
import type { ApprovalRequest } from "@psyche/protocol";
import { FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { composeHelper, helperPresenceMessage } from "../src/compose/helper.ts";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import { silentLogger } from "../src/log.ts";
import { FakeNode, type FakeNodeHandler } from "./fake-node.ts";
import { adminClient, ik, type TestClient } from "./helpers.ts";

/**
 * Issue #253: the owner registers the Mac helper's Secure Enclave presence key, and Touch ID
 * answers from that helper then verify. A wrong signature is refused; revoking the helper
 * revokes its key.
 */

const clients: TestClient[] = [];
const nodes: FakeNode[] = [];
let composed: ComposedGateway | null = null;
let home = "";

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  for (const n of nodes.splice(0)) await n.close();
  await composed?.stop("test");
  composed = null;
  if (home) rmSync(home, { recursive: true, force: true });
  home = "";
});

/** A stand-in for the helper's Secure Enclave key: P-256, X9.63 public point, DER signatures. */
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

/** A helper with `presence.public_key` and the notification capabilities. */
function helperHandlers(key: ReturnType<typeof enclaveKey>) {
  const shown: { id: string; presenceChallenge?: string }[] = [];
  let respond: ((data: unknown) => void) | undefined;
  const handlers: FakeNodeHandler[] = [
    {
      capability: { name: "presence.public_key", sideEffect: "read", streaming: false },
      run: () => ({ publicKey: key.publicKey, keyId: key.keyId }),
    },
    {
      capability: { name: "notify.show", sideEffect: "write", streaming: false },
      run: (params) => {
        shown.push(params as { id: string; presenceChallenge?: string });
        return { shown: true };
      },
    },
    {
      capability: { name: "notify.withdraw", sideEffect: "write", streaming: false },
      run: () => ({ withdrawn: true }),
    },
    {
      capability: { name: "notify.subscribe", sideEffect: "read", streaming: true },
      run: (_params, emit) => {
        respond = emit;
        return new Promise(() => undefined);
      },
    },
  ];
  return { handlers, shown, respond: (data: unknown) => respond?.(data) };
}

async function setup() {
  home = mkdtempSync(join(tmpdir(), "psyche-helper-key-"));
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
  const h = helperHandlers(key);
  const helperDevice = `helper-${Math.random().toString(36).slice(2)}`;
  const node = await FakeNode.connect(composed.gateway.config.nodeSocketPath, {
    origin: composed.gateway.origin,
    secret: composed.gateway.handshakeSecret,
    handlers: h.handlers,
    deviceId: helperDevice,
  });
  nodes.push(node);
  await vi.waitFor(() =>
    expect(node.invocations.map((i) => i.capability)).toContain("notify.subscribe"),
  );
  return { c: composed, admin, key, h, helperDevice };
}

describe("helper presence keys (issue #253)", () => {
  it("registers the helper's key; a signed Touch ID answer approves, a wrong one does not", async () => {
    const { c, admin, key, h, helperDevice } = await setup();
    expect(await admin.call("devices.presenceKey.list", {})).toEqual({ presenceKeys: [] });
    expect(
      await admin.request(
        "devices.presenceKey.register",
        { deviceId: helperDevice, expectKeyId: "0".repeat(64) },
        ik(),
      ),
    ).toMatchObject({ ok: false, error: { code: "conflict" } });

    // The first verifier on a Gateway with none: registered with operator.admin alone.
    const reg = await admin.call<{ presenceKey: { keyId: string } }>(
      "devices.presenceKey.register",
      { deviceId: helperDevice, expectKeyId: key.keyId },
      ik(),
    );
    expect(reg.presenceKey.keyId).toBe(key.keyId);
    expect((await c.audit.query({ kind: "presence_key.registered" }))[0]?.data).toMatchObject({
      deviceId: helperDevice,
      keyId: key.keyId,
    });

    // A security setting now needs presence; the card reaches the helper with a challenge.
    const first = await admin.request(
      "settings.set",
      { key: "permissions.policy", value: { allow: [] } },
      ik(),
    );
    expect(first).toMatchObject({ ok: false, error: { code: "approval_required" } });
    const approvalId = (first as { error: { details: { approvalId: string } } }).error.details
      .approvalId;
    await vi.waitFor(() => expect(h.shown.map((s) => s.id)).toContain(approvalId));
    const challenge = h.shown.find((s) => s.id === approvalId)?.presenceChallenge as string;
    expect(challenge).toEqual(expect.any(String));
    await new Promise((r) => setTimeout(r, 450)); // past the arm delay

    const status = async () =>
      (await admin.call<{ approval: ApprovalRequest }>("approvals.get", { approvalId })).approval
        .status;
    const other = enclaveKey();
    h.respond({
      type: "notify.response",
      notificationId: approvalId,
      actionId: "approve",
      authenticated: true,
      presence: { signature: signChallenge(other.privateKey, challenge), keyId: other.keyId },
    });
    await new Promise((r) => setTimeout(r, 200));
    expect(await status()).toBe("pending");

    h.respond({
      type: "notify.response",
      notificationId: approvalId,
      actionId: "approve",
      authenticated: true,
      presence: { signature: signChallenge(key.privateKey, challenge), keyId: key.keyId },
    });
    await vi.waitFor(async () => expect(await status()).toBe("approved"));
    expect(
      await admin.request(
        "settings.set",
        { key: "permissions.policy", value: { allow: [] }, approvalId },
        ik(),
      ),
    ).toMatchObject({ ok: true });
  });

  it("a second key needs fresh presence; revoking the helper revokes its key", async () => {
    const { c, admin, key, helperDevice } = await setup();
    await admin.call("devices.presenceKey.register", { deviceId: helperDevice }, ik());
    // Presence is now enrolled: replacing the key asks for a card.
    expect(
      await admin.request("devices.presenceKey.register", { deviceId: helperDevice }, ik()),
    ).toMatchObject({ ok: false, error: { code: "approval_required" } });

    revokeDevice(c.gateway.context.db, helperDevice);
    expect(await admin.call("devices.presenceKey.list", {})).toEqual({ presenceKeys: [] });
    // With the only verifier gone, security changes fail closed.
    expect(
      await admin.request(
        "settings.set",
        { key: "permissions.policy", value: { allow: [] } },
        ik(),
      ),
    ).toMatchObject({ ok: false, error: { code: "presence_required" } });
    expect(key.keyId).toMatch(/^[0-9a-f]{64}$/);
  });

  it("an unknown or disconnected device cannot register", async () => {
    const { admin } = await setup();
    expect(
      await admin.request("devices.presenceKey.register", { deviceId: "no-such-helper" }, ik()),
    ).toMatchObject({ ok: false, error: { code: "unavailable" } });
  });
});
