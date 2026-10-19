import { createHash } from "node:crypto";

/**
 * Canonical JSON (security §3.5): sorted keys, no insignificant whitespace, NFC strings,
 * `undefined` members dropped. Used for binding hashes and the audit hash chain.
 */
export function canonicalJSON(value: unknown): string {
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value.normalize("NFC"));
  if (Array.isArray(value)) {
    return `[${value.map((v) => (v === undefined ? "null" : canonicalJSON(v))).join(",")}]`;
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k.normalize("NFC"))}:${canonicalJSON(obj[k])}`).join(",")}}`;
  }
  throw new TypeError(`canonicalJSON: unsupported value of type ${typeof value}`);
}

/** `sha256:<hex>` of a UTF-8 string or bytes. */
export function sha256(input: string | Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(input).digest("hex")}`;
}

/** The binding hash formula from security §3.5. */
export function bindingHash(kind: string, fields: unknown): `sha256:${string}` {
  return sha256(`psyche.binding.v1|${kind}|${canonicalJSON(fields)}`);
}
