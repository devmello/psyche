import { JSDOM } from "jsdom";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { extractText } from "../src/core/extract.ts";
import { generateDocx } from "../src/core/generate/docx.ts";
import {
  type DeckSpec,
  type DocSpec,
  GENERATOR_LIMITS,
  GeneratorError,
  MIME,
} from "../src/core/generate/model.ts";
import { generatePptx } from "../src/core/generate/pptx.ts";

const EVIL = '<script>&"';
const { DOMParser } = new JSDOM("").window;

function parses(xml: string): boolean {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  return doc.getElementsByTagName("parsererror").length === 0;
}

const isZip = (b: Uint8Array) => b[0] === 0x50 && b[1] === 0x4b;

async function allPartsParse(bytes: Uint8Array): Promise<boolean> {
  const zip = await JSZip.loadAsync(bytes);
  const parts = Object.keys(zip.files).filter((p) => /\.(xml|rels)$/.test(p));
  const xml = await Promise.all(parts.map((p) => zip.file(p)?.async("string") ?? ""));
  return parts.length > 0 && xml.every(parses);
}

async function read(bytes: Uint8Array, path: string): Promise<string> {
  const zip = await JSZip.loadAsync(bytes);
  const xml = await zip.file(path)?.async("string");
  if (xml === undefined) throw new Error(`missing ${path}`);
  return xml;
}

const DOC: DocSpec = {
  title: "Quarterly Report",
  author: "Ada",
  blocks: [
    { type: "heading", level: 1, text: "Overview Heading" },
    { type: "paragraph", text: "Revenue was **strong** and *steady* via `computeTotals`." },
    { type: "paragraph", text: `Escaped ${EVIL} text` },
    { type: "list", items: ["Alpha bullet", "Beta bullet"] },
    { type: "list", ordered: true, items: ["First step", "Second step"] },
    {
      type: "table",
      columns: ["Region", "Units", "Active"],
      rows: [
        ["North", 120, true],
        ["South", 80, null],
      ],
    },
    { type: "code", text: "const x = 1;\nreturn x;", lang: "ts" },
    { type: "quote", text: "Quoted wisdom" },
    {
      type: "chart",
      chart: {
        kind: "bar",
        title: "Sales by Quarter",
        labels: ["Q1", "Q2"],
        series: [
          { name: "Apples", values: [11, 12] },
          { name: "Pears", values: [21, 22] },
          { name: "Plums", values: [31, 32] },
        ],
        unit: "%",
      },
    },
    { type: "pageBreak" },
    { type: "heading", level: 2, text: "Appendix" },
  ],
};

const DECK: DeckSpec = {
  title: "Launch Plan",
  subtitle: "Q3 kickoff",
  author: "Ada",
  slides: [
    {
      title: `Risks ${EVIL}`,
      bullets: ["Supply **delays**", "Hiring"],
      table: {
        columns: ["Risk", "Owner"],
        rows: [
          ["Supply", "Ops"],
          ["Hiring", 3],
        ],
      },
      notes: "Mention the backup vendor",
    },
    {
      title: "Revenue",
      chart: {
        kind: "bar",
        title: "Revenue by Region",
        labels: ["North", "South"],
        series: [
          { name: "2025", values: [5, 7] },
          { name: "2026", values: [6, 9] },
        ],
      },
    },
    {
      title: "Mix",
      bullets: ["Mostly hardware"],
      chart: {
        kind: "pie",
        labels: ["Hardware", "Services"],
        series: [{ name: "Share", values: [70, 30] }],
      },
    },
  ],
};

