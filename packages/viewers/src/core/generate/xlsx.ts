import type { CellObject, WorkSheet } from "xlsx";
import {
  assertLimit,
  fileName,
  GENERATOR_LIMITS,
  type GeneratedFile,
  GeneratorError,
  MIME,
  type SheetCell,
  type WorkbookSpec,
} from "./model.ts";

/**
 * XLSX generator on SheetJS CE (vendor tarball, ADR-013). Strings are always written as text
 * cells, so "=HYPERLINK(...)" from model output stays inert; formulas need an explicit
 * `{ formula }` cell. CE writes no cell styles: the header row is plain, with an autofilter.
 */

const BAD_SHEET_CHARS = /[\\/?*:[\]]/g;

/** Excel sheet names: ≤31 chars, none of \ / ? * : [ ], unique case-insensitively. */
export function sheetNames(names: string[]): string[] {
  const used = new Set<string>();
  return names.map((raw, i) => {
    const base =
      raw
        .replace(BAD_SHEET_CHARS, " ")
        .replace(/^'+|'+$/g, "")
        .trim()
        .slice(0, 31) || `Sheet${i + 1}`;
    let name = base;
    for (let n = 2; used.has(name.toLowerCase()); n++) {
      const suffix = ` (${n})`;
      name = `${base.slice(0, 31 - suffix.length)}${suffix}`;
    }
    used.add(name.toLowerCase());
    return name;
  });
}

function toCell(v: SheetCell, format: string | null | undefined): CellObject | undefined {
  if (v === null) return undefined;
  if (typeof v === "object") {
    const f = v.formula.replace(/^=/, "");
    if (f === "" || /[\r\n]/.test(f)) throw new GeneratorError("Invalid formula");
    return { t: "n", f };
  }
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return { t: "s", v: String(v) };
    return format ? { t: "n", v, z: format } : { t: "n", v };
  }
  if (typeof v === "boolean") return { t: "b", v };
  return { t: "s", v };
}

export async function generateXlsx(spec: WorkbookSpec): Promise<GeneratedFile> {
  assertLimit(spec.sheets.length, GENERATOR_LIMITS.sheets, "sheets");
  if (spec.sheets.length === 0) throw new GeneratorError("A workbook needs at least one sheet");
  const XLSX = await import("xlsx");
  const wb = XLSX.utils.book_new();
  wb.Props = { Title: spec.title, Author: "Psyche" };
  const names = sheetNames(spec.sheets.map((s) => s.name));
  spec.sheets.forEach((sheet, si) => {
    assertLimit(sheet.rows.length, GENERATOR_LIMITS.sheetRows, "rows");
    const width = Math.max(sheet.columns.length, ...sheet.rows.map((r) => r.length), 1);
    const ws: WorkSheet = {};
    sheet.columns.forEach((c, ci) => {
      ws[XLSX.utils.encode_cell({ r: 0, c: ci })] = { t: "s", v: c };
    });
    sheet.rows.forEach((row, ri) => {
      row.forEach((v, ci) => {
        const cell = toCell(v, sheet.formats?.[ci]);
        if (cell !== undefined) ws[XLSX.utils.encode_cell({ r: ri + 1, c: ci })] = cell;
      });
    });
    const ref = XLSX.utils.encode_range({
      s: { r: 0, c: 0 },
      e: { r: sheet.rows.length, c: width - 1 },
    });
    ws["!ref"] = ref;
    if (sheet.columns.length > 0) ws["!autofilter"] = { ref };
    ws["!cols"] = Array.from({ length: width }, (_, ci) => {
      const explicit = sheet.widths?.[ci];
      if (explicit !== undefined) return { wch: explicit };
      let wch = (sheet.columns[ci] ?? "").length;
      for (const row of sheet.rows.slice(0, 200)) {
        const v = row[ci];
        if (v !== null && v !== undefined && typeof v !== "object")
          wch = Math.max(wch, String(v).length);
      }
      return { wch: Math.min(60, Math.max(8, wch + 2)) };
    });
    XLSX.utils.book_append_sheet(wb, ws, names[si]);
  });
  const out = XLSX.write(wb, { type: "array", bookType: "xlsx", compression: true }) as ArrayBuffer;
  return { name: fileName(spec.title, "xlsx"), mime: MIME.xlsx, bytes: new Uint8Array(out) };
}
