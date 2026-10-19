import { createHash } from "node:crypto";

/** Sorted-key JSON over strings, numbers, booleans, arrays and plain objects (security §3.5). */
export function canonicalJSON(value: unknown): string {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonicalJSON: non-finite number");
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value.normalize("NFC"));
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(",")}]`;
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k.normalize("NFC"))}:${canonicalJSON(obj[k])}`).join(",")}}`;
  }
  throw new TypeError(`canonicalJSON: unsupported ${typeof value}`);
}

/** `bindingHash` for `skill_install` (security §3.5 formula; fields documented in the README). */
export function skillInstallBinding(fields: {
  name: string;
  scope: "home" | "workspace";
  source: unknown;
  treeHash: string;
}): `sha256:${string}` {
  const digest = createHash("sha256")
    .update(`psyche.binding.v1|skill_install|${canonicalJSON(fields)}`)
    .digest("hex");
  return `sha256:${digest}`;
}

export const skillInstallGrantKey = (name: string) => `skill_install|${name}`;
