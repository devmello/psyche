import { createPublicKey, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { FakeCredentialBroker } from "../src/fakes/FakeCredentialBroker.ts";

describe("FakeCredentialBroker Web Bot Auth key (I14)", () => {
  it("has no key until rotated, signs verifiably, and a rotated-away key stops signing", async () => {
    const creds = new FakeCredentialBroker();
    expect(await creds.botAuthKey()).toBeUndefined();
    const first = await creds.rotateBotAuthKey();
    expect(first.keyId).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.publicJwk).toMatchObject({ kty: "OKP", crv: "Ed25519" });
    const data = new TextEncoder().encode("signature base");
    const sig = await first.sign(data);
    const pub = createPublicKey({ key: { ...first.publicJwk }, format: "jwk" });
    expect(verify(null, data, pub, sig)).toBe(true);
    const second = await creds.rotateBotAuthKey();
    expect(second.keyId).not.toBe(first.keyId);
    expect((await creds.botAuthKey())?.keyId).toBe(second.keyId);
    await expect(first.sign(data)).rejects.toMatchObject({ code: "conflict" });
    expect(creds.botAuthSignatures).toBe(1);
  });
});
