import { createHash, createPublicKey } from "node:crypto";
import { describe, expect, it } from "vitest";
import { TRUSTED_RELEASE_KEYS } from "../../src/main/release-keys.ts";

describe("trusted release keys", () => {
  it("has at least one key, so the updater can verify a signed manifest", () => {
    expect(TRUSTED_RELEASE_KEYS.length).toBeGreaterThan(0);
  });

  it.each(TRUSTED_RELEASE_KEYS.map((k) => [k.keyId, k] as const))(
    "%s is a raw Ed25519 public key whose id matches it",
    (_id, key) => {
      const raw = Buffer.from(key.publicKey, "base64");
      expect(raw).toHaveLength(32);
      expect(createHash("sha256").update(raw).digest("hex").slice(0, 16)).toBe(key.keyId);
      expect(
        createPublicKey({
          key: { kty: "OKP", crv: "Ed25519", x: raw.toString("base64url") },
          format: "jwk",
        }).asymmetricKeyType,
      ).toBe("ed25519");
    },
  );

  it("never holds a private key", () => {
    expect(JSON.stringify(TRUSTED_RELEASE_KEYS)).not.toMatch(/PRIVATE|BEGIN/);
  });
});
