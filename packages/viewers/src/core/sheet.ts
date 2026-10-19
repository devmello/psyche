import { parseCsv } from "./csv.ts";
import { extensionOf } from "./registry.ts";

/** One sheet as display strings. Row 0 of `rows` is the first data row (after the header). */
export interface SheetData {
  name: string;
  /** Header labels when the first row looks like one, else null (columns use letters). */
  header: string[] | null;
  rows: string[][];
  columnCount: number;
  truncated: boolean;
}

export interface WorkbookData {
  sheets: SheetData[];
  source: "csv" | "tsv" | "xlsx";
}

export interface ParseSheetOptions {
  /** Hard cap on rows per sheet; the grid is virtualized but memory is not free. */
  maxRows?: number;
  /** Treat the first row as a header: true, false, or detect (default). */
  header?: boolean;
}

const DEFAULT_MAX_ROWS = 1_000_000;

/** "A".."Z", "AA".. for a 0-based column index. */
export function columnLetter(index: number): string {
  let n = index + 1;
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** A1-style reference for 0-based data coordinates (accounts for the header row). */
export function cellRef(sheet: SheetData, row: number, col: number): string {
  return `${columnLetter(col)}${row + 1 + (sheet.header === null ? 0 : 1)}`;
}

const looksNumeric = (s: string) => s.trim() !== "" && Number.isFinite(toNumber(s));

/** Parses "1,234.5", "$12", "-3%", "(42)" as numbers; NaN otherwise. */
export function toNumber(raw: string): number {
  let s = raw.trim();
  if (s === "") return Number.NaN;
  let negative = false;
  if (s.startsWith("(") && s.endsWith(")")) {
    negative = true;
    s = s.slice(1, -1);
  }
  let pct = false;
  if (s.endsWith("%")) {
    pct = true;
    s = s.slice(0, -1);
  }
  s = s.replace(/^[$€£¥]/, "").replace(/,/g, "");
  if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(s)) return Number.NaN;
  let n = Number(s);
  if (pct) n /= 100;
  return negative ? -n : n;
}

function detectHeader(rows: string[][]): boolean {
  const first = rows[0];
  if (first === undefined || rows.length < 2) return false;
  const nonEmpty = first.filter((c) => c.trim() !== "");
  if (nonEmpty.length === 0 || nonEmpty.some(looksNumeric)) return false;
  return new Set(nonEmpty).size === nonEmpty.length;
}

function toSheet(name: string, all: string[][], truncated: boolean, header?: boolean): SheetData {
  const hasHeader = header ?? detectHeader(all);
  const columnCount = all.reduce((m, r) => (r.length > m ? r.length : m), 0);
  return {
    name,
    header: hasHeader ? (all[0] ?? []).map((h, i) => h.trim() || columnLetter(i)) : null,
    rows: hasHeader ? all.slice(1) : all,
    columnCount,
    truncated,
  };
}

const decoder = new TextDecoder("utf-8");

/** Parses CSV, TSV or any SheetJS-readable workbook (xlsx, xlsm, xls, ods). */
export async function parseWorkbook(
  bytes: Uint8Array,
  name: string,
  opts: ParseSheetOptions = {},
): Promise<WorkbookData> {
  const maxRows = opts.maxRows ?? DEFAULT_MAX_ROWS;
  const ext = extensionOf(name);
  if (ext === "csv" || ext === "tsv" || ext === "txt") {
    const parsed = parseCsv(decoder.decode(bytes), {
      ...(ext === "tsv" ? { delimiter: "\t" } : {}),
      maxRows: maxRows + 1,
    });
    const truncated = parsed.truncated || parsed.rows.length > maxRows + 1;
    const sheetName = name.replace(/\.[^.]+$/, "") || "Sheet1";
    return {
      source: ext === "tsv" ? "tsv" : "csv",
      sheets: [toSheet(sheetName, parsed.rows, truncated, opts.header)],
    };
  }
  // SheetJS CE from the vendor tarball (ADR-013). Loaded lazily: it is ~1 MB.
  const XLSX = await import("xlsx");
  const wb = XLSX.read(bytes, {
    type: "array",
    dense: true,
    cellFormula: false,
    cellHTML: false,
    cellStyles: false,
    sheetRows: maxRows + 1,
  });
  const sheets: SheetData[] = [];
  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName];
    if (ws === undefined) continue;
    const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, {
      header: 1,
      raw: false,
      defval: "",
      blankrows: true,
    });
    const strings = rows.map((r) => r.map((c) => (c === null || c === undefined ? "" : String(c))));
    while (strings.length > 0 && strings.at(-1)?.every((c) => c === "")) strings.pop();
    const ref = ws["!ref"] === undefined ? undefined : XLSX.utils.decode_range(ws["!ref"]);
    const fullRows = (ws["!fullref"] === undefined ? ref : XLSX.utils.decode_range(ws["!fullref"]))
      ?.e.r;
    const truncated = fullRows !== undefined && fullRows + 1 > maxRows + 1;
    sheets.push(toSheet(sheetName, strings, truncated, opts.header));
  }
  return { source: "xlsx", sheets };
}

