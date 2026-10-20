/**
 * The one binding-hash recipe every verifier shares (security §3.5): the agent loop's approval,
 * the connector registry's executor re-check and the vault's fill check all derive from it, so
 * there is a single definition of what an approval binds. Node-only (`node:crypto`): import it
 * as `@psyche/protocol/binding`, never from the browser-safe package root.
 */
import { createHash } from "node:crypto";

/**
 * Binding hashes (security §3.5): `sha256("psyche.binding.v1|" + kind + "|" +
 * canonicalJSON(fields))` with sorted keys and no insignificant whitespace. Strings are hashed
 * exactly as given, never NFC-folded: executors and providers receive the raw string, and NFC /
 * NFD forms are different files, addresses and queries (S23 design-13). Unlike
 * the reference helper in @psyche/testing this rejects non-finite numbers and non-plain objects
 * instead of collapsing them (S23 design-13), so two different payloads cannot share a hash.
 */
export function canonicalJSON(value: unknown): string {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonicalJSON: non-finite number");
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((v) => (v === undefined ? "null" : canonicalJSON(v))).join(",")}]`;
  }
  if (typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new TypeError("canonicalJSON: only plain objects are allowed");
    }
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).filter((k) => obj[k] !== undefined);
    const normalized = keys.map((k) => [k, k] as const);
    normalized.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${normalized.map(([n, k]) => `${JSON.stringify(n)}:${canonicalJSON(obj[k])}`).join(",")}}`;
  }
  throw new TypeError(`canonicalJSON: unsupported value of type ${typeof value}`);
}

export function sha256Hex(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

export function sha256(input: string | Uint8Array): `sha256:${string}` {
  return `sha256:${sha256Hex(input)}`;
}

export function bindingHash(kind: string, fields: unknown): `sha256:${string}` {
  return sha256(`psyche.binding.v1|${kind}|${canonicalJSON(fields)}`);
}

/**
 * The binding hash the agent loop approved for a tool call (agent-core `loop.ts` `#gate`), so the
 * executor re-checks exactly what the owner approved (issue #78). With a described kind the loop
 * binds `bindingHash(kind, {tool, paramsHash, fields?})`; without one the broker's generic recipe
 * is `bindingHash("connector_action", {tool, paramsHash})`. `paramsHash` is
 * `sha256(canonicalJSON(params))` with `undefined` as `null`, as the loop computes it.
 */
export function toolCallBindingHash(
  tool: string,
  params: unknown,
  desc: { kind?: string; bindingFields?: unknown } | undefined,
): `sha256:${string}` {
  const paramsHash = sha256(params === undefined ? "null" : canonicalJSON(params));
  if (desc?.kind === undefined) return bindingHash("connector_action", { tool, paramsHash });
  return bindingHash(desc.kind, {
    tool,
    paramsHash,
    ...(desc.bindingFields === undefined ? {} : { fields: desc.bindingFields }),
  });
}
