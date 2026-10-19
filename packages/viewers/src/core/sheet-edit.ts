import type { ICellData, IStyleData, IWorkbookData, IWorksheetData } from "@univerjs/core";
import type { CellObject, WorkSheet } from "xlsx";
import { parseCsv } from "./csv.ts";
import { extensionOf } from "./registry.ts";

/**
 * Spreadsheet editing bridge (P3 edit mode, ADR-013). Univer's open-source core has no xlsx
 * import/export (that is a Pro feature), so files go through SheetJS CE both ways:
 * bytes → SheetJS → Univer `IWorkbookData` snapshot → (user edits in Univer) → snapshot →
 * SheetJS → bytes. Kept: values and their types, formulas (with Univer's cached results),
 * number formats, merges, column widths, row heights, sheet order and names. Dropped (Univer
 * would need Pro or SheetJS Pro to carry them): fonts, fills, borders, charts, pivots, images,
 * comments, data validation, conditional formatting. The editor says so before the first save.
 *
 * DOM-free: the Gateway and tests use it without Univer's UI. Type-only imports from
 * `@univerjs/core`, so nothing of Univer is bundled from here.
 */

/** Univer's `CellValueType` (values copied so this module stays type-only on Univer). */
export const UNIVER_CELL = { STRING: 1, NUMBER: 2, BOOLEAN: 3, FORCE_STRING: 4 } as const;

/** Formats the editor can read and write back to the same file. */
/** Not xlsm: SheetJS CE would drop the macros on write. */
export type EditableSheetFormat = "xlsx" | "xls" | "ods" | "csv" | "tsv";

export const EDITABLE_SHEET_FORMATS: readonly EditableSheetFormat[] = [
  "xlsx",
  "xls",
  "ods",
  "csv",
  "tsv",
];

/** Univer keeps every cell as an object; past this the editor refuses and the viewer stays. */
export const MAX_EDIT_CELLS = 2_000_000;

export function editableSheetFormat(name: string): EditableSheetFormat | undefined {
  const ext = extensionOf(name);
  return (EDITABLE_SHEET_FORMATS as readonly string[]).includes(ext)
    ? (ext as EditableSheetFormat)
    : undefined;
}

/** What `toUniverSnapshot` could not carry, shown before the first save. */
export interface SnapshotLoss {
  styled: boolean;
  comments: boolean;
  images: boolean;
}

export interface UniverSnapshot {
  data: IWorkbookData;
  format: EditableSheetFormat;
  loss: SnapshotLoss;
}

const MIN_ROWS = 100;
const MIN_COLS = 26;
const sheetId = (i: number) => `sheet-${i + 1}`;

/** Plain decimal numbers keep their exact text when written back to CSV ("007" and "1.50" don't). */
function csvCell(raw: string): ICellData | undefined {
  if (raw === "") return undefined;
  if (/^-?(0|[1-9]\d{0,14})(\.\d*[1-9])?$/.test(raw) && String(Number(raw)) === raw) {
    return { v: Number(raw), t: UNIVER_CELL.NUMBER };
  }
  return { v: raw, t: UNIVER_CELL.STRING };
}

function emptySheet(
  id: string,
  name: string,
  rows: number,
  cols: number,
): Partial<IWorksheetData> & { cellData: Record<number, Record<number, ICellData>> } {
  return {
    id,
    name,
    rowCount: Math.max(rows + 20, MIN_ROWS),
    columnCount: Math.max(cols + 5, MIN_COLS),
    cellData: {},
    mergeData: [],
    rowData: {},
    columnData: {},
  };
}

function snapshotShell(name: string): IWorkbookData {
  return {
    id: "psyche-workbook",
    name,
    appVersion: "1.0.3",
    // LocaleType.EN_US; the editor sets the UI locale itself.
    locale: "enUS" as IWorkbookData["locale"],
    styles: {},
    sheetOrder: [],
    sheets: {},
  };
}

function guardCells(count: number): void {
  if (count > MAX_EDIT_CELLS) {
    throw new RangeError(`too large to edit (${count} cells, limit ${MAX_EDIT_CELLS})`);
  }
}

