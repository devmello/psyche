// Materializes the fake secrets in registry.json. Values are stored as recipes
// ({"derive": {...}}) and computed here, so no secret-looking literal exists in the repository
// for scanners (GitGuardian, secret-grep) to flag, and a leak in a log is still an exact,
// greppable value. packages/testing/src/secret-registry.ts implements the same function and a
// test keeps the two identical.

import { createHash } from "node:crypto";

const ALPHABETS = {
  hex: "0123456789abcdef",
  base32: "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567",
  base62: "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz",
};

/** `{prefix, alphabet, length}` + a stable seed → `prefix` followed by `length` characters. */
export function deriveValue(seed, recipe) {
  const alphabet = ALPHABETS[recipe.alphabet ?? "base62"];
  if (alphabet === undefined) throw new Error(`unknown alphabet ${recipe.alphabet}`);
  let out = "";
  for (let block = 0; out.length < recipe.length; block += 1) {
    const bytes = createHash("sha256").update(`psyche.fixture.v1|${seed}|${block}`).digest();
    for (const b of bytes) {
      if (out.length >= recipe.length) break;
      out += alphabet[b % alphabet.length];
    }
  }
  return `${recipe.prefix ?? ""}${out}${recipe.suffix ?? ""}`;
}

/** A literal string or a `{derive}` recipe, seeded by `<id>.<field>` or `<id>`. */
export function materialize(value, seed) {
  if (typeof value === "string") return value;
  if (value !== null && typeof value === "object" && "derive" in value) {
    return deriveValue(seed, value.derive);
  }
  throw new Error(`fixture secret ${seed}: expected a string or {derive}`);
}

/** The registry with every vault field and standalone value materialized. */
export function resolveRegistry(registry) {
  return {
    ...registry,
    vaultItems: registry.vaultItems.map((item) => ({
      ...item,
      fields: Object.fromEntries(
        Object.entries(item.fields).map(([f, v]) => [f, materialize(v, `${item.id}.${f}`)]),
      ),
    })),
    standalone: registry.standalone.map((s) => ({ ...s, value: materialize(s.value, s.id) })),
  };
}
