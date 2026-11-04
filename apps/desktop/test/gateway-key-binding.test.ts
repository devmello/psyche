import { createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { connectSigningPayload, gatewaySigningPayload } from "@psyche/protocol";
import { Handshake } from "@psyche/web/client";
import { describe, expect, it } from "vitest";
import { createGatewayVerifier } from "../src/lib/gateway-identity.ts";

const NONCE = Buffer.alloc(32, 9).toString("base64url");
const REMOTE = "https://studio-mac.tail1234.ts.net";

function pair() {
  const { privateKey } = generateKeyPairSync("ed25519");
  return { privateKey, publicKey: privateKey.export({ format: "jwk" }).x as string };
}

const device = pair();
const params = {
  protocolVersion: { min: 1, max: 1 },
  deviceId: "dev_test",
  publicKey: device.publicKey,
  role: "client" as const,
  platform: "macos",
  deviceFamily: "desktop",
  name: "test",
};

function challengeFrame(gw: ReturnType<typeof pair>, serverOrigin: string) {
  return {
    type: "res" as const,
    id: "connect",
    ok: true as const,
    payload: {
      phase: "challenge",
      nonce: NONCE,
      serverOrigin,
      protocolVersion: 1,
      expiresAt: new Date().toISOString(),
      gatewayKey: gw.publicKey,
      gatewaySignature: sign(
        null,
        gatewaySigningPayload({ nonce: NONCE, serverOrigin, devicePublicKey: device.publicKey }),
        gw.privateKey,
      ).toString("base64url"),
    },
  };
}

const valid = (payload: Uint8Array, signature: string) =>
  verify(
    null,
    payload,
    createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: device.publicKey }, format: "jwk" }),
    Buffer.from(signature, "base64url"),
  );

describe("the client binds its connect to the Gateway key it verified", () => {
  it("sends the key and signs the v2 payload in strict (remote) mode", async () => {
    const gw = pair();
    const hs = new Handshake(
      params,
      (p) => sign(null, p, device.privateKey).toString("base64url"),
      createGatewayVerifier({
        dialedOrigin: REMOTE,
        mode: "strict",
        pinnedKey: () => gw.publicKey,
      }),
    );
    hs.start();
    const step = await hs.onFrame(challengeFrame(gw, REMOTE));
    const sent = step.send?.params as { signature: string; gatewayKey?: string };
    expect(sent.gatewayKey).toBe(gw.publicKey);
    const v2 = connectSigningPayload({
      nonce: NONCE,
      platform: "macos",
      deviceFamily: "desktop",
      protocolVersion: 1,
      serverOrigin: REMOTE,
      gatewayKey: gw.publicKey,
    });
    expect(valid(v2, sent.signature)).toBe(true);
    // It is not a signature over the v1 payload, which a relay could otherwise present.
    const v1 = connectSigningPayload({
      nonce: NONCE,
      platform: "macos",
      deviceFamily: "desktop",
      protocolVersion: 1,
      serverOrigin: REMOTE,
    });
    expect(valid(v1, sent.signature)).toBe(false);
  });

  it("keeps the v1 connect for This Mac, with no field", async () => {
    const gw = pair();
    const origin = "http://127.0.0.1:7979";
    const hs = new Handshake(
      params,
      (p) => sign(null, p, device.privateKey).toString("base64url"),
      createGatewayVerifier({ dialedOrigin: origin, mode: "local", pinnedKey: () => undefined }),
    );
    hs.start();
    const step = await hs.onFrame(challengeFrame(gw, origin));
    const sent = step.send?.params as { signature: string; gatewayKey?: string };
    expect(sent.gatewayKey).toBeUndefined();
    const v1 = connectSigningPayload({
      nonce: NONCE,
      platform: "macos",
      deviceFamily: "desktop",
      protocolVersion: 1,
      serverOrigin: origin,
    });
    expect(valid(v1, sent.signature)).toBe(true);
  });
});
