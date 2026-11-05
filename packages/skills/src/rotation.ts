import { PsycheError } from "@psyche/protocol";
import {
  type BundleAuthor,
  type BundleSigningKey,
  canonicalJson,
  checkSignature,
  exactKeys,
  isObj,
  keyIdOf,
  str,
} from "./bundle-core.ts";

/**
 * Key rotation (docs/design/shared-bundles-2026.md section 9): the old author key signs a short
 * statement naming the new key, and the bundles made with the new key carry it. An importer who
 * trusted the old key then sees "same author, new key (signed by the old key)" instead of an
 * unexplained changed key. The statement proves only that whoever held the old key named the new
 * one: it never makes the new key trusted (that still needs the owner's presence), and it is
 * worth nothing once the old key is revoked.
 */
const ROTATION_PREFIX = "psyche-rotation-v1\n";
/** Longest chain a bundle carries (oldest statement dropped first when an author rotates more). */
export const MAX_ROTATIONS = 8;

export interface RotationStatement {
  from: { keyId: string; publicKey: string };
  to: { keyId: string; publicKey: string; name: string };
  /** The author's claim; not verified. */
  createdAt: string;
  /** base64url Ed25519 signature by `from` over the statement. */
  signature: string;
}

const bad = (msg: string): never => {
  throw new PsycheError("invalid_params", `not a valid rotation statement: ${msg}`);
};

/** The bytes the old key signs: a domain prefix, then the canonical statement without its signature. */
export function rotationBytes(s: Omit<RotationStatement, "signature">): Uint8Array {
  return new TextEncoder().encode(
    `${ROTATION_PREFIX}${canonicalJson({ from: s.from, to: s.to, createdAt: s.createdAt })}`,
  );
}

/** The old key names the new one. */
export function signRotation(
  oldKey: BundleSigningKey,
  to: BundleAuthor,
  createdAt: string,
): RotationStatement {
  const body = {
    from: { keyId: oldKey.author.keyId, publicKey: oldKey.author.publicKey },
    to: { keyId: to.keyId, publicKey: to.publicKey, name: to.name },
    createdAt,
  };
  return { ...body, signature: oldKey.sign(rotationBytes(body)) };
}

function parseOne(raw: unknown): RotationStatement {
  if (!isObj(raw)) return bad("a statement is not an object");
  exactKeys(raw, ["from", "to", "createdAt", "signature"], [], "a rotation statement");
  const from = raw.from;
  const to = raw.to;
  if (!isObj(from)) return bad("from is not an object");
  if (!isObj(to)) return bad("to is not an object");
  exactKeys(from, ["keyId", "publicKey"], [], "from");
  exactKeys(to, ["keyId", "publicKey", "name"], [], "to");
  return {
    from: {
      keyId: str(from.keyId, "from.keyId", 80),
      publicKey: str(from.publicKey, "from.publicKey", 64),
    },
    to: {
      keyId: str(to.keyId, "to.keyId", 80),
      publicKey: str(to.publicKey, "to.publicKey", 64),
      name: str(to.name, "to.name", 64),
    },
    createdAt: str(raw.createdAt, "createdAt", 40),
    signature: str(raw.signature, "signature", 200),
  };
}

/** Parses the `rotation` field of a file: at most `MAX_ROTATIONS` statements, exact fields. */
export function parseRotationChain(raw: unknown): RotationStatement[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_ROTATIONS)
    return bad(`a chain has 1 to ${MAX_ROTATIONS} statements`);
  return raw.map(parseOne);
}

/**
 * Verifies a chain that must end at `finalKey`: every statement's signature by its old key, every
 * key id the fingerprint of its key, each statement starting where the last ended, no key twice,
 * and the last naming the key (and the name) that signed the file. Returns the earlier keys, the
 * nearest first. Anything else is refused: a forged statement is never skipped as "unsigned".
 */
export function verifyRotationChain(
  chain: readonly RotationStatement[],
  finalKey: BundleAuthor,
): string[] {
  const seen = new Set<string>();
  let expectFrom: string | undefined;
  for (const s of chain) {
    if (keyIdOf(s.from.publicKey) !== s.from.keyId || keyIdOf(s.to.publicKey) !== s.to.keyId)
      bad("a key id is not its key's fingerprint");
    if (s.from.keyId === s.to.keyId) bad("a key cannot replace itself");
    if (expectFrom !== undefined && s.from.keyId !== expectFrom)
      bad("the statements do not follow each other");
    if (seen.has(s.to.keyId)) bad("a key appears twice");
    seen.add(s.from.keyId);
    // The old key signed it: checkSignature also validates the key shapes.
    try {
      checkSignature(
        { name: "", keyId: s.from.keyId, publicKey: s.from.publicKey },
        s.signature,
        rotationBytes(s),
      );
    } catch {
      bad("a statement is not signed by the key it replaces");
    }
    expectFrom = s.to.keyId;
  }
  const last = chain[chain.length - 1];
  if (last === undefined) return bad("empty chain");
  if (last.to.keyId !== finalKey.keyId || last.to.publicKey !== finalKey.publicKey)
    bad("the chain does not end at the key that signed this file");
  if (last.to.name !== finalKey.name) bad("the chain names the new key under another name");
  return chain.map((s) => s.from.keyId).reverse();
}
