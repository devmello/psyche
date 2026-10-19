import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import {
  applyFormulas,
  editableSheetFormat,
  fromUniverSnapshot,
  MAX_EDIT_CELLS,
  toUniverSnapshot,
  UNIVER_CELL,
  uniqueSheetName,
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
    const out = await fromUniverSnapshot(snap.data, "csv", snap.carry);
    expect(new TextDecoder().decode(out)).toBe(csv);
  });

  it("never rewrites long numbers in General format", async () => {
    const csv = "id,ratio\n123456789012345,0.1234567890123\n1234567890123456789,-0.5\n";
    const snap = await toUniverSnapshot(new TextEncoder().encode(csv), "ids.csv");
    expect(new TextDecoder().decode(await fromUniverSnapshot(snap.data, "csv", snap.carry))).toBe(
      csv,
    );
  });

  it("keeps the CSV dialect: delimiter, BOM, CRLF and a missing final newline", async () => {
    const csv = "\uFEFFa;b\r\n1;x, y\r\n2;z";
    const snap = await toUniverSnapshot(new TextEncoder().encode(csv), "semi.csv");
    expect(snap.carry.csv).toEqual({ delimiter: ";", bom: true, eol: "\r\n", finalNewline: false });
    const out = await fromUniverSnapshot(snap.data, "csv", snap.carry);
    expect(new TextDecoder("utf-8", { ignoreBOM: true }).decode(out)).toBe(csv);
  });

  it("carries hidden rows, columns and sheets, defined names and the 1904 date system", async () => {
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([
      [1, 2],
      [3, 4],
    ]);
    ws["!rows"] = [{ hidden: true }];
    ws["!cols"] = [{}, { hidden: true }];
    ws.A3 = { t: "n", v: 4, f: "SUM(Total)" };
    ws["!ref"] = "A1:B3";
    XLSX.utils.book_append_sheet(wb, ws, "Data");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["x"]]), "Secret");
    wb.Workbook = {
      Names: [{ Name: "Total", Ref: "Data!$A$1:$A$2" }],
      Sheets: [{ Hidden: 0 }, { Hidden: 1 }],
      WBProps: { date1904: true },
    };
    const bytes = new Uint8Array(
      XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer,
    );
    const snap = await toUniverSnapshot(bytes, "names.xlsx");
    expect(snap.loss.names).toBe(true);
    const data = snap.data.sheets["sheet-1"];
    expect(data?.rowData?.[0]?.hd).toBe(1);
    expect(data?.columnData?.[1]?.hd).toBe(1);
    expect(snap.data.sheets["sheet-2"]?.hidden).toBe(1);

    const back = XLSX.read(await fromUniverSnapshot(snap.data, "xlsx", snap.carry), {
      type: "array",
      cellFormula: true,
      cellStyles: true,
    });
    expect(back.Workbook?.Names?.map((n) => [n.Name, n.Ref])).toEqual([
      ["Total", "Data!$A$1:$A$2"],
    ]);
    expect(back.Workbook?.WBProps?.date1904).toBe(true);
    expect(back.Workbook?.Sheets?.map((s) => s.Hidden)).toEqual([0, 1]);
    const d = back.Sheets.Data as XLSX.WorkSheet;
    expect(d["!rows"]?.[0]?.hidden).toBe(true);
    expect(d["!cols"]?.[1]?.hidden).toBe(true);
    expect(d.A3?.f).toBe("SUM(Total)");
  });

  it("flags hyperlinks and array formulas it cannot keep", async () => {
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([["site", 1]]);
    (ws.A1 as XLSX.CellObject).l = { Target: "https://example.com" };
    ws.C1 = { t: "n", v: 1, f: "B1*1", F: "C1:C1" };
    ws["!ref"] = "A1:C1";
    XLSX.utils.book_append_sheet(wb, ws, "S");
    const bytes = new Uint8Array(
      XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer,
    );
    const snap = await toUniverSnapshot(bytes, "l.xlsx");
    expect(snap.loss).toMatchObject({ links: true, arrays: true });
  });

  it("writes resolved shared formulas instead of their cached values", async () => {
    const snap = await toUniverSnapshot(new TextEncoder().encode("1\n2\n"), "f.csv");
    const cells = snap.data.sheets["sheet-1"]?.cellData as Record<
      number,
      Record<number, Record<string, unknown>>
    >;
    // What Univer leaves after dragging B1's formula down: B2 has `si` and a value, no `f`.
    (cells[0] as Record<number, unknown>)[1] = {
      f: "=A1*2",
      si: "s1",
      v: 2,
      t: UNIVER_CELL.NUMBER,
    };
    (cells[1] as Record<number, unknown>)[1] = { si: "s1", v: 4, t: UNIVER_CELL.NUMBER };
    applyFormulas(snap.data, "sheet-1", [
      ["", "=A1*2"],
      ["", "=A2*2"],
    ]);
    const back = XLSX.read(await fromUniverSnapshot(snap.data, "xlsx"), {
      type: "array",
      cellFormula: true,
    });
    const ws = back.Sheets[back.SheetNames[0] as string] as XLSX.WorkSheet;
    expect(ws.B1?.f).toBe("A1*2");
    expect(ws.B2?.f).toBe("A2*2");
    expect(ws.B2?.v).toBe(4);
  });

  it("makes sheet names Excel accepts", () => {
    expect(uniqueSheetName([], "'quoted'")).toBe("quoted");
    expect(uniqueSheetName(["Data"], "data")).toBe("data (2)");
    const long = "x".repeat(40);
    const taken = [
      long.slice(0, 31),
      ...Array.from({ length: 8 }, (_, i) => `${"x".repeat(27)} (${i + 2})`),
    ];
    const name = uniqueSheetName(taken, long);
    expect(name.length).toBeLessThanOrEqual(31);
    expect(name).toBe(`${"x".repeat(26)} (10)`);
    expect(uniqueSheetName([], "a/b:c")).toBe("a_b_c");
  });

  it("writes TSV with tabs", async () => {
    const tsv = "a\tb\n1\tx y\n";
    const snap = await toUniverSnapshot(new TextEncoder().encode(tsv), "t.tsv");
    expect(new TextDecoder().decode(await fromUniverSnapshot(snap.data, "tsv", snap.carry))).toBe(
      tsv,
    );
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
