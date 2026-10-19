import pptxgen from "pptxgenjs";
import {
  assertLimit,
  type CellValue,
  type ChartSpec,
  cellText,
  type DeckSpec,
  fileName,
  GENERATOR_LIMITS,
  type GeneratedFile,
  MIME,
  plainInline,
  type Slide,
  xmlSafe,
} from "./model.ts";

/** LAYOUT_WIDE is 13.33" x 7.5". */
const W = 13.33;
const MARGIN = 0.5;
const BODY_Y = 1.4;
const BODY_H = 7.5 - BODY_Y - MARGIN;
const GAP = 0.3;

/** The package types are CommonJS-shaped (`module.exports.default`); its ESM build default-exports the class. */
const PptxGenJS = ((pptxgen as { default?: unknown }).default ?? pptxgen) as typeof pptxgen.default;
type Pptx = InstanceType<typeof PptxGenJS>;
type PptxSlide = ReturnType<Pptx["addSlide"]>;
type Box = { x: number; y: number; w: number; h: number };

/** Chart values are written to XML unescaped, so anything non-finite becomes 0. */
const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);

function addTable(s: PptxSlide, columns: string[], rows: CellValue[][], box: Box): void {
  assertLimit(rows.length, GENERATOR_LIMITS.tableRows, "table rows");
  const width = Math.max(1, columns.length);
  const cell = (text: string, bold: boolean) => ({
    text: xmlSafe(text),
    options: bold ? { bold: true, fill: { color: "E7ECF3" } } : {},
  });
  s.addTable(
    [
      columns.map((c) => cell(c, true)),
      ...rows.map((r) =>
        Array.from({ length: width }, (_, i) => cell(cellText(r[i] ?? null), false)),
      ),
    ],
    { ...box, fontSize: 12, border: { type: "solid", pt: 0.5, color: "BFC7D5" }, autoPage: false },
  );
}

function addChart(s: PptxSlide, c: ChartSpec, box: Box): void {
  const series = c.kind === "pie" ? c.series.slice(0, 1) : c.series;
  assertLimit(
    c.labels.length * Math.max(1, series.length),
    GENERATOR_LIMITS.chartPoints,
    "chart points",
  );
  const labels = c.labels.map(xmlSafe);
  s.addChart(
    c.kind,
    series.map((sr) => ({
      name: xmlSafe(sr.name),
      labels,
      values: labels.map((_, i) => num(sr.values[i])),
    })),
    {
      ...box,
      ...(c.title ? { showTitle: true, title: xmlSafe(c.title) } : {}),
      showLegend: c.kind === "pie" || series.length > 1,
      legendPos: "b",
      ...(c.kind === "bar" ? { barDir: "col" } : {}),
      ...(c.kind === "pie" ? { showPercent: true } : {}),
    },
  );
}

function addBody(s: PptxSlide, slide: Slide): void {
  const visuals: ((b: Box) => void)[] = [];
  if (slide.table) {
    const t = slide.table;
    visuals.push((b) => addTable(s, t.columns, t.rows, b));
  }
  if (slide.chart) {
    const c = slide.chart;
    visuals.push((b) => addChart(s, c, b));
  }
  const bullets = slide.bullets ?? [];
  const full = W - 2 * MARGIN;
  const textW = visuals.length > 0 ? (full - GAP) * 0.42 : full;
  if (bullets.length > 0) {
    s.addText(
      bullets.map((b) => ({
        text: xmlSafe(plainInline(b)),
        options: { bullet: true, breakLine: true },
      })),
      { x: MARGIN, y: BODY_Y, w: textW, h: BODY_H, fontSize: 18, valign: "top", paraSpaceAfter: 6 },
    );
  }
  const x = bullets.length > 0 ? MARGIN + textW + GAP : MARGIN;
  const w = bullets.length > 0 ? full - textW - GAP : full;
  const h = (BODY_H - GAP * (visuals.length - 1)) / Math.max(1, visuals.length);
  visuals.forEach((draw, i) => {
    draw({ x, y: BODY_Y + i * (h + GAP), w, h });
  });
}

/** Builds a PowerPoint deck (16:9 wide) from a `DeckSpec`, with native charts. Works in Node and the browser. */
export async function generatePptx(spec: DeckSpec): Promise<GeneratedFile> {
  assertLimit(spec.slides.length, GENERATOR_LIMITS.slides, "slides");
  const pres = new PptxGenJS();
  pres.layout = "LAYOUT_WIDE";
  pres.title = xmlSafe(spec.title);
  if (spec.author !== undefined) pres.author = xmlSafe(spec.author);

  const cover = pres.addSlide();
  cover.addText(xmlSafe(spec.title), {
    x: MARGIN,
    y: 2.4,
    w: W - 2 * MARGIN,
    h: 1.4,
    fontSize: 40,
    bold: true,
    align: "center",
  });
  const byline = [spec.subtitle, spec.author].filter((t): t is string => !!t).map(xmlSafe);
  if (byline.length > 0) {
    cover.addText(
      byline.map((text, i) => ({
        text,
        options: { breakLine: true, fontSize: i === 0 && spec.subtitle ? 24 : 18 },
      })),
      { x: MARGIN, y: 3.9, w: W - 2 * MARGIN, h: 1.4, align: "center", color: "555555" },
    );
  }

  for (const slide of spec.slides) {
    const s = pres.addSlide();
    if (slide.title) {
      s.addText(xmlSafe(plainInline(slide.title)), {
        x: MARGIN,
        y: 0.4,
        w: W - 2 * MARGIN,
        h: 0.9,
        fontSize: 30,
        bold: true,
        valign: "middle",
      });
    }
    addBody(s, slide);
    if (slide.notes) s.addNotes(xmlSafe(slide.notes));
  }

  const out = await pres.write({ outputType: "uint8array" });
  if (!(out instanceof Uint8Array)) throw new Error("pptxgenjs did not return bytes");
  return { name: fileName(spec.title, "pptx"), mime: MIME.pptx, bytes: out };
}