describe("generateDocx", () => {
  it("writes every block type into word/document.xml", async () => {
    const f = await generateDocx(DOC);
    expect(f.name).toBe("Quarterly Report.docx");
    expect(f.mime).toBe(MIME.docx);
    expect(isZip(f.bytes)).toBe(true);
    const xml = await read(f.bytes, "word/document.xml");
    expect(parses(xml)).toBe(true);
    expect(xml).toContain("Overview Heading");
    expect(xml).toContain('w:val="Heading1"');
    expect(xml).toMatch(/<w:b\/>/);
    expect(xml).toMatch(/<w:i\/>/);
    expect(xml).toContain('w:ascii="Menlo"');
    expect(xml).toContain("computeTotals");
    for (const t of ["Region", "North", "120", "Yes", "Alpha bullet", "First step", "return x;"]) {
      expect(xml).toContain(t);
    }
    expect(xml).toContain("Chart: Sales by Quarter");
    for (const t of ["Apples", "Pears", "Plums", "Q1", "11%", "32%"]) expect(xml).toContain(t);
    expect(xml).toContain('w:type="page"');
    const core = await read(f.bytes, "docProps/core.xml");
    expect(core).toContain("<dc:title>Quarterly Report</dc:title>");
    expect(core).toContain("Ada");
  });

  it("escapes untrusted text", async () => {
    const f = await generateDocx(DOC);
    const xml = await read(f.bytes, "word/document.xml");
    expect(xml).toContain("&lt;script&gt;&amp;");
    expect(xml).not.toContain("<script>");
    expect(await allPartsParse(f.bytes)).toBe(true);
  });

  it("drops characters XML cannot carry", async () => {
    const f = await generateDocx({
      title: "Ctl\u0001",
      blocks: [{ type: "paragraph", text: "bell\u0007 nul\u0000 ok" }],
    });
    const xml = await read(f.bytes, "word/document.xml");
    expect(parses(xml)).toBe(true);
    expect(xml).toContain("bell nul ok");
  });

  it("round-trips through extractText", async () => {
    const f = await generateDocx(DOC);
    const r = await extractText({ bytes: f.bytes, name: f.name, mime: f.mime });
    expect(r.kind).toBe("docx");
    for (const t of ["Overview Heading", "strong", "North", "Chart: Sales by Quarter", EVIL]) {
      expect(r.text).toContain(t);
    }
  });

  it("enforces limits", async () => {
    const blocks = Array.from({ length: GENERATOR_LIMITS.blocks + 1 }, () => ({
      type: "pageBreak" as const,
    }));
    await expect(generateDocx({ title: "x", blocks })).rejects.toThrow(GeneratorError);
    const rows = Array.from({ length: GENERATOR_LIMITS.tableRows + 1 }, () => ["r"]);
    await expect(
      generateDocx({ title: "x", blocks: [{ type: "table", columns: ["a"], rows }] }),
    ).rejects.toThrow(GeneratorError);
  });
});

describe("generatePptx", () => {
  it("writes a title slide, content slides, native charts and notes", async () => {
    const f = await generatePptx(DECK);
    expect(f.name).toBe("Launch Plan.pptx");
    expect(f.mime).toBe(MIME.pptx);
    expect(isZip(f.bytes)).toBe(true);
    const zip = await JSZip.loadAsync(f.bytes);
    const paths = Object.keys(zip.files);
    expect(paths.filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p))).toHaveLength(
      DECK.slides.length + 1,
    );
    expect(paths.filter((p) => /^ppt\/charts\/chart\d+\.xml$/.test(p))).toHaveLength(2);

    const cover = await read(f.bytes, "ppt/slides/slide1.xml");
    for (const t of ["Launch Plan", "Q3 kickoff", "Ada"]) expect(cover).toContain(t);
    const s2 = await read(f.bytes, "ppt/slides/slide2.xml");
    expect(parses(s2)).toBe(true);
    for (const t of ["Supply delays", "Hiring", "Owner", "Ops", "<a:tbl>"]) expect(s2).toContain(t);
    expect(s2).not.toContain("**");

    const charts = await Promise.all(
      paths.filter((p) => /^ppt\/charts\/chart\d+\.xml$/.test(p)).map((p) => read(f.bytes, p)),
    );
    const all = charts.join("\n");
    expect(all).toContain("<c:barChart>");
    expect(all).toContain("<c:pieChart>");
    for (const t of ["Revenue by Region", "North", "2026", "Hardware"]) expect(all).toContain(t);

    const notes = await Promise.all(
      paths
        .filter((p) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(p))
        .map((p) => read(f.bytes, p)),
    );
    expect(notes.join("\n")).toContain("Mention the backup vendor");
    expect(await read(f.bytes, "docProps/core.xml")).toContain("<dc:title>Launch Plan</dc:title>");
  });

  it("escapes untrusted text", async () => {
    const f = await generatePptx(DECK);
    const xml = await read(f.bytes, "ppt/slides/slide2.xml");
    expect(xml).toContain("&lt;script&gt;&amp;");
    expect(xml).not.toContain("<script>");
    expect(await allPartsParse(f.bytes)).toBe(true);
  });

  it("round-trips through extractText", async () => {
    const f = await generatePptx(DECK);
    const r = await extractText({ bytes: f.bytes, name: f.name, mime: f.mime });
    expect(r.kind).toBe("slides");
    expect(r.total).toEqual({ unit: "slide", count: 4 });
    for (const t of ["Launch Plan", `Risks ${EVIL}`, "Supply delays", "Ops", "Mostly hardware"]) {
      expect(r.text).toContain(t);
    }
  });

  it("enforces limits", async () => {
    const slides = Array.from({ length: GENERATOR_LIMITS.slides + 1 }, () => ({ title: "s" }));
    await expect(generatePptx({ title: "x", slides })).rejects.toThrow(GeneratorError);
  });
});
