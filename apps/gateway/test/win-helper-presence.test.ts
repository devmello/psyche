import { constants, createHash, generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApprovalRequest } from "@psyche/protocol";
import { FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  composeHelper,
  helperPresenceMessage,
  helperPresenceVerifier,
} from "../src/compose/helper.ts";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import { parsePresenceKey } from "../src/compose/presence-keys.ts";
import { silentLogger } from "../src/log.ts";
import { FakeNode, type FakeNodeHandler } from "./fake-node.ts";
import { adminClient, ik, type TestClient } from "./helpers.ts";

/**
 * The Windows helper's presence key (apps/win-helper): a Windows Hello `KeyCredential`, RSA-2048,
 * reported by `presence.public_key` as base64url SPKI DER with `algorithm: rsa-2048-pkcs1-sha256`
 * and `kind: windows_hello`; it signs `psyche.presence.helper.v1|<challenge>` with RSASSA-PKCS1-v1_5
 * SHA-256. The Mac's P-256 keys keep working beside it.
 */

function helloKey(bits = 2048) {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: bits });
  const der = publicKey.export({ format: "der", type: "spki" });
  return {
    publicKey: der.toString("base64url"),
    keyId: createHash("sha256").update(der).digest("hex"),
    privateKey,
  };
}

function enclaveKey() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
  const raw = Buffer.concat([
    Buffer.from([0x04]),
    Buffer.from(jwk.x, "base64url"),
    Buffer.from(jwk.y, "base64url"),
  ]);
  return { publicKey: raw.toString("base64url"), privateKey };
}

const rsaSign = (key: KeyObject, challenge: string) =>
  sign("sha256", helperPresenceMessage(challenge), {
    key,
    padding: constants.RSA_PKCS1_PADDING,
  }).toString("base64url");

describe("parsePresenceKey", () => {
  it("reads both formats and refuses everything else", () => {
    const rsa = helloKey();
    expect(parsePresenceKey(rsa.publicKey)?.algorithm).toBe("rsa-2048-pkcs1-sha256");
    expect(parsePresenceKey(rsa.publicKey, "rsa-2048-pkcs1-sha256")?.algorithm).toBe(
      "rsa-2048-pkcs1-sha256",
    );
    expect(parsePresenceKey(enclaveKey().publicKey)?.algorithm).toBe("p256-ecdsa-sha256");
    expect(parsePresenceKey(helloKey(4096).publicKey)?.algorithm).toBe("rsa-2048-pkcs1-sha256");
    // An RSA key under 2048 bits, a declared algorithm that is not the key's, an EC key as SPKI,
    // trailing bytes after the DER, and junk.
    expect(parsePresenceKey(helloKey(1024).publicKey)).toBeNull();
    expect(parsePresenceKey(rsa.publicKey, "p256-ecdsa-sha256")).toBeNull();
    expect(parsePresenceKey(enclaveKey().publicKey, "rsa-2048-pkcs1-sha256")).toBeNull();
    expect(parsePresenceKey(rsa.publicKey, "rsa-1024")).toBeNull();
    const ecSpki = generateKeyPairSync("ec", { namedCurve: "P-256" })
      .publicKey.export({ format: "der", type: "spki" })
      .toString("base64url");
    expect(parsePresenceKey(ecSpki)).toBeNull();
    const padded = Buffer.concat([Buffer.from(rsa.publicKey, "base64url"), Buffer.from([0])]);
    expect(parsePresenceKey(padded.toString("base64url"))).toBeNull();
    expect(parsePresenceKey("not a key!")).toBeNull();
  });

  it("verifies PKCS#1 v1.5 signatures by the registered RSA key only", async () => {
    const rsa = helloKey();
    const other = helloKey();
    const verifier = helperPresenceVerifier(
      () => rsa.publicKey,
      () => true,
    );
    const ok = (signature: string) =>
      verifier.verify({ kind: "helper", deviceId: "d", signature }, "challenge-1", "d");
    expect(await ok(rsaSign(rsa.privateKey, "challenge-1"))).toBe(true);
    expect(await ok(rsaSign(rsa.privateKey, "challenge-2"))).toBe(false);
    expect(await ok(rsaSign(other.privateKey, "challenge-1"))).toBe(false);
    // PSS padding is not the scheme Windows Hello uses: refused.
    const pss = sign("sha256", helperPresenceMessage("challenge-1"), {
      key: rsa.privateKey,
      padding: constants.RSA_PKCS1_PSS_PADDING,
    }).toString("base64url");
    expect(await ok(pss)).toBe(false);
  });
});

