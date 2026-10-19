/**
 * Shared input model for the file generators (P8). The agent's `generate_file` tool fills one of
 * these specs from a chat request; every string is untrusted model output, so each generator
 * escapes it for its target format and never interprets it as markup or formulas.
 */

export interface GeneratedFile {
  name: string;
  mime: string;
  bytes: Uint8Array;
}

export type ChartKind = "bar" | "line" | "pie";

export interface ChartSeries {
  name: string;
  values: number[];
}

export interface ChartSpec {
  kind: ChartKind;
  title?: string;
  /** Category labels (x axis, or pie slices). */
  labels: string[];
  /** Pie charts use the first series only. */
  series: ChartSeries[];
  /** Appended to axis ticks and values, e.g. "%" or " €". */
  unit?: string;
  width?: number;
  height?: number;
}

export type CellValue = string | number | boolean | null;

export type Block =
  | { type: "heading"; level: 1 | 2 | 3; text: string }
  /** Inline `**bold**`, `*italic*` and `` `code` `` are honoured (see `parseInline`). */
  | { type: "paragraph"; text: string }
  | { type: "list"; ordered?: boolean; items: string[] }
  | { type: "table"; columns: string[]; rows: CellValue[][] }
  | { type: "code"; text: string; lang?: string }
  | { type: "quote"; text: string }
  | { type: "chart"; chart: ChartSpec }
  | { type: "pageBreak" };

export interface DocSpec {
  title: string;
  author?: string;
  blocks: Block[];
}

export interface InlineRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
}

/** Splits `**bold**`, `*italic*` / `_italic_` and `` `code` `` into runs. No nesting. */
export function parseInline(text: string): InlineRun[] {
  const runs: InlineRun[] = [];
  const re = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\s][^*\n]*\*|_[^_\s][^_\n]*_)/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    const at = m.index ?? 0;
    if (at > last) runs.push({ text: text.slice(last, at) });
    const tok = m[0];
    if (tok.startsWith("`")) runs.push({ text: tok.slice(1, -1), code: true });
    else if (tok.startsWith("**")) runs.push({ text: tok.slice(2, -2), bold: true });
    else runs.push({ text: tok.slice(1, -1), italic: true });
    last = at + tok.length;
  }
  if (last < text.length) runs.push({ text: text.slice(last) });
  return runs;
}

/** Drops code points XML 1.0 cannot carry (controls, lone surrogates, U+FFFE/FFFF). */
export function xmlSafe(s: string): string {
  return String(s).replace(/[^\t\n\r\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu, "");
}

/** Strips inline markers (for formats with no rich text, like table cells). */
export function plainInline(text: string): string {
  return parseInline(text)
    .map((r) => r.text)
    .join("");
}

/** Cell value as display text. */
export function cellText(v: CellValue): string {
  if (v === null) return "";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  return String(v);
}

/** Safe file name: keeps letters, digits, spaces, dashes; adds the extension. */
export function fileName(title: string, ext: string): string {
  const base = title
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N} _.-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .slice(0, 80)
    .trim();
  return `${base || "untitled"}.${ext}`;
}

export const MIME = {
  markdown: "text/markdown",
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  svg: "image/svg+xml",
  html: "text/html",
} as const;

/** Spreadsheet input: an explicit formula is `{ formula: "SUM(B2:B4)" }`; strings are never formulas. */
export type SheetCell = CellValue | { formula: string };

export interface SheetSpec {
  name: string;
  columns: string[];
  rows: SheetCell[][];
  /** Column widths in characters. */
  widths?: number[];
  /** Number format per column, e.g. "0.00", "$#,##0", "yyyy-mm-dd". */
  formats?: (string | null)[];
}

export interface WorkbookSpec {
  title: string;
  sheets: SheetSpec[];
}

export interface Slide {
  title?: string;
  /** Inline markers are stripped. */
  bullets?: string[];
  table?: { columns: string[]; rows: CellValue[][] };
  chart?: ChartSpec;
  /** Speaker notes. */
  notes?: string;
}

export interface DeckSpec {
  title: string;
  subtitle?: string;
  author?: string;
  slides: Slide[];
}

/** Limits that keep a single generator call bounded (a runaway model loop cannot fill the disk). */
export const GENERATOR_LIMITS = {
  blocks: 5_000,
  tableRows: 10_000,
  sheetRows: 200_000,
  sheets: 50,
  slides: 300,
  chartPoints: 2_000,
} as const;

export class GeneratorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GeneratorError";
  }
}

export function assertLimit(count: number, limit: number, what: string): void {
  if (count > limit) throw new GeneratorError(`Too many ${what}: ${count} > ${limit}`);
}
