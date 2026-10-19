import { createHash } from "node:crypto";

/**
 * Strict canonical JSON for hashes this package owns (`tools/list`, MCP binding inputs): sorted
 * keys, no insignificant whitespace, `undefined` members dropped. Unlike a display canonical
 * form it does not normalize Unicode (an NFD rewrite of a description is a change) and it
 * rejects values JSON cannot carry (NaN, Infinity, Map, Date, functions) instead of collapsing
 * them into `null` / `{}`.
 */
export function strictCanonicalJSON(value: unknown): string {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonical JSON: non-finite number");
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((v) => (v === undefined ? "null" : strictCanonicalJSON(v))).join(",")}]`;
  }
  if (typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new TypeError("canonical JSON: only plain objects are allowed");
    }
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${strictCanonicalJSON(obj[k])}`).join(",")}}`;
  }
  throw new TypeError(`canonical JSON: unsupported value of type ${typeof value}`);
}

/** `sha256:<hex>` of a UTF-8 string. */
export function sha256(input: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(input, "utf8").digest("hex")}`;
}
