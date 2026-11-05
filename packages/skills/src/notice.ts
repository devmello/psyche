import { PsycheError } from "@psyche/protocol";
import {
  type BundleAuthor,
  type BundleSigningKey,
  canonicalJson,
  checkSignature,
  exactKeys,
  isObj,
  parseAuthor,
  str,
} from "./bundle-core.ts";
import { parseRotationChain, type RotationStatement, verifyRotationChain } from "./rotation.ts";

/**
 * Signed revocation notices (docs/design/shared-bundles-2026.md section 9): a small file an
 * author publishes (or hosts at a link) saying "this key is revoked" or "this bundle is bad".
 * With no server there is no pull; the owner imports a notice by file or link, and the Gateway
 * applies it only when it is signed by a key the owner has seen (or by a successor of one, named
 * by a rotation chain it carries) and only about that key's own lineage or bundles. A notice can
 * only block, never trust anything.
 *
 *     { "psyche-notice": 1, "notice": {...}, "signature": "<base64url>", "rotation": [...] }
 */
export const NOTICE_VERSION = 1;
export const NOTICE_EXTENSION = ".psyche-notice";
/** A notice is a few hundred bytes; anything bigger is not one. */
export const MAX_NOTICE_BYTES = 16 * 1024;
const NOTICE_PREFIX = "psyche-notice-v1\n";

export interface RevocationNotice {
  kind: "key" | "bundle";
  /** The key being revoked, or (for a bundle) the key that signed the bad bundle. */
  keyId: string;
  /** `sha256:<hex>` of the bundle's signed manifest bytes (the id the card shows); `bundle` only. */
  bundleHash?: string;
  reason: string;
  /** The author's claim; not verified. */
  createdAt: string;
  signer: BundleAuthor;
}

export interface VerifiedNotice {
  notice: RevocationNotice;
  /** Earlier keys of the signer named by a verified rotation chain (nearest first). */
  ancestors: string[];
  bytes: number;
}

const bad = (msg: string): never => {
  throw new PsycheError("invalid_params", `not a valid revocation notice: ${msg}`);
};

function noticeBytes(n: RevocationNotice): Uint8Array {
  return new TextEncoder().encode(`${NOTICE_PREFIX}${canonicalJson(n)}`);
}

const KEY_ID = /^sha256:[0-9a-f]{64}$/;

/** The text of a notice signed by `signer` (the owner's author key), with its rotation chain. */
export function buildNotice(
  signer: BundleSigningKey,
  spec: { kind: "key" | "bundle"; keyId: string; bundleHash?: string; reason: string },
  now: Date,
  rotation: readonly RotationStatement[] = [],
): string {
  if (!KEY_ID.test(spec.keyId)) bad("keyId is not a key id");
  if (spec.kind === "bundle" && !KEY_ID.test(spec.bundleHash ?? ""))
    bad("a bundle notice needs the bundle hash");
  if (spec.kind === "key" && spec.bundleHash !== undefined) bad("a key notice names no bundle");
  const reason = spec.reason.trim();
  if (reason === "" || reason.length > 200) bad("the reason must be 1-200 characters");
  const notice: RevocationNotice = {
    kind: spec.kind,
    keyId: spec.keyId,
    ...(spec.bundleHash === undefined ? {} : { bundleHash: spec.bundleHash }),
    reason,
    createdAt: now.toISOString(),
    signer: signer.author,
  };
  return JSON.stringify({
    "psyche-notice": NOTICE_VERSION,
    notice,
    signature: signer.sign(noticeBytes(notice)),
    ...(rotation.length === 0 ? {} : { rotation }),
  });
}

/**
 * Parses and verifies a notice file: exact fields, size, the signer's key and signature, and a
 * rotation chain (when present) that ends at the signer. An unsigned or forged notice is an error.
 */
export function verifyNotice(text: string): VerifiedNotice {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > MAX_NOTICE_BYTES) bad(`larger than ${MAX_NOTICE_BYTES} bytes`);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return bad("not JSON");
  }
  if (!isObj(raw)) return bad("not an object");
  exactKeys(raw, ["psyche-notice", "notice", "signature"], ["rotation"], "the file");
  if (raw["psyche-notice"] !== NOTICE_VERSION) bad("unsupported notice version");
  const n = raw.notice;
  if (!isObj(n)) return bad("notice is not an object");
  exactKeys(n, ["kind", "keyId", "reason", "createdAt", "signer"], ["bundleHash"], "notice");
  if (n.kind !== "key" && n.kind !== "bundle") bad("kind must be key or bundle");
  const keyId = str(n.keyId, "keyId", 80);
  if (!KEY_ID.test(keyId)) bad("keyId is not a key id");
  let bundleHash: string | undefined;
  if (n.bundleHash !== undefined) {
    bundleHash = str(n.bundleHash, "bundleHash", 80);
    if (!KEY_ID.test(bundleHash)) bad("bundleHash is not a hash");
  }
  if (n.kind === "bundle" && bundleHash === undefined) bad("a bundle notice needs the bundle hash");
  if (n.kind === "key" && bundleHash !== undefined) bad("a key notice names no bundle");
  const reason = str(n.reason, "reason", 200);
  if (reason.trim() === "") bad("the reason is empty");
  const signer = parseAuthor(n.signer);
  if (signer === undefined) return bad("the notice is not signed");
  const notice: RevocationNotice = {
    kind: n.kind as "key" | "bundle",
    keyId,
    ...(bundleHash === undefined ? {} : { bundleHash }),
    reason,
    createdAt: str(n.createdAt, "createdAt", 40),
    signer,
  };
  checkSignature(signer, raw.signature, noticeBytes(notice));
  const ancestors =
    raw.rotation === undefined ? [] : verifyRotationChain(parseRotationChain(raw.rotation), signer);
  return { notice, ancestors, bytes };
}
