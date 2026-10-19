import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { parseCsv } from "../src/core/csv.ts";
import {
  cellRef,
  columnLetter,
  columnStats,
  filterRows,
  parseWorkbook,
  toNumber,
} from "../src/core/sheet.ts";
import { bigCsv } from "./fixtures/sheets.ts";

const enc = (s: string) => new TextEncoder().encode(s);

describe("CSV parser", () => {
  it("handles quotes, doubled quotes, CRLF, embedded newlines and trailing separators", () => {
    const r = parseCsv('a,b,c\r\n"x, y","he said ""hi""","line1\nline2"\r\n1,,\n');
    expect(r.rows).toEqual([
      ["a", "b", "c"],
      ["x, y", 'he said "hi"', "line1\nline2"],
      ["1", "", ""],
    ]);
  });

  it("detects tab and semicolon delimiters and strips the BOM", () => {
    expect(parseCsv("﻿a\tb\n1\t2").rows).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
    expect(parseCsv("a;b\n1;2").delimiter).toBe(";");
  });
});

describe("workbooks", () => {
  it("opens a 50k-row CSV in under 2 s (P3 budget)", async () => {
    const bytes = enc(bigCsv(50_000));
    const t0 = performance.now();
    const wb = await parseWorkbook(bytes, "transactions.csv");
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(2000);
    const sheet = wb.sheets[0];
    expect(sheet?.header).toEqual(["id", "date", "merchant", "category", "amount", "note"]);
    expect(sheet?.rows).toHaveLength(50_000);
    expect(sheet?.rows[0]?.[2]).toBe("Store 1, Inc.");
    expect(sheet?.rows[0]?.[5]).toBe('said "hi"');
  });

  it("reads XLSX sheets with formatted values via SheetJS CE", async () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet([
        ["Item", "Qty", "Price"],
        ["Apples", 3, 1.5],
        ["Pears", 2, 2.25],
      ]),
      "Groceries",
    );
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet([
        [1, 2],
        [3, 4],
      ]),
      "Numbers",
    );
    const bytes = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
    const parsed = await parseWorkbook(new Uint8Array(bytes), "book.xlsx");
    expect(parsed.source).toBe("xlsx");
    expect(parsed.sheets.map((s) => s.name)).toEqual(["Groceries", "Numbers"]);
    expect(parsed.sheets[0]?.header).toEqual(["Item", "Qty", "Price"]);
    expect(parsed.sheets[0]?.rows).toEqual([
      ["Apples", "3", "1.5"],
      ["Pears", "2", "2.25"],
    ]);
    expect(parsed.sheets[1]?.header).toBeNull();
    const [groceries, numbers] = parsed.sheets;
    if (groceries === undefined || numbers === undefined) throw new Error("missing sheets");
    expect(cellRef(groceries, 0, 1)).toBe("B2");
    expect(cellRef(numbers, 0, 1)).toBe("B1");
  });

  it("caps rows and reports truncation", async () => {
    const wb = await parseWorkbook(enc(bigCsv(100)), "x.csv", { maxRows: 10 });
    expect(wb.sheets[0]?.rows.length).toBe(10);
    expect(wb.sheets[0]?.truncated).toBe(true);
  });
});

describe("filters and stats", () => {
  const rows = [
    ["Rent", "1,200.00"],
    ["Dining", "$45"],
    ["Dining", "(10)"],
    ["Other", ""],
  ];

  it("parses money-ish numbers", () => {
    expect(toNumber("1,200.00")).toBe(1200);
    expect(toNumber("$45")).toBe(45);
    expect(toNumber("(10)")).toBe(-10);
    expect(toNumber("12%")).toBeCloseTo(0.12);
    expect(toNumber("12 apples")).toBeNaN();
  });

  it("filters rows with AND semantics", () => {
    const f = new Map([
      [0, { kind: "equals" as const, value: "dining" }],
      [1, { kind: "gt" as const, value: 0 }],
    ]);
    expect(filterRows(rows, f)).toEqual([1]);
  });

  it("computes column stats", () => {
    const s = columnStats(rows, 1);
    expect(s).toMatchObject({
      count: 4,
      empty: 1,
      numeric: 3,
      type: "number",
      sum: 1235,
      min: -10,
      max: 1200,
    });
    expect(columnStats(rows, 0)).toMatchObject({ type: "text", distinct: 3 });
  });

  it("names columns past Z", () => {
    expect([0, 25, 26, 701, 702].map(columnLetter)).toEqual(["A", "Z", "AA", "ZZ", "AAA"]);
  });
});
