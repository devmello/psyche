import { sha256 } from "./canonical.ts";
import { REDACTED, redactSensitive } from "./sensitive.ts";

/**
 * Redaction for audit entries and receipts (security §15.1, §14; data model §5). "Tool results are
 * logged as sizes and hashes only; config changes as key names and hashes"; no secret and no
 * message body enters the log.
 *
 * - Secret-bearing keys (`password`, `token`, `answerToken`, `secret`, `apiKey`, `authorization`,
 *   `cookie`, `otp`, `cvv`, …) are replaced by `[redacted]`, without a hash: a hash of a short
 *   secret is guessable.
 * - Content keys (`body`, `text`, `content`, `html`, `stdout`, `result`, `snippet`, …) become a
 *   digest `{redacted: "content", sha256, bytes}` so entries stay correlatable without the body.
 * - Every remaining string passes through the secret-pattern detector and an optional extra
 *   redactor (the Credential Broker's `redact`, which knows the vault's live values).
 * - Non-JSON values (functions, symbols, BigInt, class instances other than `Date`) are dropped
 *   or stringified, so a redacted value always canonicalizes.
 */

const SECRET_KEYS = new Set(
  [
    "password",
    "passwd",
    "passphrase",
    "secret",
    "secrets",
    "clientsecret",
    "token",
    "accesstoken",
    "refreshtoken",
    "idtoken",
    "answertoken",
    "answertokens",
    "bootstraptoken",
    "apikey",
    "privatekey",
    "authorization",
    "proxyauthorization",
    "cookie",
    "setcookie",
    "otp",
    "totp",
    "totpseed",
    "cvv",
    "cvc",
    "pan",
    "cardnumber",
    "accountnumber",
    "ssn",
    "pin",
    "seed",
    "mnemonic",
    "dek",
    "recoverykey",
  ].map(normalizeKey),
);

const CONTENT_KEYS = new Set(
  [
    "body",
    "bodyhtml",
    "bodytext",
    "bodypreview",
    "html",
    "text",
    "content",
    "contents",
    "message",
    "messages",
    "prompt",
    "snippet",
    "stdout",
    "stderr",
    "output",
    "result",
    "results",
    "transcript",
    "pagetext",
    "screenshot",
    "data_url",
    "dataurl",
    "attachmentdata",
    "params",
    "args",
    "arguments",
    "fieldvalues",
    "typedtext",
  ].map(normalizeKey),
);

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[-_\s]/g, "");
}

export interface RedactOptions {
  /** Extra redactor applied to every string (e.g. `CredentialBroker.redact`). */
  redact?: (text: string) => string;
  /** Keys kept verbatim even though they look like content keys (`subject` is never one). */
  keep?: readonly string[];
  /** Strings longer than this are reduced to a digest. Default 2,048. */
  maxStringLength?: number;
  /** String values stored as given: the caller already redacted them (change-record diffs). */
  verbatim?: readonly string[];
}

export interface ContentDigest {
  redacted: "content";
  sha256: string;
  bytes: number;
}

export function contentDigest(value: unknown): ContentDigest {
  const text = typeof value === "string" ? value : safeStringify(value);
  return { redacted: "content", sha256: sha256(text), bytes: Buffer.byteLength(text, "utf8") };
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, (_k, v: unknown) => (typeof v === "bigint" ? String(v) : v)) ?? "";
  } catch {
    return String(value);
  }
}

/** Deep-redacted copy of `value`, safe to append to the audit log. */
export function redactForAudit<T>(value: T, options: RedactOptions = {}): T {
  const keep = new Set((options.keep ?? []).map(normalizeKey));
  const max = options.maxStringLength ?? 2048;
  const verbatim = new Set((options.verbatim ?? []).map(normalizeKey));
  const scrub = (s: string): string => {
    const once = options.redact === undefined ? s : options.redact(s);
    return redactSensitive(once);
  };
  const walk = (v: unknown, depth: number): unknown => {
    if (depth > 32) return REDACTED;
    if (typeof v === "string") {
      if (v.length > max) return contentDigest(v);
      return scrub(v);
    }
    if (typeof v === "number") return Number.isFinite(v) && !Object.is(v, -0) ? v : String(v);
    if (typeof v === "boolean" || v === null) return v;
    if (typeof v === "bigint") return v.toString();
    if (v === undefined || typeof v === "function" || typeof v === "symbol") return undefined;
    if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
    if (v instanceof Uint8Array) return contentDigest(Buffer.from(v).toString("base64"));
    if (Array.isArray(v)) {
      return v.map((item) => {
        const out = walk(item, depth + 1);
        return out === undefined ? null : out;
      });
    }
    if (typeof v === "object") {
      const proto = Object.getPrototypeOf(v);
      if (proto !== Object.prototype && proto !== null) {
        return contentDigest(String(v));
      }
      const out: Record<string, unknown> = {};
      for (const [k, item] of Object.entries(v as Record<string, unknown>)) {
        const nk = normalizeKey(k);
        if (verbatim.has(nk) && typeof item === "string") {
          out[k] = item;
          continue;
        }
        if (!keep.has(nk) && SECRET_KEYS.has(nk)) {
          out[k] = REDACTED;
          continue;
        }
        if (!keep.has(nk) && CONTENT_KEYS.has(nk) && item !== null && item !== undefined) {
          out[k] = contentDigest(item);
          continue;
        }
        const r = walk(item, depth + 1);
        if (r !== undefined) out[k] = r;
      }
      return out;
    }
    return undefined;
  };
  return walk(value, 0) as T;
}
