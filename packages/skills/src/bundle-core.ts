import { createHash, createPublicKey, verify } from "node:crypto";
import { PsycheError } from "@psyche/protocol";
import { sha256Hex } from "./tree.ts";

/**
 * Primitives shared by the skill bundle, the connector bundle, rotation statements and
 * revocation notices (docs/design/shared-bundles-2026.md): strict parsing helpers, canonical JSON,
 * key ids and Ed25519 verification.
 */

/** Characters an author name may not contain: controls and bidirectional overrides. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: this is the check for them
export const BAD_NAME_CHARS = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/;

export interface BundleAuthor {
  /** The author's own claim; never trusted on its own. */
  name: string;
  /** `sha256:<hex>` of the raw 32-byte public key. */
  keyId: string;
  /** base64url raw Ed25519 public key. */
  publicKey: string;
}

/** Signs canonical manifest bytes (the owner's author key). */
export interface BundleSigningKey {
  author: BundleAuthor;
  sign(data: Uint8Array): string;
}

export const bad = (msg: string): never => {
  throw new PsycheError("invalid_params", `not a valid bundle: ${msg}`);
};

/** `sha256:<hex>` of a raw public key given as base64url: the key id everywhere. */
export function keyIdOf(publicKeyB64url: string): string {
  return `sha256:${createHash("sha256").update(Buffer.from(publicKeyB64url, "base64url")).digest("hex")}`;
}

/** JSON with sorted keys and no whitespace. Strings, finite numbers, booleans, null, arrays, objects. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonicalJson: only finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(",")}}`;
  }
  throw new Error("canonicalJson: unsupported value");
}

export const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export function exactKeys(
  o: Record<string, unknown>,
  required: string[],
  optional: string[],
  what: string,
) {
  const allowed = new Set([...required, ...optional]);
  for (const k of Object.keys(o))
    if (!allowed.has(k)) bad(`${what} has an unknown field "${k.slice(0, 40)}"`);
  for (const k of required) if (!(k in o)) bad(`${what} is missing "${k}"`);
}

export const str = (v: unknown, what: string, max: number): string => {
  if (typeof v !== "string" || v.length > max)
    return bad(`${what} must be a string of at most ${max} characters`);
  return v;
};

export function strList(v: unknown, what: string): string[] {
  if (!Array.isArray(v) || v.length > 64) return bad(`${what} must be a list of at most 64`);
  return v.map((x) => str(x, what, 200));
}

/** The manifest's author block, or `undefined` when there is none. */
export function parseAuthor(a: unknown): BundleAuthor | undefined {
  if (a === undefined) return undefined;
  if (!isObj(a)) return bad("author is not an object");
  exactKeys(a, ["name", "keyId", "publicKey"], [], "author");
  const aname = str(a.name, "author.name", 64);
  if (aname.trim() === "" || BAD_NAME_CHARS.test(aname)) bad("author.name has control characters");
  return {
    name: aname,
    keyId: str(a.keyId, "author.keyId", 80),
    publicKey: str(a.publicKey, "author.publicKey", 64),
  };
}

/** The author's key and a signature over `data`; throws unless the signature verifies. */
export function checkSignature(author: BundleAuthor, signature: unknown, data: Uint8Array): void {
  const sig = str(signature, "signature", 200);
  if (
    !/^[A-Za-z0-9_-]{86}$/.test(sig) ||
    Buffer.from(sig, "base64url").toString("base64url") !== sig
  )
    bad("malformed signature");
  if (
    !/^[A-Za-z0-9_-]{43}$/.test(author.publicKey) ||
    Buffer.from(author.publicKey, "base64url").toString("base64url") !== author.publicKey
  )
    bad("malformed public key");
  if (keyIdOf(author.publicKey) !== author.keyId) bad("the key id is not the key's fingerprint");
  let ok = false;
  try {
    ok = verify(
      null,
      data,
      createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: author.publicKey }, format: "jwk" }),
      Buffer.from(sig, "base64url"),
    );
  } catch {
    ok = false;
  }
  if (!ok) bad("the signature does not verify; the file was changed or is not from this author");
}

/** The id a revocation notice names a signed bundle by: SHA-256 of the exact bytes signed. */
export function bundleHashOf(signed: Uint8Array): string {
  return `sha256:${sha256Hex(signed)}`;
}
