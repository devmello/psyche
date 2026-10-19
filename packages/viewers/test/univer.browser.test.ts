/**
 * Real Univer in Chrome (P3 edit mode): the lazily loaded runtime mounts a snapshot built by the
 * SheetJS bridge, a typed edit recalculates formulas, the edited snapshot writes back to xlsx,
 * and nothing is fetched from any other host under a strict app CSP. Skipped without Chrome.
 */
import { fileURLToPath } from "node:url";
import { type Browser, chromium } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { fromUniverSnapshot, toUniverSnapshot } from "../src/core/sheet-edit.ts";
import { bundleForBrowser, chrome, type Srv, serve, staticHandler } from "./support/chrome.ts";

const APP_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'none'",
  "worker-src 'none'",
].join("; ");

const page = (title: string) =>
  `<!doctype html><html><head><title>${title}</title><link rel="stylesheet" href="/univer-harness.css"></head>
<body style="margin:0"><div id="app" style="width:1000px;height:600px"></div>
<script type="module" src="/univer-harness.js"></script></body></html>`;

describe.skipIf(chrome === undefined)("Univer sheet editor in Chrome", () => {
  let browser: Browser;
  let app: Srv;

  beforeAll(async () => {
    const dir = await bundleForBrowser(
      fileURLToPath(new URL("./fixtures/univer-harness.ts", import.meta.url)),
    );
    const files = staticHandler(dir);
    app = await serve((path, res) => {
      if (path === "/") {
        res.writeHead(200, { "Content-Type": "text/html", "Content-Security-Policy": APP_CSP });
        res.end(page("univer"));
        return;
      }
      void files(path, res);
    });
    browser = await chromium.launch({ executablePath: chrome, headless: true });
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    app?.server.close();
  });

  it("edits a cell, recalculates, and saves back to xlsx with no external request", async () => {
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([[1], [2]]);
    ws.A3 = { t: "n", v: 3, f: "A1+A2" };
    ws["!ref"] = "A1:A3";
    XLSX.utils.book_append_sheet(wb, ws, "Data");
    const bytes = new Uint8Array(
      XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer,
    );
    const snap = await toUniverSnapshot(bytes, "data.xlsx");
    // A formula filled down column B, as Univer stores it: only B1 has `f`, the rest share `si`.
    const cells = snap.data.sheets["sheet-1"]?.cellData as Record<number, Record<number, unknown>>;
    (cells[0] as Record<number, unknown>)[1] = { f: "=A1*2", si: "fill1" };
    (cells[1] as Record<number, unknown>)[1] = { si: "fill1" };
    (cells[2] as Record<number, unknown>)[1] = { si: "fill1" };

    const tab = await browser.newPage({ viewport: { width: 1000, height: 600 } });
    const external: string[] = [];
    const errors: string[] = [];
    tab.on("request", (r) => {
      const u = r.url();
      if (!u.startsWith(app.origin) && !u.startsWith("data:") && !u.startsWith("blob:"))
        external.push(u);
    });
    tab.on("pageerror", (e) => errors.push(e.message));
    await tab.goto(`${app.origin}/`);
    await tab.waitForFunction(
      () => (window as unknown as { harness?: unknown }).harness !== undefined,
      undefined,
      { timeout: 60_000 },
    );
    await tab.evaluate(
      (d) =>
        (window as unknown as { harness: { mount(d: unknown): Promise<void> } }).harness.mount(d),
      snap.data,
    );
    type H = { harness: { changes: number } };
    const changes = () => tab.evaluate(() => (window as unknown as H).harness.changes);
    // Wait for the grid canvas to be laid out (slow CI runners take seconds), then let the
    // opening recalculation settle.
    await tab.waitForFunction(
      () =>
        [...document.querySelectorAll("canvas")].some((c) => {
          const r = c.getBoundingClientRect();
          return r.width > 400 && r.height > 300;
        }),
      undefined,
      { timeout: 60_000 },
    );
    await tab.waitForTimeout(1500);
    // Opening (formula recalculation, layout) is not an edit.
    expect(await changes()).toBe(0);

    // A1 sits right of the row header and below the column header on the grid canvas.
    const grid = await tab.evaluate(() => {
      const c = [...document.querySelectorAll("canvas")]
        .map((el) => el.getBoundingClientRect())
        .sort((a, b) => b.width * b.height - a.width * a.height)[0];
      return c === undefined ? undefined : { x: c.x, y: c.y };
    });
    expect(grid).toBeDefined();
    // The first click can land before Univer has focus wired up on a slow runner: retry.
    for (let attempt = 0; attempt < 6 && (await changes()) === 0; attempt++) {
      await tab.mouse.click((grid?.x ?? 0) + 90, (grid?.y ?? 0) + 33);
      await tab.waitForTimeout(300);
      await tab.keyboard.type("10");
      await tab.keyboard.press("Enter");
      await tab
        .waitForFunction(() => (window as unknown as H).harness.changes > 0, undefined, {
          timeout: 5_000,
        })
        .catch(() => undefined);
    }
    expect(await changes()).toBeGreaterThan(0);
    await tab.waitForTimeout(300);
    const edited = await tab.evaluate(() =>
      (window as unknown as { harness: { snapshot(): unknown } }).harness.snapshot(),
    );
    await tab.evaluate(() =>
      (window as unknown as { harness: { dispose(): void } }).harness.dispose(),
    );
    await tab.close();

    expect(errors).toEqual([]);
    const out = await fromUniverSnapshot(edited as typeof snap.data, "xlsx");
    const back = XLSX.read(out, { type: "array", cellFormula: true }).Sheets.Data as XLSX.WorkSheet;
    expect(back.A1?.v).toBe(10);
    expect(back.A3?.f).toBe("A1+A2");
    expect(back.A3?.v).toBe(12);
    expect([back.B1?.f, back.B2?.f, back.B3?.f]).toEqual(["A1*2", "A2*2", "A3*2"]);
    expect([back.B1?.v, back.B2?.v, back.B3?.v]).toEqual([20, 4, 24]);
    expect(external).toEqual([]);
  }, 180_000);
});