describe("registering a win-helper's Windows Hello key", () => {
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
  });

  async function setup(report: (key: ReturnType<typeof helloKey>) => Record<string, unknown>) {
    home = mkdtempSync(join(tmpdir(), "psyche-hello-key-"));
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
    const key = helloKey();
    let respond: ((data: unknown) => void) | undefined;
    const shown: { id: string; presenceChallenge?: string }[] = [];
    const handlers: FakeNodeHandler[] = [
      {
        capability: { name: "presence.public_key", sideEffect: "read", streaming: false },
        run: () => report(key),
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
    const deviceId = `winhelper-${Math.random().toString(36).slice(2)}`;
    const node = await FakeNode.connect(composed.gateway.config.nodeSocketPath, {
      origin: composed.gateway.origin,
      secret: composed.gateway.handshakeSecret,
      handlers,
      deviceId,
      deviceFamily: "win-helper",
    });
    nodes.push(node);
    await vi.waitFor(() =>
      expect(node.invocations.map((i) => i.capability)).toContain("notify.subscribe"),
    );
    return { c: composed, admin, key, deviceId, shown, respond: (d: unknown) => respond?.(d) };
  }

  it("registers it with its algorithm and kind, and a Hello-signed toast answer approves", async () => {
    const { c, admin, key, deviceId, shown, respond } = await setup((k) => ({
      publicKey: k.publicKey,
      keyId: k.keyId,
      kind: "windows_hello",
      algorithm: "rsa-2048-pkcs1-sha256",
    }));
    expect(c.gateway.context.nodes.list().find((n) => n.deviceId === deviceId)?.kind).toBe(
      "win-helper",
    );
    const reg = await admin.call<{ presenceKey: Record<string, unknown> }>(
      "devices.presenceKey.register",
      { deviceId, expectKeyId: key.keyId },
      ik(),
    );
    expect(reg.presenceKey).toMatchObject({
      deviceId,
      keyId: key.keyId,
      kind: "windows_hello",
      algorithm: "rsa-2048-pkcs1-sha256",
    });
    const listed = await admin.call<{ presenceKeys: unknown[] }>("devices.presenceKey.list", {});
    expect(listed.presenceKeys).toEqual([reg.presenceKey]);

    const issued = await c.broker.requestApproval({
      kind: "purchase",
      summary: "Buy a desk",
      details: { item: "desk" },
      bindingHash: `sha256:${"a".repeat(64)}`,
      grantKey: "win|desk",
      requestedBy: { runId: null, taskId: null, threadId: null },
      sideEffect: "financial",
      surfaces: ["desktop"],
      taint: false,
    });
    await vi.waitFor(() => expect(shown.map((s) => s.id)).toContain(issued.approval.id));
    const card = shown.find((s) => s.id === issued.approval.id);
    await new Promise((r) => setTimeout(r, 450)); // the card arms
    respond({
      type: "notify.response",
      notificationId: issued.approval.id,
      actionId: "approve",
      authenticated: true,
      presence: { signature: rsaSign(key.privateKey, card?.presenceChallenge ?? "") },
    });
    await vi.waitFor(async () =>
      expect(((await c.broker.get(issued.approval.id)) as ApprovalRequest).status).toBe("approved"),
    );
  });

  it("refuses a key under 2048 bits and an algorithm that does not match the key", async () => {
    const small = helloKey(1024);
    const s1 = await setup(() => ({
      publicKey: small.publicKey,
      keyId: small.keyId,
      algorithm: "rsa-2048-pkcs1-sha256",
    }));
    await expect(
      s1.admin.call(
        "devices.presenceKey.register",
        { deviceId: s1.deviceId, expectKeyId: small.keyId },
        ik(),
      ),
    ).rejects.toThrow(/no usable presence key/);
  });

  it("refuses an RSA key declared as P-256", async () => {
    const s = await setup((k) => ({
      publicKey: k.publicKey,
      keyId: k.keyId,
      algorithm: "p256-ecdsa-sha256",
    }));
    await expect(
      s.admin.call(
        "devices.presenceKey.register",
        { deviceId: s.deviceId, expectKeyId: s.key.keyId },
        ik(),
      ),
    ).rejects.toThrow(/no usable presence key/);
  });
});
