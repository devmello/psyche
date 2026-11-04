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

  describe("a pairing link's setup token (remote-gateway design §3.4)", () => {
    const nonce = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
    const gatewayKey = "ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8";
    const token = "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWY";
    const challenge = {
      type: "res" as const,
      id: "connect",
      ok: true as const,
      payload: {
        phase: "challenge",
        nonce,
        serverOrigin: "https://studio-mac.tail1234.ts.net",
        protocolVersion: 1,
        expiresAt: "",
        gatewayKey,
      },
    };
    async function handshake(verify?: (...a: never[]) => unknown) {
      const key = await createEphemeralDeviceKey();
      return new Handshake(
        {
          protocolVersion: { min: 1, max: 1 },
          deviceId: key.deviceId,
          publicKey: key.publicKey,
          role: "client",
          platform: "macos",
          deviceFamily: "desktop",
          name: "Psyche Desktop",
          setupToken: token,
        },
        (p) => key.sign(p),
        verify as never,
      );
    }

    it("is never in the first frame, which goes out before the Gateway has proved its key", async () => {
      const hs = await handshake(async () => ({ ok: true, gatewayKey, fingerprint: "sha256:x" }));
      expect(hs.start().params).not.toHaveProperty("setupToken");
    });

    it("goes in connect.verify, with the verified key, once the Gateway's key checked out", async () => {
      const hs = await handshake(async () => ({ ok: true, gatewayKey, fingerprint: "sha256:x" }));
      hs.start();
      const step = await hs.onFrame(challenge);
      expect(step.send?.method).toBe("connect.verify");
      expect(step.send?.params).toMatchObject({ gatewayKey, setupToken: token });
    });

    it("is never sent when the Gateway failed the check, or when nothing checked it", async () => {
      const refused = await handshake(async () => ({ ok: false, code: "gateway_key_mismatch" }));
      refused.start();
      const step = await refused.onFrame(challenge);
      expect(step.send).toBeUndefined();
      const unchecked = await handshake();
      unchecked.start();
      const sent = await unchecked.onFrame(challenge);
      expect(sent.send?.params).not.toHaveProperty("setupToken");
    });
  });
});
