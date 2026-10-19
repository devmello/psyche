import { createPublicKey, verify } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  deviceIdFromPublicKey,
  loadOrCreateDeviceKey,
  platformFromNode,
  signWithDeviceKey,
} from "../src/lib/device-key.ts";
import { type ConnectParams, Handshake } from "../src/lib/handshake.ts";
import { connectSigningPayload } from "../src/lib/signing.ts";

const dir = mkdtempSync(join(tmpdir(), "psyche-desktop-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("device key", () => {
  it("persists a 0600 Ed25519 key and reloads the same identity", () => {
    const path = join(dir, "nested", "device-key.json");
    const a = loadOrCreateDeviceKey(path);
    const b = loadOrCreateDeviceKey(path);
    expect(b.deviceId).toBe(a.deviceId);
    expect(b.publicKey).toBe(a.publicKey);
    expect(Buffer.from(a.publicKey, "base64url")).toHaveLength(32);
    expect(a.deviceId).toBe(deviceIdFromPublicKey(a.publicKey));
    expect(a.deviceId).toMatch(/^dev_[A-Za-z0-9_-]{22}$/);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, "utf8")).v).toBe(1);
  });

  it("maps node platforms to DevicePlatform", () => {
    expect(platformFromNode("darwin")).toBe("macos");
    expect(platformFromNode("linux")).toBe("linux");
  });
});

describe("Handshake", () => {
  const key = loadOrCreateDeviceKey(join(dir, "hs-key.json"));
  const params: ConnectParams = {
    protocolVersion: { min: 1, max: 1 },
    deviceId: key.deviceId,
    publicKey: key.publicKey,
    role: "client",
    platform: "macos",
    deviceFamily: "desktop",
    name: "test",
    handshakeSecret: "s3cret",
  };

  it("sends connect, signs the challenge per the wire spec, and reports paired", async () => {
    const hs = new Handshake(params, (p) => signWithDeviceKey(key, p));
    expect(hs.start()).toEqual({ type: "req", id: "connect", method: "connect", params });

    const nonce = Buffer.alloc(32, 7).toString("base64url");
    const step = await hs.onFrame({
      type: "res",
      id: "connect",
      ok: true,
      payload: {
        phase: "challenge",
        nonce,
        serverOrigin: "http://127.0.0.1:7979",
        protocolVersion: 1,
        expiresAt: new Date().toISOString(),
      },
    });
    expect(step.status).toEqual({ type: "challenge", protocolVersion: 1 });
    expect(step.send?.method).toBe("connect.verify");
    const sent = step.send?.params as { nonce: string; signature: string };
    expect(sent.nonce).toBe(nonce);

    const pub = createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: key.publicKey },
      format: "jwk",
    });
    const payload = connectSigningPayload({
      nonce,
      platform: "macos",
      deviceFamily: "desktop",
      protocolVersion: 1,
      serverOrigin: "http://127.0.0.1:7979",
    });
    expect(verify(null, payload, pub, Buffer.from(sent.signature, "base64url"))).toBe(true);

    const done = await hs.onFrame({
      type: "res",
      id: "connect.verify",
      ok: true,
      payload: {
        phase: "paired",
        deviceId: key.deviceId,
        scopes: ["operator.read"],
        stateVersion: 0,
        serverTime: "",
      },
    });
    expect(done).toEqual({ status: { type: "paired", scopes: ["operator.read"] }, done: true });
  });

  it("reports pending with the pairing code and surfaces error codes", async () => {
    const hs = new Handshake(params, () => "sig");
    expect(
      await hs.onFrame({
        type: "res",
        id: "connect.verify",
        ok: true,
        payload: { phase: "pending", code: "123456" },
      }),
    ).toMatchObject({ status: { type: "pending", code: "123456" }, done: true });
    expect(
      await hs.onFrame({
        type: "res",
        id: "connect",
        ok: false,
        error: { code: "protocol_version_mismatch", message: "x" },
      }),
    ).toMatchObject({ status: { type: "error", code: "protocol_version_mismatch" }, done: true });
  });
});