/** Reads a CSV, TSV or any SheetJS-readable workbook into a Univer snapshot. */
export async function toUniverSnapshot(bytes: Uint8Array, name: string): Promise<UniverSnapshot> {
  const format = editableSheetFormat(name);
  if (format === undefined) throw new TypeError(`not an editable sheet: ${name}`);
  const title = name.replace(/\.[^.]+$/, "") || "Sheet1";
  const data = snapshotShell(title);
  const loss: SnapshotLoss = { styled: false, comments: false, images: false };

  if (format === "csv" || format === "tsv") {
    const parsed = parseCsv(new TextDecoder("utf-8").decode(bytes), {
      ...(format === "tsv" ? { delimiter: "\t" } : {}),
    });
    const cols = parsed.rows.reduce((m, r) => Math.max(m, r.length), 0);
    guardCells(parsed.rows.length * cols);
    const ws = emptySheet(sheetId(0), title, parsed.rows.length, cols);
    parsed.rows.forEach((row, r) => {
      row.forEach((raw, c) => {
        const cell = csvCell(raw);
        if (cell !== undefined) (ws.cellData[r] ??= {})[c] = cell;
      });
    });
    data.sheetOrder.push(ws.id as string);
    data.sheets[ws.id as string] = ws;
    return { data, format, loss };
  }

  // SheetJS CE from the vendor tarball (ADR-013), loaded lazily like the viewer does.
  const XLSX = await import("xlsx");
  const wb = XLSX.read(bytes, {
    type: "array",
    dense: true,
    cellFormula: true,
    cellNF: true,
    cellStyles: true,
    cellDates: false,
    cellHTML: false,
  });
  const patterns = new Map<string, string>();
  wb.SheetNames.forEach((sheetName, i) => {
    const src = wb.Sheets[sheetName];
    if (src === undefined) return;
    const range = src["!ref"] === undefined ? undefined : XLSX.utils.decode_range(src["!ref"]);
    const rows = range === undefined ? 0 : range.e.r + 1;
    const cols = range === undefined ? 0 : range.e.c + 1;
    guardCells(rows * cols);
    const ws = emptySheet(sheetId(i), sheetName, rows, cols);
    const dense = (src["!data"] ?? []) as (CellObject | undefined)[][];
    dense.forEach((row, r) => {
      row?.forEach((cell, c) => {
        if (cell === undefined) return;
        const out = fromSheetJsCell(cell, patterns, data.styles);
        if (cell.c !== undefined && cell.c.length > 0) loss.comments = true;
        const s = (cell as { s?: Record<string, unknown> }).s;
        if (s !== undefined && Object.keys(s).some((k) => k !== "patternType")) loss.styled = true;
        if (out !== undefined) (ws.cellData[r] ??= {})[c] = out;
      });
    });
    for (const m of src["!merges"] ?? []) {
      ws.mergeData?.push({
        startRow: m.s.r,
        startColumn: m.s.c,
        endRow: m.e.r,
        endColumn: m.e.c,
      });
    }
    (src["!cols"] ?? []).forEach((col, c) => {
      if (col?.wpx !== undefined) (ws.columnData as Record<number, { w: number }>)[c] = { w: col.wpx };
    });
    (src["!rows"] ?? []).forEach((row, r) => {
      if (row?.hpx !== undefined) (ws.rowData as Record<number, { h: number }>)[r] = { h: row.hpx };
    });
    if ((src as { "!images"?: unknown[] })["!images"]?.length) loss.images = true;
    data.sheetOrder.push(ws.id as string);
    data.sheets[ws.id as string] = ws;
  });
  return { data, format, loss };
}

function fromSheetJsCell(
  cell: CellObject,
  patterns: Map<string, string>,
  styles: IWorkbookData["styles"],
): ICellData | undefined {
  const out: ICellData = {};
  switch (cell.t) {
    case "n":
      if (typeof cell.v === "number") {
        out.v = cell.v;
        out.t = UNIVER_CELL.NUMBER;
      }
      break;
    case "b":
      out.v = cell.v === true;
      out.t = UNIVER_CELL.BOOLEAN;
      break;
    case "s":
      if (cell.v !== undefined && cell.v !== "") {
        out.v = String(cell.v);
        out.t = UNIVER_CELL.STRING;
      }
      break;
    case "e":
      out.v = cell.w ?? "#N/A";
      out.t = UNIVER_CELL.STRING;
      break;
    case "d":
      // cellDates is off, so dates arrive as serial numbers; kept for completeness.
      out.v = String(cell.v);
      out.t = UNIVER_CELL.STRING;
      break;
    default:
      break;
  }
  if (cell.f !== undefined && cell.f !== "") out.f = `=${cell.f}`;
  const z = typeof cell.z === "string" ? cell.z : undefined;
  if (z !== undefined && z !== "General" && out.t === UNIVER_CELL.NUMBER) {
    let id = patterns.get(z);
    if (id === undefined) {
      id = `nf${patterns.size + 1}`;
      patterns.set(z, id);
      styles[id] = { n: { pattern: z } };
    }
    out.s = id;
  }
  return out.v === undefined && out.f === undefined ? undefined : out;
}

function styleOf(data: IWorkbookData, s: ICellData["s"]): IStyleData | undefined {
  if (s === undefined || s === null) return undefined;
  if (typeof s === "string") return data.styles[s] ?? undefined;
  return s;
}

