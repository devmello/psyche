import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SecretSet } from "./secrets.ts";

/**
 * The shared fake-secret registry, `tests/fixtures/secrets/registry.json` (see its README).
 * Tests take secret values from here, never inline, so the leak checker knows every value a test
 * could leak. Labels name the source without the value: `cred:<item>.<field>` for vault fields
 * (a hit is a placeholder-resolution leak, security §4.5) and `<kind>:<id>` for the rest.
 */

export const SECRET_REGISTRY_PATH = fileURLToPath(
  new URL("../../../tests/fixtures/secrets/registry.json", import.meta.url),
);

/**
 * A secret stored as a recipe: `prefix` + `length` characters of `alphabet` drawn from
 * SHA-256 over the item id and field, so the repository holds no secret-looking literal.
 * Mirrors `tests/fixtures/secrets/derive.mjs`; `test/secret-registry.test.ts` keeps them equal.
 */
export interface DeriveRecipe {
  derive: {
    prefix?: string;
    suffix?: string;
    alphabet?: "hex" | "base32" | "base62";
    length: number;
  };
}

const ALPHABETS = {
  hex: "0123456789abcdef",
  base32: "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567",
  base62: "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz",
} as const;

export function deriveValue(seed: string, recipe: DeriveRecipe["derive"]): string {
  const alphabet = ALPHABETS[recipe.alphabet ?? "base62"];
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

function materialize(value: string | DeriveRecipe, seed: string): string {
  return typeof value === "string" ? value : deriveValue(seed, value.derive);
}

/** A sample string, or one split into parts so the repository's secret-grep gate stays quiet. */
export type Sample = string | { concat: string[] };

export interface FixtureVaultItem {
  id: string;
  kind: string;
  name: string;
  boundOrigins?: string[];
  boundHosts?: string[];
  header?: string;
  connector?: string;
  scopes?: string[];
  flags?: string[];
  fields: Record<string, string>;
}

export interface FixtureStandaloneSecret {
  id: string;
  kind: string;
  label: string;
  value: string;
  display?: Record<string, string>;
  notes?: string;
}

interface RawRegistry {
  version: 1;
  vaultItems: (Omit<FixtureVaultItem, "fields"> & {
    fields: Record<string, string | DeriveRecipe>;
  })[];
  standalone: (Omit<FixtureStandaloneSecret, "value"> & { value: string | DeriveRecipe })[];
  patternSamples: SecretRegistry["patternSamples"];
}

/** The registry with every recipe materialized. */
export interface SecretRegistry {
  version: 1;
  vaultItems: FixtureVaultItem[];
  standalone: FixtureStandaloneSecret[];
  patternSamples: Record<
    string,
    { mustMatch?: Sample[]; mustNotMatch?: Sample[]; samples?: Sample[] }
  >;
}

export interface FixtureSecret {
  label: string;
  value: string;
  source: "vault" | "standalone";
  id: string;
  field?: string;
}

let cached: SecretRegistry | undefined;

export function loadSecretRegistry(path = SECRET_REGISTRY_PATH): SecretRegistry {
  if (path === SECRET_REGISTRY_PATH && cached !== undefined) return cached;
  const raw = JSON.parse(readFileSync(path, "utf8")) as RawRegistry;
  if (raw.version !== 1) throw new Error(`unsupported secret registry version in ${path}`);
  const registry: SecretRegistry = {
    version: 1,
    vaultItems: raw.vaultItems.map((item) => ({
      ...item,
      fields: Object.fromEntries(
        Object.entries(item.fields).map(([f, v]) => [f, materialize(v, `${item.id}.${f}`)]),
      ),
    })),
    standalone: raw.standalone.map((s) => ({ ...s, value: materialize(s.value, s.id) })),
    patternSamples: raw.patternSamples,
  };
  if (path === SECRET_REGISTRY_PATH) cached = registry;
  return registry;
}

export function resolveSample(sample: Sample): string {
  return typeof sample === "string" ? sample : sample.concat.join("");
}

/** Every secret value in the registry with its label. */
export function fixtureSecrets(registry = loadSecretRegistry()): FixtureSecret[] {
  const out: FixtureSecret[] = [];
  for (const item of registry.vaultItems) {
    for (const [field, value] of Object.entries(item.fields)) {
      out.push({ label: `cred:${item.id}.${field}`, value, source: "vault", id: item.id, field });
    }
  }
  for (const s of registry.standalone) {
    out.push({ label: `${s.kind}:${s.id}`, value: s.value, source: "standalone", id: s.id });
  }
  return out;
}

/** The value of a vault field (`fixtureSecret("github-login", "password")`) or standalone secret. */
export function fixtureSecret(id: string, field?: string, registry = loadSecretRegistry()): string {
  const hit = fixtureSecrets(registry).find(
    (s) => s.id === id && (field === undefined ? s.source === "standalone" : s.field === field),
  );
  if (hit === undefined) {
    throw new Error(`no fixture secret ${id}${field === undefined ? "" : `.${field}`}`);
  }
  return hit.value;
}

export function fixtureVaultItem(id: string, registry = loadSecretRegistry()): FixtureVaultItem {
  const item = registry.vaultItems.find((i) => i.id === id);
  if (item === undefined) throw new Error(`no fixture vault item ${id}`);
  return structuredClone(item);
}

/** A `SecretSet` holding every registry value. */
export function fixtureSecretSet(registry = loadSecretRegistry()): SecretSet {
  const set = new SecretSet();
  for (const s of fixtureSecrets(registry)) set.add(s.value, s.label);
  return set;
}
