import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  deriveValue,
  fixtureSecret,
  fixtureSecrets,
  fixtureVaultItem,
  loadSecretRegistry,
  SECRET_REGISTRY_PATH,
} from "../src/index.ts";

describe("secret fixture registry", () => {
  it("materializes recipes exactly like tests/fixtures/secrets/derive.mjs", async () => {
    const mod = (await import(
      new URL("../../../tests/fixtures/secrets/derive.mjs", import.meta.url).href
    )) as { resolveRegistry: (r: unknown) => ReturnType<typeof loadSecretRegistry> };
    const viaMjs = mod.resolveRegistry(JSON.parse(readFileSync(SECRET_REGISTRY_PATH, "utf8")));
    const viaTs = loadSecretRegistry();
    expect(viaTs.vaultItems).toEqual(viaMjs.vaultItems);
    expect(viaTs.standalone).toEqual(viaMjs.standalone);
  });

  it("derivation is deterministic and honours the recipe", () => {
    const r = { prefix: "fx-", alphabet: "base32" as const, length: 40 };
    const a = deriveValue("item.field", r);
    expect(a).toBe(deriveValue("item.field", r));
    expect(a).toMatch(/^fx-[A-Z2-7]{40}$/);
    expect(deriveValue("other.field", r)).not.toBe(a);
  });

  it("stores no secret literal in the committed file", () => {
    const text = readFileSync(SECRET_REGISTRY_PATH, "utf8");
    for (const s of fixtureSecrets()) {
      if (s.field === "username" || s.id === "link-virtual-card") continue;
      expect(text, s.label).not.toContain(s.value);
    }
  });

  it("looks up values and items", () => {
    expect(fixtureSecret("github-login", "password")).toMatch(/^fx-pw-gh-/);
    expect(fixtureSecret("approval-answer-token")).toMatch(/^at_psyfx_[0-9a-f]{32}$/);
    expect(fixtureVaultItem("bank-login").boundOrigins).toEqual([
      "https://secure.examplebank.example",
    ]);
    expect(() => fixtureSecret("nope")).toThrow(/no fixture secret nope/);
  });
});
