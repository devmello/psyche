import { JSDOM } from "jsdom";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { extractText } from "../src/core/extract.ts";
import {
  chartSvg,
  type DocSpec,
  dashboardHtml,
  docToMarkdown,
  GENERATOR_LIMITS,
  GeneratorError,
  generateFile,
  generatePdf,
  generateXlsx,
  itineraryHtml,
  niceTicks,
  parseInline,
  sheetNames,
  templateArtifact,
} from "../src/core/generate/index.ts";
import { openPdf } from "../src/core/pdf.ts";
import { parseWorkbook } from "../src/core/sheet.ts";

const EVIL = `<script>alert(1)</script> & "q" [x](javascript:alert(1))`;

const report: DocSpec = {
  title: "Q3 Report",
  author: "Psyche",
  blocks: [
    { type: "heading", level: 1, text: "Summary" },
    { type: "paragraph", text: "Revenue grew **12%** with *steady* churn; see `report.csv`." },
    { type: "list", items: ["First point", "Second point"] },
    { type: "list", ordered: true, items: ["Step one", "Step two"] },
    {
      type: "table",
      columns: ["Region", "Revenue", "Active"],
      rows: [
        ["North", 1200.5, true],
        ["South | East", 980, false],
        ["West", null, true],
      ],
    },
    { type: "code", lang: "ts", text: "const x = 1;\n// ``` fence inside" },
    { type: "quote", text: "Quoted line" },
    {
      type: "chart",
      chart: {
        kind: "bar",
        title: "Revenue by month",
        labels: ["Jul", "Aug", "Sep"],
        series: [
          { name: "2025", values: [10, 12, 9] },
          { name: "2026", values: [11, 15, 14] },
        ],
      },
    },
    { type: "pageBreak" },
    { type: "paragraph", text: EVIL },
  ],
};

describe("generator model", () => {
  it("parses inline markers", () => {
    expect(parseInline("a **b** *c* `d` _e_")).toEqual([
      { text: "a " },
      { text: "b", bold: true },
      { text: " " },
      { text: "c", italic: true },
      { text: " " },
      { text: "d", code: true },
      { text: " " },
      { text: "e", italic: true },
    ]);
  });
});

describe("SVG charts", () => {
  it("draws bar, line and pie charts with escaped labels and no scripts", () => {
    for (const kind of ["bar", "line", "pie"] as const) {
      const svg = chartSvg({
        kind,
        title: EVIL,
        labels: ["<a>", "b"],
        series: [{ name: "s<1>", values: [3, 7] }],
        unit: "%",
      });
      expect(svg.startsWith("<svg")).toBe(true);
      expect(svg).not.toMatch(/<script|<a>|javascript:alert\(1\)"|href=/);
      expect(svg).toContain("&lt;script&gt;");
      const doc = new new JSDOM("").window.DOMParser().parseFromString(svg, "image/svg+xml");
      expect(doc.getElementsByTagName("parsererror")).toHaveLength(0);
    }
    const pie = chartSvg({
      kind: "pie",
      labels: ["A", "B"],
      series: [{ name: "x", values: [1, 3] }],
    });
    expect(pie).toContain("A (25%)");
    expect(pie).toContain("B (75%)");
  });

  it("picks nice ticks and enforces point limits", () => {
    expect(niceTicks(0, 97)).toEqual([0, 20, 40, 60, 80, 100]);
    expect(niceTicks(-5, 5)).toEqual([-6, -4, -2, 0, 2, 4, 6]);
    expect(niceTicks(0, 0.9)).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1]);
    const values = Array.from({ length: GENERATOR_LIMITS.chartPoints + 1 }, () => 1);
    expect(() => chartSvg({ kind: "line", labels: [], series: [{ name: "x", values }] })).toThrow(
      GeneratorError,
    );
  });
});

describe("Markdown", () => {
  it("renders blocks and escapes HTML, links and table pipes", () => {
    const { markdown, charts } = docToMarkdown(report);
    expect(markdown).toContain("# Q3 Report");
    expect(markdown).toContain("## Summary");
    expect(markdown).toContain("Revenue grew **12%** with *steady* churn");
    expect(markdown).toContain("1. Step one");
    expect(markdown).toContain("| South \\| East | 980 | No |");
    expect(markdown).toContain("````ts\nconst x = 1;");
    expect(markdown).toContain("> Quoted line");
    expect(markdown).toContain("![Revenue by month](q3-report-chart-1.svg)");
    expect(markdown).toContain("&lt;script&gt;");
    expect(markdown).toContain("\\[x\\](javascript:alert(1))");
    expect(markdown).not.toContain("<script>");
    expect(charts).toHaveLength(1);
    expect(charts[0]?.svg).toContain("Revenue by month");
  });

  it("escapes block syntax at line starts", () => {
    const { markdown } = docToMarkdown({
      title: "t",
      blocks: [{ type: "paragraph", text: "# not a heading\n- not a list\n---" }],
    });
    expect(markdown).toContain("\\# not a heading\n\\- not a list\n\\---");
  });
});

