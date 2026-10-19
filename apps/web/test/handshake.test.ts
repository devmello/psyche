import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { fromBase64Url } from "../src/client/encoding.ts";
import { Handshake } from "../src/client/handshake.ts";
import { connectSigningPayload } from "../src/client/signing.ts";
import { createEphemeralDeviceKey } from "../src/lib/device-key.ts";

describe("web handshake", () => {
  it("matches the shared signing fixture", () => {
    const bytes = connectSigningPayload({
      nonce: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
      platform: "macos",
      deviceFamily: "mac-helper",
      protocolVersion: 1,
      serverOrigin: "http://127.0.0.1:7979",
    });
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      "724005f48718da546d4612ce25b78ff21172c0c3ae225f56774bd427e200c965",
    );
  });

  it("sends no handshake secret and signs the challenge with a WebCrypto Ed25519 key", async () => {
    const key = await createEphemeralDeviceKey();
    expect(fromBase64Url(key.publicKey)).toHaveLength(32);
    const hs = new Handshake(
      {
        protocolVersion: { min: 1, max: 1 },
        deviceId: key.deviceId,
        publicKey: key.publicKey,
        role: "client",
        platform: "web",
        deviceFamily: "web",
        name: "Psyche Web",
      },
      (p) => key.sign(p),
    );
    const connect = hs.start();
    expect(connect.params).not.toHaveProperty("handshakeSecret");

    const nonce = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
    const step = await hs.onFrame({
      type: "res",
      id: "connect",
      ok: true,
      payload: {
        phase: "challenge",
        nonce,
        serverOrigin: "http://127.0.0.1:7979",
        protocolVersion: 1,
        expiresAt: "",
      },
    });
    const { signature } = (step.send?.params ?? {}) as { signature: string };
    const pub = await crypto.subtle.importKey(
      "raw",
      fromBase64Url(key.publicKey),
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    const payload = connectSigningPayload({
      nonce,
      platform: "web",
      deviceFamily: "web",
      protocolVersion: 1,
      serverOrigin: "http://127.0.0.1:7979",
    });
    expect(
      await crypto.subtle.verify({ name: "Ed25519" }, pub, fromBase64Url(signature), payload),
    ).toBe(true);

    const pending = await hs.onFrame({
      type: "res",
      id: "connect.verify",
      ok: true,
      payload: { phase: "pending", pairingRequestId: "p1", code: "482913" },
    });
    expect(pending.status).toEqual({ type: "pending", code: "482913" });
  });
});