/** Plain text of a Univer cell, including rich-text (`p`) cells the user typed into. */
function cellText(cell: ICellData): string | undefined {
  if (cell.v !== undefined && cell.v !== null) return String(cell.v);
  const body = cell.p?.body?.dataStream;
  return body === undefined ? undefined : body.replace(/\r?\n$/, "").replace(/\r\n?/g, "\n");
}

function toSheetJsCell(data: IWorkbookData, cell: ICellData): CellObject | undefined {
  const f = typeof cell.f === "string" && cell.f.startsWith("=") ? cell.f.slice(1) : undefined;
  const text = cellText(cell);
  let out: CellObject | undefined;
  if (cell.t === UNIVER_CELL.BOOLEAN || typeof cell.v === "boolean") {
    out = { t: "b", v: cell.v === true || cell.v === 1 || cell.v === "TRUE" };
  } else if (
    (cell.t === UNIVER_CELL.NUMBER || cell.t === undefined || cell.t === null) &&
    typeof cell.v === "number"
  ) {
    out = { t: "n", v: cell.v };
  } else if (text !== undefined) {
    out = { t: "s", v: text };
  } else if (f !== undefined) {
    out = { t: "z" } as CellObject;
  }
  if (out === undefined) return undefined;
  if (f !== undefined) out.f = f;
  const pattern = styleOf(data, cell.s)?.n?.pattern;
  if (pattern !== undefined && out.t === "n") out.z = pattern;
  return out;
}

/** Writes a snapshot back to the file's own format. CSV/TSV write the first sheet's values. */
export async function fromUniverSnapshot(
  data: IWorkbookData,
  format: EditableSheetFormat,
): Promise<Uint8Array> {
  const XLSX = await import("xlsx");
  const wb = XLSX.utils.book_new();
  for (const id of data.sheetOrder) {
    const src = data.sheets[id];
    if (src === undefined) continue;
    const ws: WorkSheet = {};
    let maxR = -1;
    let maxC = -1;
    const cells = (src.cellData ?? {}) as Record<string, Record<string, ICellData>>;
    for (const [rKey, row] of Object.entries(cells)) {
      const r = Number(rKey);
      for (const [cKey, cell] of Object.entries(row ?? {})) {
        const c = Number(cKey);
        const out = cell === null ? undefined : toSheetJsCell(data, cell);
        if (out === undefined) continue;
        ws[XLSX.utils.encode_cell({ r, c })] = out;
        if (r > maxR) maxR = r;
        if (c > maxC) maxC = c;
      }
    }
    if (maxR >= 0) ws["!ref"] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: maxR, c: maxC } });
    const merges = (src.mergeData ?? []).map((m) => ({
      s: { r: m.startRow, c: m.startColumn },
      e: { r: m.endRow, c: m.endColumn },
    }));
    if (merges.length > 0) ws["!merges"] = merges;
    const colData = (src.columnData ?? {}) as Record<string, { w?: number } | undefined>;
    const cols: { wpx?: number }[] = [];
    for (const [k, v] of Object.entries(colData)) if (v?.w !== undefined) cols[Number(k)] = { wpx: v.w };
    if (cols.length > 0) ws["!cols"] = Array.from(cols, (c) => c ?? {});
    const rowData = (src.rowData ?? {}) as Record<string, { h?: number } | undefined>;
    const rows: { hpx?: number }[] = [];
    for (const [k, v] of Object.entries(rowData)) if (v?.h !== undefined) rows[Number(k)] = { hpx: v.h };
    if (rows.length > 0) ws["!rows"] = Array.from(rows, (r) => r ?? {});
    XLSX.utils.book_append_sheet(wb, ws, uniqueSheetName(wb.SheetNames, src.name ?? id));
  }
  if (wb.SheetNames.length === 0) XLSX.utils.book_append_sheet(wb, {}, "Sheet1");

  if (format === "csv" || format === "tsv") {
    const first = wb.Sheets[wb.SheetNames[0] as string] as WorkSheet;
    const text = XLSX.utils.sheet_to_csv(first, {
      FS: format === "tsv" ? "\t" : ",",
      blankrows: true,
      strip: false,
    });
    return new TextEncoder().encode(text.length > 0 ? `${text}\n` : text);
  }
  const bookType = format === "xls" ? "biff8" : format;
  const out = XLSX.write(wb, { type: "array", bookType, compression: true }) as ArrayBuffer;
  return new Uint8Array(out);
}

function uniqueSheetName(taken: string[], wanted: string): string {
  // Excel: ≤ 31 chars, none of : \ / ? * [ ].
  const base = wanted.replace(/[:\\/?*[\]]/g, "_").slice(0, 31) || "Sheet";
  let name = base;
  for (let i = 2; taken.includes(name); i++) name = `${base.slice(0, 28)} (${i})`;
  return name;
}

export const SHEET_MIME: Record<EditableSheetFormat, string> = {
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xls: "application/vnd.ms-excel",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
};
