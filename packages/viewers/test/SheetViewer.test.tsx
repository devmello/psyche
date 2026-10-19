// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as XLSX from "xlsx";
import { parseFilter } from "../src/core/sheet.ts";
import { SheetViewer } from "../src/react/SheetViewer.tsx";
import { budgetMs } from "./fixtures/budget.ts";
import { bigCsv } from "./fixtures/sheets.ts";

afterEach(cleanup);

// jsdom does no layout: give the grid's scroll box a pane-sized rectangle so the virtualizer
// renders a realistic window.
const realRect = HTMLElement.prototype.getBoundingClientRect;
beforeAll(() => {
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    return this.dataset.testid === "sheet-scroll"
      ? ({
          x: 0,
          y: 0,
          top: 0,
          left: 0,
          right: 960,
          bottom: 600,
          width: 960,
          height: 600,
          toJSON() {},
        } as DOMRect)
      : realRect.call(this);
  };
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return this.dataset.testid === "sheet-scroll" ? 600 : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get(this: HTMLElement) {
      return this.dataset.testid === "sheet-scroll" ? 960 : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return this.dataset.testid === "sheet-scroll" ? 600 : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get(this: HTMLElement) {
      return this.dataset.testid === "sheet-scroll" ? 960 : 0;
    },
  });
});
afterAll(() => {
  HTMLElement.prototype.getBoundingClientRect = realRect;
  for (const k of ["clientHeight", "clientWidth", "offsetHeight"])
    Reflect.deleteProperty(HTMLElement.prototype, k);
  Reflect.deleteProperty(HTMLElement.prototype, "offsetWidth");
});

const csvItem = {
  id: "tx",
  name: "transactions.csv",
  mime: "text/csv",
  provenance: "trusted" as const,
};

describe("SheetViewer", () => {
  it("opens a 50k-row CSV in under 2 s and renders only a window of rows", async () => {
    const bytes = new TextEncoder().encode(bigCsv(50_000));
    const t0 = performance.now();
    render(<SheetViewer item={csvItem} load={async () => bytes} />);
    await screen.findByText("50,000 rows");
    expect(performance.now() - t0).toBeLessThan(budgetMs(2000));
    const rows = screen.getAllByRole("row");
    expect(rows.length).toBeGreaterThan(5);
    expect(rows.length).toBeLessThan(80);
    expect(screen.getByRole("table").getAttribute("aria-rowcount")).toBe("50001");
  });

  it("filters by column and shows column stats", async () => {
    render(<SheetViewer item={csvItem} load={async () => new TextEncoder().encode(bigCsv(100))} />);
    await screen.findByText("100 rows");
    fireEvent.change(screen.getByLabelText("Filter category"), { target: { value: "=Rent" } });
    await screen.findByText("20 of 100 rows");
    fireEvent.change(screen.getByLabelText("Filter amount"), { target: { value: ">50" } });
    await waitFor(() =>
      expect(screen.getByText(/of 100 rows/).textContent).not.toBe("20 of 100 rows"),
    );
    fireEvent.click(screen.getByText("Clear filters"));
    await screen.findByText("100 rows");
    fireEvent.click(screen.getByRole("button", { name: /amount/ }));
    const stats = await screen.findByLabelText("Stats for amount");
    expect(within(stats).getByText("number")).toBeTruthy();
    expect(within(stats).getAllByText("100").length).toBeGreaterThan(0);
    expect(within(stats).getByText("Sum")).toBeTruthy();
  });

  it("switches sheet tabs in an XLSX workbook and reports cell selections", async () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet([
        ["Item", "Qty"],
        ["Apples", 3],
      ]),
      "Groceries",
    );
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet([
        ["Month", "Total"],
        ["Jan", 120],
      ]),
      "Summary",
    );
    const bytes = new Uint8Array(
      XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer,
    );
    const onSelectionChange = vi.fn();
    const onPageStateChange = vi.fn();
    render(
      <SheetViewer
        item={{
          id: "b",
          name: "budget.xlsx",
          mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          provenance: "trusted",
        }}
        load={async () => bytes}
        onSelectionChange={onSelectionChange}
        onPageStateChange={onPageStateChange}
      />,
    );
    expect(await screen.findByText("Apples")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Summary" }));
    expect(await screen.findByText("Jan")).toBeTruthy();
    expect(onPageStateChange).toHaveBeenCalledWith({ sheet: "Summary" });
    fireEvent.focus(screen.getByText("120"));
    expect(onSelectionChange).toHaveBeenCalledWith({
      kind: "cells",
      sheet: "Summary",
      range: "B2",
      text: "120",
    });
  });

  it("parses the filter syntax", () => {
    expect(parseFilter(">= 1,000")).toEqual({ kind: "gte", value: 1000 });
    expect(parseFilter("=Rent")).toEqual({ kind: "equals", value: "Rent" });
    expect(parseFilter("!empty")).toEqual({ kind: "notEmpty" });
    expect(parseFilter("> abc")).toEqual({ kind: "contains", value: "> abc" });
    expect(parseFilter("  ")).toBeUndefined();
  });
});
