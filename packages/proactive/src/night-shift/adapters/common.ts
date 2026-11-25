import type { Json, Preview } from "./types.ts";

/** C0/C1 controls (U+0085 NEL included), line and paragraph separators and bidi overrides. */
const UNSAFE = /[\p{Cc}\p{Zl}\p{Zp}‎‏‪-‮⁦-⁩]/gu;

/** Plain text for a preview: no control or line-breaking characters, length capped. */
export function plain(value: unknown, max = 500): string {
  const s = typeof value === "string" ? value : value === undefined ? "" : JSON.stringify(value);
  const clean = s.replace(UNSAFE, " ").replace(/ {2,}/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

export function preview(
  kind: Preview["kind"],
  title: string,
  rows: Array<[string, unknown]>,
): Preview {
  return {
    kind,
    title: plain(title, 200),
    rows: rows.map(([label, value]) => ({ label: plain(label, 60), value: plain(value) })),
  };
}

export function str(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

/** A string array; `[]` when absent; undefined when present but not one (fail closed). */
export function strList(v: unknown): string[] | undefined {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) return undefined;
  return v as string[];
}

/** Stable JSON: sorted keys, so equal values hash and compare equal. */
export function stable(v: Json): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v !== null && typeof v === "object") {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, Json>)[k] as Json)}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

export function asRecord(v: Json | undefined): Record<string, Json> {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? v : {};
}
