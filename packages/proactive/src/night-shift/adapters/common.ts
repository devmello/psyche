import type { Json, Preview, PreviewRow } from "./types.ts";

/** C0/C1 controls (U+0085 NEL included), line and paragraph separators and bidi overrides. */
const UNSAFE = /[\p{Cc}\p{Zl}\p{Zp}‎‏‪-‮⁦-⁩]/gu;

/** Plain text for a preview: no control or line-breaking characters. `max` caps the length. */
export function plain(value: unknown, max = 500): string {
  return plainCut(value, max).text;
}

function plainCut(value: unknown, max: number): { text: string; cut: boolean } {
  const s = typeof value === "string" ? value : value === undefined ? "" : JSON.stringify(value);
  const clean = s.replace(UNSAFE, " ").replace(/ {2,}/g, " ").trim();
  return clean.length > max
    ? { text: `${clean.slice(0, max - 1)}…`, cut: true }
    : { text: clean, cut: false };
}

export type RowInput = [
  label: string,
  value: unknown,
  opts?: { full?: true; badge?: PreviewRow["badge"] },
];

/** Sendable fields pass `{ full: true }`: carried whole, never shortened. */
export function preview(kind: Preview["kind"], title: string, rows: RowInput[]): Preview {
  let truncated = false;
  const out: PreviewRow[] = rows.map(([label, value, opts]) => {
    const { text, cut } = plainCut(value, opts?.full ? Number.POSITIVE_INFINITY : 500);
    if (cut) truncated = true;
    const row: PreviewRow = { label: plain(label, 60), value: text };
    if (cut) row.truncated = true;
    if (opts?.badge) row.badge = opts.badge;
    return row;
  });
  return { kind, title: plain(title, 200), rows: out, truncated };
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
