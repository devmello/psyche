import { createHash } from "node:crypto";
import { PsycheError } from "@psyche/protocol";

/**
 * Strict canonical JSON (security §3.5; RFC 8785 serialization over a strict value domain).
 *
 * - Object keys sorted by UTF-16 code units, no insignificant whitespace (RFC 8785 §3.2.3).
 * - Numbers use the ECMAScript form RFC 8785 adopts; `NaN`, `±Infinity` and `-0` throw, so no two
 *   distinct inputs share bytes (S23 design-13: the reference version mapped them to `null`/`0`).
 * - Strings are hashed exactly as given: no NFC folding, because executors run the raw string and
 *   NFC and NFD names are different files on ext4 (design-13). Lone surrogates throw.
 * - Only plain objects and arrays: `Map`, `Set`, `Date`, `Buffer`, class instances, functions,
 *   symbols and `BigInt` throw instead of collapsing to `{}`.
 * - `undefined` object members are dropped (optional fields); `undefined` inside an array throws.
 */

export class CanonicalizationError extends PsycheError {
  constructor(path: string, problem: string) {
    super("invalid_params", `not canonical JSON at ${path}: ${problem}`, {
      details: { path, problem },
    });
    this.name = "CanonicalizationError";
  }
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

export function canonicalJSON(value: unknown): string {
  return encode(value, "$", new Set());
}

function encode(value: unknown, path: string, seen: Set<object>): string {
  switch (typeof value) {
    case "string":
      if (LONE_SURROGATE.test(value)) throw new CanonicalizationError(path, "lone surrogate");
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) throw new CanonicalizationError(path, `${value} is not finite`);
      if (Object.is(value, -0)) throw new CanonicalizationError(path, "-0");
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "object": {
      if (value === null) return "null";
      if (seen.has(value)) throw new CanonicalizationError(path, "cycle");
      seen.add(value);
      try {
        if (Array.isArray(value)) {
          const parts: string[] = [];
          for (let i = 0; i < value.length; i += 1) {
            if (!(i in value) || value[i] === undefined) {
              throw new CanonicalizationError(`${path}[${i}]`, "undefined or hole in array");
            }
            parts.push(encode(value[i], `${path}[${i}]`, seen));
          }
          return `[${parts.join(",")}]`;
        }
        const proto = Object.getPrototypeOf(value);
        if (proto !== Object.prototype && proto !== null) {
          const name = (value as { constructor?: { name?: string } }).constructor?.name ?? "object";
          throw new CanonicalizationError(path, `${name} is not a plain object`);
        }
        if (Object.getOwnPropertySymbols(value).length > 0) {
          throw new CanonicalizationError(path, "symbol keys");
        }
        const obj = value as Record<string, unknown>;
        const keys = Object.keys(obj)
          .filter((k) => obj[k] !== undefined)
          .sort();
        const parts: string[] = [];
        for (const k of keys) {
          if (LONE_SURROGATE.test(k))
            throw new CanonicalizationError(path, "lone surrogate in key");
          parts.push(`${JSON.stringify(k)}:${encode(obj[k], `${path}.${k}`, seen)}`);
        }
        return `{${parts.join(",")}}`;
      } finally {
        seen.delete(value);
      }
    }
    default:
      throw new CanonicalizationError(path, `${typeof value} is not JSON`);
  }
}

export type Sha256Ref = `sha256:${string}`;

/** `sha256:<hex>` of a UTF-8 string or bytes. */
export function sha256(input: string | Uint8Array): Sha256Ref {
  return `sha256:${createHash("sha256").update(input).digest("hex")}`;
}

/** `sha256(canonicalJSON(value))`. */
export function hashCanonical(value: unknown): Sha256Ref {
  return sha256(canonicalJSON(value));
}

export const SHA256_REF = /^sha256:[0-9a-f]{64}$/;

export function isSha256Ref(value: unknown): value is Sha256Ref {
  return typeof value === "string" && SHA256_REF.test(value);
}
