import { execFileSync, spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { TRUSTED_RELEASE_KEYS } from "../../src/main/release-keys.ts";
import { keyIdOf } from "../../src/main/update-manifest.ts";

/** CI must fail when the signing secret is not a key the app trusts (release.yml, verify-trusted). */

const SCRIPT = resolve(import.meta.dirname, "../../../../deploy/scripts/update-manifest.mjs");
const KEYS_TS = resolve(import.meta.dirname, "../../src/main/release-keys.ts");
const dirs: string[] = [];
const { signManifest, trustedKeysFromSource, verifyTrusted } = (await import(
  pathToFileURL(SCRIPT).href
)) as {
  signManifest: (bytes: Buffer, pem: string) => string;
  trustedKeysFromSource: (ts: string) => { keyId: string; publicKey: string }[];
  verifyTrusted: (
    bytes: Buffer,
    sig: string,
    ts: string,
  ) => { ok: boolean; keyId?: string; why?: string };
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fresh() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const raw = Buffer.from(String(publicKey.export({ format: "jwk" }).x), "base64url");
  return {
    pem: String(privateKey.export({ format: "pem", type: "pkcs8" })),
    entry: { keyId: keyIdOf(raw), publicKey: raw.toString("base64") },
  };
}
const source = (...e: { keyId: string; publicKey: string }[]) =>
  `export const TRUSTED_RELEASE_KEYS = [\n${e
    .map((k) => `  { keyId: "${k.keyId}", publicKey: "${k.publicKey}" },`)
    .join("\n")}\n];\n`;
const bytes = Buffer.from('{"release":"1.2.3"}\n');

describe("trustedKeysFromSource", () => {
  it("reads exactly the keys the app ships", () => {
    expect(trustedKeysFromSource(readFileSync(KEYS_TS, "utf8"))).toEqual(
      TRUSTED_RELEASE_KEYS.map((k) => ({ keyId: k.keyId, publicKey: k.publicKey })),
    );
  });
  it("ignores keys in comments", () => {
    const k = fresh().entry;
    const ts = `// { keyId: "${k.keyId}", publicKey: "${k.publicKey}" },\n/* { keyId: "${k.keyId}", publicKey: "${k.publicKey}" } */\n`;
    expect(trustedKeysFromSource(ts)).toEqual([]);
  });
});

describe("trustedKeysFromSource refuses keys outside the trusted array (review of #1400)", () => {
  it("ignores a key in a trailing comment on a trusted line", () => {
    const a = fresh().entry;
    const b = fresh().entry;
    const ts = `export const TRUSTED_RELEASE_KEYS = [\n  { keyId: "${a.keyId}", publicKey: "${a.publicKey}" }, // retired: { keyId: "${b.keyId}", publicKey: "${b.publicKey}" }\n];\n`;
    expect(trustedKeysFromSource(ts).map((k) => k.keyId)).toEqual([a.keyId]);
  });
  it("ignores keys in a second const such as a revoked list", () => {
    const a = fresh().entry;
    const b = fresh().entry;
    const ts = `export const TRUSTED_RELEASE_KEYS = [\n  { keyId: "${a.keyId}", publicKey: "${a.publicKey}" },\n];\nexport const REVOKED_RELEASE_KEYS = [\n  { keyId: "${b.keyId}", publicKey: "${b.publicKey}" },\n];\n`;
    expect(trustedKeysFromSource(ts).map((k) => k.keyId)).toEqual([a.keyId]);
  });
  it("throws on an array that is not a plain list (a condition, a filter, a template)", () => {
    const b = fresh().entry;
    for (const ts of [
      `export const TRUSTED_RELEASE_KEYS = env ? [{ keyId: "${b.keyId}", publicKey: "${b.publicKey}" }] : [];`,
      `export const TRUSTED_RELEASE_KEYS = [...ALL.filter(Boolean), { keyId: "${b.keyId}", publicKey: "${b.publicKey}" }];`,
      `export const TRUSTED_RELEASE_KEYS = [\`{ keyId: "${b.keyId}", publicKey: "${b.publicKey}" }\`];`,
    ]) {
      expect(() => trustedKeysFromSource(ts)).toThrow(/plain list|not closed/);
    }
  });
});

describe("verifyTrusted", () => {
  it("accepts a manifest signed by a trusted key", () => {
    const k = fresh();
    expect(verifyTrusted(bytes, signManifest(bytes, k.pem), source(k.entry))).toEqual({
      ok: true,
      keyId: k.entry.keyId,
    });
  });
  it("refuses a key the app does not trust, even though it verifies against itself", () => {
    const signer = fresh();
    const shipped = fresh();
    const r = verifyTrusted(bytes, signManifest(bytes, signer.pem), source(shipped.entry));
    expect(r.ok).toBe(false);
    expect(r.why).toContain("not in release-keys.ts");
  });
  it("refuses when the app trusts no key, a bad signature or a garbled .sig", () => {
    const k = fresh();
    const sig = signManifest(bytes, k.pem);
    expect(verifyTrusted(bytes, sig, source()).ok).toBe(false);
    expect(verifyTrusted(Buffer.from("tampered"), sig, source(k.entry)).ok).toBe(false);
    expect(verifyTrusted(bytes, "nope", source(k.entry)).ok).toBe(false);
  });
  it("a key id that claims a trusted key but is signed by another fails", () => {
    const real = fresh();
    const other = fresh();
    const forged = JSON.parse(signManifest(bytes, other.pem));
    forged.keyId = real.entry.keyId;
    expect(verifyTrusted(bytes, JSON.stringify(forged), source(real.entry)).ok).toBe(false);
  });
});

describe("the verify-trusted command", () => {
  it("exits 1 and prints no key material for an untrusted signer", () => {
    const dir = mkdtempSync(join(tmpdir(), "psyche-trusted-"));
    dirs.push(dir);
    const signer = fresh();
    const file = join(dir, "update-manifest.json");
    writeFileSync(file, bytes);
    execFileSync("node", [SCRIPT, "sign", file], {
      env: { ...process.env, PSYCHE_RELEASE_SIGNING_KEY: signer.pem },
    });
    const r = spawnSync("node", [SCRIPT, "verify-trusted", file, KEYS_TS], { encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("UNTRUSTED");
    expect(r.stdout + r.stderr).not.toContain("PRIVATE KEY");
    expect(r.stdout + r.stderr).not.toContain(signer.entry.publicKey);
  });
});
