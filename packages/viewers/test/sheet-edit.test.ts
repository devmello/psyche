import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import {
  editableSheetFormat,
  fromUniverSnapshot,
  MAX_EDIT_CELLS,
  toUniverSnapshot,
  UNIVER_CELL,
} from "../src/core/sheet-edit.ts";

function sampleXlsx(): Uint8Array {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([
    ["Item", "Amount", "Paid"],
    ["Rent", 1200, true],
    ["Food", 345.5, false],
  ]);
  ws.B2 = { ...ws.B2, z: "$#,##0.00" } as XLSX.CellObject;
  ws.B4 = { t: "n", v: 1545.5, f: "SUM(B2:B3)" };
  ws.A4 = { t: "s", v: "Total" };
  ws["!ref"] = "A1:C4";
  ws["!merges"] = [{ s: { r: 5, c: 0 }, e: { r: 5, c: 2 } }];
  ws["!cols"] = [{ wpx: 120 }];
  XLSX.utils.book_append_sheet(wb, ws, "Budget");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["notes"]]), "Notes");
  return new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer);
}

describe("sheet edit bridge (SheetJS ⇄ Univer snapshot)", () => {
  it("knows which files it can write back", () => {
    expect(editableSheetFormat("a.xlsx")).toBe("xlsx");
    expect(editableSheetFormat("a.CSV")).toBe("csv");
    expect(editableSheetFormat("a.xlsm")).toBeUndefined();
    expect(editableSheetFormat("a.numbers")).toBeUndefined();
  });

  it("maps values, types, formulas, formats, merges and widths into the snapshot", async () => {
    const { data, format } = await toUniverSnapshot(sampleXlsx(), "budget.xlsx");
    expect(format).toBe("xlsx");
    expect(data.sheetOrder).toHaveLength(2);
    const budget = data.sheets[data.sheetOrder[0] as string];
    expect(budget?.name).toBe("Budget");
    const cells = budget?.cellData as Record<number, Record<number, Record<string, unknown>>>;
    expect(cells[0]?.[0]).toEqual({ v: "Item", t: UNIVER_CELL.STRING });
    expect(cells[1]?.[2]).toEqual({ v: true, t: UNIVER_CELL.BOOLEAN });
    expect(cells[3]?.[1]).toMatchObject({ f: "=SUM(B2:B3)", v: 1545.5 });
    const styleId = cells[1]?.[1]?.s as string;
    expect(data.styles[styleId]?.n?.pattern).toBe("$#,##0.00");
    expect(budget?.mergeData).toEqual([{ startRow: 5, startColumn: 0, endRow: 5, endColumn: 2 }]);
    expect(budget?.columnData?.[0]?.w).toBe(120);
  });

  it("round-trips an xlsx through Univer's snapshot without losing data", async () => {
    const snap = await toUniverSnapshot(sampleXlsx(), "budget.xlsx");
    // An edit as Univer would record it: a new value and a rich-text cell typed by the user.
    const budget = snap.data.sheets[snap.data.sheetOrder[0] as string];
    const cells = budget?.cellData as Record<number, Record<number, Record<string, unknown>>>;
    (cells[2] as Record<number, unknown>)[1] = { v: 400, t: UNIVER_CELL.NUMBER };
    cells[6] = { 0: { p: { body: { dataStream: "typed note\r\n" } } } };
    const out = await fromUniverSnapshot(snap.data, snap.format);
    const wb = XLSX.read(out, { type: "array", cellFormula: true, cellNF: true, cellStyles: true });
    expect(wb.SheetNames).toEqual(["Budget", "Notes"]);
    const ws = wb.Sheets.Budget as XLSX.WorkSheet;
    expect(ws.A1?.v).toBe("Item");
    expect(ws.C2?.v).toBe(true);
    expect(ws.B3?.v).toBe(400);
    expect(ws.B4?.f).toBe("SUM(B2:B3)");
    expect(ws.B2?.z).toBe("$#,##0.00");
    expect(ws.A7?.v).toBe("typed note");
    expect(ws["!merges"]).toEqual([{ s: { r: 5, c: 0 }, e: { r: 5, c: 2 } }]);
    expect(ws["!cols"]?.[0]?.wpx).toBe(120);
    expect((wb.Sheets.Notes as XLSX.WorkSheet).A1?.v).toBe("notes");
  });

  it("round-trips a CSV byte for byte, keeping text like 007 and 1.50", async () => {
    const csv = 'name,code,price,note\nWidget,007,1.50,"a, b"\nGadget,12,3,"say ""hi"""\n';
    const snap = await toUniverSnapshot(new TextEncoder().encode(csv), "items.csv");
    const cells = snap.data.sheets["sheet-1"]?.cellData as Record<
      number,
      Record<number, Record<string, unknown>>
    >;
    expect(cells[1]?.[1]).toEqual({ v: "007", t: UNIVER_CELL.STRING });
    expect(cells[2]?.[1]).toEqual({ v: 12, t: UNIVER_CELL.NUMBER });
    const out = await fromUniverSnapshot(snap.data, "csv");
    expect(new TextDecoder().decode(out)).toBe(csv);
  });

  it("writes TSV with tabs", async () => {
    const tsv = "a\tb\n1\tx y\n";
    const snap = await toUniverSnapshot(new TextEncoder().encode(tsv), "t.tsv");
    expect(new TextDecoder().decode(await fromUniverSnapshot(snap.data, "tsv"))).toBe(tsv);
  });

  it("refuses sheets too large for the editor", async () => {
    const wb = XLSX.utils.book_new();
    const ws: XLSX.WorkSheet = { A1: { t: "s", v: "x" } };
    ws["!ref"] = `A1:Z${Math.ceil(MAX_EDIT_CELLS / 26) + 1}`;
    XLSX.utils.book_append_sheet(wb, ws, "Big");
    const bytes = new Uint8Array(
      XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer,
    );
    await expect(toUniverSnapshot(bytes, "big.xlsx")).rejects.toThrow(/too large to edit/);
  });
});