describe("PDF", () => {
  it("lays out every block type and paginates", async () => {
    const file = await generatePdf(report);
    expect(file).toMatchObject({ name: "Q3 Report.pdf", mime: "application/pdf" });
    const pdf = await openPdf(file.bytes);
    expect(pdf.info.title).toBe("Q3 Report");
    expect(pdf.info.numPages).toBe(2);
    const p1 = await pdf.pageText(1);
    for (const s of ["Q3 Report", "Summary", "Revenue grew", "12%", "North", "1200.5", "const x"])
      expect(p1).toContain(s);
    expect(p1).toContain("Revenue by month");
    expect(await pdf.pageText(2)).toContain("<script>alert(1)</script>");
    await pdf.close();
  });

  it("wraps long text and long tables across pages, replacing non-WinAnsi characters", async () => {
    const rows = Array.from({ length: 120 }, (_, i) => [`row ${i + 1}`, i]);
    const file = await generatePdf({
      title: "Long",
      blocks: [
        { type: "paragraph", text: `${"word ".repeat(400)}Ωmega 日本` },
        { type: "table", columns: ["Name", "N"], rows },
      ],
    });
    const pdf = await openPdf(file.bytes);
    expect(pdf.info.numPages).toBeGreaterThanOrEqual(3);
    const all = (
      await Promise.all(Array.from({ length: pdf.info.numPages }, (_, i) => pdf.pageText(i + 1)))
    ).join("\n");
    expect(all).toContain("row 120");
    expect(all).toContain("?mega ??");
    // The header row repeats on continuation pages.
    expect(await pdf.pageText(pdf.info.numPages)).toContain("Name");
    await pdf.close();
  });
});

describe("XLSX", () => {
  it("writes typed cells, explicit formulas and inert formula-looking strings", async () => {
    const file = await generateXlsx({
      title: "Budget",
      sheets: [
        {
          name: "Q3: Plan/Actual",
          columns: ["Item", "Amount", "Paid"],
          rows: [
            ["Rent", 1500, true],
            ['=HYPERLINK("http://evil")', 20.25, false],
            ["Total", { formula: "SUM(B2:B3)" }, null],
          ],
          formats: [null, "$#,##0.00", null],
        },
        { name: "Q3: Plan/Actual", columns: ["Note"], rows: [["dup name"]] },
      ],
    });
    expect(file.mime).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    const wb = await parseWorkbook(file.bytes, "Budget.xlsx");
    expect(wb.sheets.map((s) => s.name)).toEqual(["Q3  Plan Actual", "Q3  Plan Actual (2)"]);
    const zip = await JSZip.loadAsync(file.bytes);
    const sheet = (await zip.file("xl/worksheets/sheet1.xml")?.async("string")) ?? "";
    expect(sheet).toContain("<f>SUM(B2:B3)</f>");
    expect(sheet).not.toContain("<f>HYPERLINK");
    expect(sheet).toContain('<autoFilter ref="A1:C4"/>');
    const strings = (await zip.file("xl/sharedStrings.xml")?.async("string")) ?? "";
    expect(sheet + strings).toContain("=HYPERLINK(&quot;http://evil&quot;)");
    expect(wb.sheets[0]?.rows[0]).toEqual(["Rent", "$1,500.00", "TRUE"]);
  });

  it("sanitises and de-duplicates sheet names", () => {
    expect(sheetNames(["", "a".repeat(40), "A".repeat(40), "x[1]"])).toEqual([
      "Sheet1",
      "a".repeat(31),
      `${"A".repeat(27)} (2)`,
      "x 1",
    ]);
  });

  it("refuses empty workbooks", async () => {
    await expect(generateXlsx({ title: "x", sheets: [] })).rejects.toBeInstanceOf(GeneratorError);
  });
});

describe("HTML templates", () => {
  it("renders an itinerary with escaped content", () => {
    const html = itineraryHtml({
      title: "Lisbon trip",
      travelers: ["Ada", "Grace"],
      days: [
        {
          date: "2026-11-03",
          title: "Arrival",
          items: [
            { time: "09:30", kind: "flight", title: "TP 202 SFO → LIS", confirmation: "QX7P2L" },
            { time: "15:00", kind: "hotel", title: "Check in", location: EVIL },
          ],
        },
      ],
    });
    expect(html).toContain("Tuesday, November 3, 2026 · Arrival");
    expect(html).toContain("Confirmation QX7P2L");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>");
  });

  it("renders a dashboard and wraps it for the sandboxed artifact frame", () => {
    const html = dashboardHtml({
      title: "Ops",
      kpis: [
        { label: "Uptime", value: "99.9%", delta: "+0.1%" },
        { label: "Errors", value: 12, delta: "-3" },
      ],
      charts: [
        {
          kind: "line",
          title: "Latency",
          labels: ["a", "b"],
          series: [{ name: "p95", values: [120, 90] }],
        },
      ],
      tables: [{ title: "Top", columns: ["Path", "Hits"], rows: [["/", 10]] }],
    });
    expect(html).toContain('class="delta up"');
    expect(html).toContain('class="delta down"');
    expect(html).toContain("<svg");
    const built = templateArtifact(html);
    expect(built.csp).toContain("script-src 'nonce-");
    expect(built.csp).not.toContain("unsafe-inline' ;");
    expect(built.srcdoc.indexOf("Content-Security-Policy")).toBeLessThan(
      built.srcdoc.indexOf("Ops"),
    );
  });
});

describe("generateFile dispatcher", () => {
  it("produces each format from one request shape", async () => {
    const md = await generateFile({ format: "markdown", doc: report });
    expect(md.map((f) => f.name)).toEqual(["Q3 Report.md", "q3-report-chart-1.svg"]);
    const html = await generateFile({ format: "html", doc: report });
    const text = new TextDecoder().decode(html[0]?.bytes);
    expect(text).toMatch(/^<!doctype html>/);
    expect(text).toContain("default-src 'none'");
    const svg = await generateFile({
      format: "svg",
      chart: { kind: "bar", labels: ["a"], series: [{ name: "x", values: [1] }] },
    });
    expect(svg[0]).toMatchObject({ name: "chart.svg", mime: "image/svg+xml" });
    const pdf = await generateFile({ format: "pdf", doc: report, options: { pageSize: "a4" } });
    const extracted = await extractText({
      bytes: pdf[0]?.bytes ?? new Uint8Array(),
      name: "r.pdf",
    });
    expect(extracted.text).toContain("Revenue grew");
  });
});
