import type { Range } from "./types.ts";

/** Markers FTS5 `snippet()` / `highlight()` wrap matches in; stripped before results leave. */
export const HL_OPEN = "\u0002";
export const HL_CLOSE = "\u0003";

/** Removes the markers and returns the plain text with the marked ranges. */
export function stripMarkers(marked: string): { text: string; ranges: Range[] } {
  let text = "";
  const ranges: Range[] = [];
  let open = -1;
  for (const ch of marked) {
    if (ch === HL_OPEN) {
      open = text.length;
    } else if (ch === HL_CLOSE) {
      if (open >= 0 && text.length > open) ranges.push([open, text.length]);
      open = -1;
    } else {
      text += ch;
    }
  }
  return { text, ranges };
}

/**
 * Snippet and highlight ranges for text that did not come through FTS5 (memory chunks, filter-only
 * results): a window around the first matching token, case-insensitive prefix matches.
 */
export function snippetFor(
  text: string,
  tokens: string[],
  width = 160,
): { text: string; ranges: Range[] } {
  const flat = text.replace(/\s+/g, " ").trim();
  const lower = flat.toLowerCase();
  let first = -1;
  for (const t of tokens) {
    const i = lower.indexOf(t);
    if (i >= 0 && (first < 0 || i < first)) first = i;
  }
  const start = first < 0 ? 0 : Math.max(0, first - Math.floor(width / 3));
  const end = Math.min(flat.length, start + width);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < flat.length ? "…" : "";
  const window = flat.slice(start, end);
  const out = `${prefix}${window}${suffix}`;
  return { text: out, ranges: rangesOf(out, tokens) };
}

/** Ranges of whole words in `text` that start with one of `tokens` (lower-case). */
export function rangesOf(text: string, tokens: string[]): Range[] {
  if (tokens.length === 0) return [];
  const ranges: Range[] = [];
  for (const m of text.matchAll(/[\p{L}\p{N}\p{M}]+/gu)) {
    const word = m[0].toLowerCase();
    if (tokens.some((t) => t.length > 0 && word.startsWith(t))) {
      ranges.push([m.index, m.index + m[0].length]);
    }
  }
  return ranges;
}
