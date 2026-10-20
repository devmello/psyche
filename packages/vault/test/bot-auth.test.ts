import { createPublicKey, verify } from "node:crypto";
import { clearSecrets } from "@psyche/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BOT_AUTH_SLUG } from "../src/vault.ts";
import { type Harness, makeHarness } from "./helpers.ts";

/** Web Bot Auth (I14): the vault keeps the Ed25519 key and signs; nobody else sees it. */
let h: Harness;
beforeEach(async () => {
  h = makeHarness();
  await h.vault.setup();
});
afterEach(() => {
  h.cleanup();
  clearSecrets();
});

describe("Web Bot Auth key in the vault (I14)", () => {
  it("has none until rotated, signs verifiably, and a rotation retires the old key", async () => {
    expect(await h.vault.botAuthKey()).toBeUndefined();
    const first = await h.vault.rotateBotAuthKey();
    expect(first.keyId).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.publicJwk).toMatchObject({ kty: "OKP", crv: "Ed25519" });
    const data = new TextEncoder().encode('"@authority": shop.example');
    const sig = await first.sign(data);
    expect(
      verify(null, data, createPublicKey({ key: { ...first.publicJwk }, format: "jwk" }), sig),
    ).toBe(true);
    // One item, never with its private half in metadata.
    const items = (await h.vault.list()).filter((m) => m.kind === "signing_key");
    expect(items).toHaveLength(1);
    expect(items[0]?.slug).toBe(BOT_AUTH_SLUG);
    expect(JSON.stringify(items)).not.toContain("PRIVATE KEY");

    const second = await h.vault.rotateBotAuthKey();
    expect(second.keyId).not.toBe(first.keyId);
    expect((await h.vault.botAuthKey())?.keyId).toBe(second.keyId);
    expect((await h.vault.list()).filter((m) => m.kind === "signing_key")).toHaveLength(1);
    await expect(first.sign(data)).rejects.toMatchObject({ code: "conflict" });
    expect(await second.sign(data)).toBeInstanceOf(Uint8Array);
  });

  it("is unavailable while the vault is locked, and back after unlock", async () => {
    const key = await h.vault.rotateBotAuthKey();
    h.vault.lock("manual");
    expect(await h.vault.botAuthKey()).toBeUndefined();
    await expect(key.sign(new Uint8Array([1]))).rejects.toMatchObject({ code: "conflict" });
    await expect(h.vault.rotateBotAuthKey()).rejects.toMatchObject({ code: "unavailable" });
  });
});