// ── Filters and stats ───────────────────────────────────────────────────────────────

export type ColumnFilter =
  | { kind: "contains"; value: string }
  | { kind: "equals"; value: string }
  | { kind: "gt" | "gte" | "lt" | "lte"; value: number }
  | { kind: "empty" | "notEmpty" };

export function matchesFilter(cell: string, f: ColumnFilter): boolean {
  switch (f.kind) {
    case "contains":
      return cell.toLowerCase().includes(f.value.toLowerCase());
    case "equals":
      return cell.trim().toLowerCase() === f.value.trim().toLowerCase();
    case "empty":
      return cell.trim() === "";
    case "notEmpty":
      return cell.trim() !== "";
    default: {
      const n = toNumber(cell);
      if (Number.isNaN(n)) return false;
      if (f.kind === "gt") return n > f.value;
      if (f.kind === "gte") return n >= f.value;
      if (f.kind === "lt") return n < f.value;
      return n <= f.value;
    }
  }
}

/** Indexes of rows matching every column filter (AND). */
export function filterRows(rows: string[][], filters: ReadonlyMap<number, ColumnFilter>): number[] {
  const out: number[] = [];
  const entries = [...filters];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] ?? [];
    if (entries.every(([col, f]) => matchesFilter(row[col] ?? "", f))) out.push(i);
  }
  return out;
}

export interface ColumnStats {
  count: number;
  empty: number;
  numeric: number;
  /** "number" when ≥ 90 % of non-empty cells parse as numbers. */
  type: "number" | "text" | "empty";
  distinct: number;
  /** True when distinct counting stopped at the cap. */
  distinctCapped: boolean;
  sum?: number;
  mean?: number;
  min?: number;
  max?: number;
}

export function columnStats(
  rows: string[][],
  col: number,
  indexes?: readonly number[],
  distinctCap = 10_000,
): ColumnStats {
  let empty = 0;
  let numeric = 0;
  let sum = 0;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  const distinct = new Set<string>();
  let capped = false;
  const count = indexes?.length ?? rows.length;
  for (let k = 0; k < count; k++) {
    const cell = rows[indexes === undefined ? k : (indexes[k] ?? 0)]?.[col] ?? "";
    if (cell.trim() === "") {
      empty++;
      continue;
    }
    if (!capped) {
      distinct.add(cell);
      if (distinct.size >= distinctCap) capped = true;
    }
    const n = toNumber(cell);
    if (!Number.isNaN(n)) {
      numeric++;
      sum += n;
      if (n < min) min = n;
      if (n > max) max = n;
    }
  }
  const filled = count - empty;
  const type = filled === 0 ? "empty" : numeric / filled >= 0.9 ? "number" : "text";
  const stats: ColumnStats = {
    count,
    empty,
    numeric,
    type,
    distinct: distinct.size,
    distinctCapped: capped,
  };
  if (numeric > 0) {
    stats.sum = sum;
    stats.mean = sum / numeric;
    stats.min = min;
    stats.max = max;
  }
  return stats;
}
