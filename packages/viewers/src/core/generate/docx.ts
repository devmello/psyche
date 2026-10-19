import {
  type FileChild,
  HeadingLevel,
  LevelFormat,
  Packer,
  PageBreak,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
  Document as WordDocument,
} from "docx";
import {
  assertLimit,
  type Block,
  type CellValue,
  type ChartSpec,
  cellText,
  type DocSpec,
  fileName,
  GENERATOR_LIMITS,
  type GeneratedFile,
  MIME,
  parseInline,
  xmlSafe,
} from "./model.ts";

const MONO = "Menlo";
const ORDERED = "psyche-ordered";
const HEADINGS = {
  1: HeadingLevel.HEADING_1,
  2: HeadingLevel.HEADING_2,
  3: HeadingLevel.HEADING_3,
} as const;

function runs(text: string, extra: { italics?: boolean } = {}): TextRun[] {
  return parseInline(xmlSafe(text)).map(
    (r) =>
      new TextRun({
        text: r.text,
        ...(r.bold ? { bold: true } : {}),
        ...(r.italic || extra.italics ? { italics: true } : {}),
        ...(r.code ? { font: MONO } : {}),
      }),
  );
}

function table(columns: string[], rows: CellValue[][]): Table {
  assertLimit(rows.length, GENERATOR_LIMITS.tableRows, "table rows");
  const width = Math.max(1, columns.length);
  const cell = (text: string, bold: boolean) =>
    new TableCell({
      children: [new Paragraph({ children: [new TextRun({ text: xmlSafe(text), bold })] })],
    });
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({ tableHeader: true, children: columns.map((c) => cell(c, true)) }),
      ...rows.map(
        (r) =>
          new TableRow({
            children: Array.from({ length: width }, (_, i) => cell(cellText(r[i] ?? null), false)),
          }),
      ),
    ],
  });
}

/** Charts become a caption plus a data table: docx SVG images need a PNG fallback we can't rasterise here. */
function chart(c: ChartSpec): FileChild[] {
  const series = c.kind === "pie" ? c.series.slice(0, 1) : c.series;
  assertLimit(
    c.labels.length * Math.max(1, series.length),
    GENERATOR_LIMITS.chartPoints,
    "chart points",
  );
  const unit = c.unit ?? "";
  const caption = new Paragraph({
    children: [new TextRun({ text: xmlSafe(`Chart: ${c.title ?? c.kind}`), bold: true })],
  });
  const rows = c.labels.map((label, i) => [
    label,
    ...series.map((s) => (s.values[i] === undefined ? "" : `${s.values[i]}${unit}`)),
  ]);
  return [caption, table(["", ...series.map((s) => s.name)], rows)];
}

function block(b: Block, ordered: () => number): FileChild[] {
  switch (b.type) {
    case "heading":
      return [
        new Paragraph({
          heading: HEADINGS[b.level] ?? HeadingLevel.HEADING_3,
          children: runs(b.text),
        }),
      ];
    case "paragraph":
      return [new Paragraph({ children: runs(b.text) })];
    case "list": {
      const instance = b.ordered ? ordered() : 0;
      return b.items.map(
        (item) =>
          new Paragraph({
            children: runs(item),
            ...(b.ordered
              ? { numbering: { reference: ORDERED, level: 0, instance } }
              : { bullet: { level: 0 } }),
          }),
      );
    }
    case "table":
      return [table(b.columns, b.rows)];
    case "code":
      return xmlSafe(b.text)
        .split(/\r?\n/)
        .map(
          (line) =>
            new Paragraph({
              spacing: { after: 0 },
              children: [new TextRun({ text: line, font: MONO, size: 20 })],
            }),
        );
    case "quote":
      return [new Paragraph({ indent: { left: 720 }, children: runs(b.text, { italics: true }) })];
    case "chart":
      return chart(b.chart);
    case "pageBreak":
      return [new Paragraph({ children: [new PageBreak()] })];
  }
}

/** Builds a Word document from a `DocSpec`. Works in Node and the browser. */
export async function generateDocx(spec: DocSpec): Promise<GeneratedFile> {
  assertLimit(spec.blocks.length, GENERATOR_LIMITS.blocks, "blocks");
  let lists = 0;
  const ordered = () => ++lists;
  const children = spec.blocks.flatMap((b) => block(b, ordered));
  const doc = new WordDocument({
    title: xmlSafe(spec.title),
    ...(spec.author === undefined ? {} : { creator: xmlSafe(spec.author) }),
    numbering: {
      config: [
        {
          reference: ORDERED,
          levels: [
            {
              level: 0,
              format: LevelFormat.DECIMAL,
              text: "%1.",
              style: { paragraph: { indent: { left: 720, hanging: 360 } } },
            },
          ],
        },
      ],
    },
    sections: [{ children }],
  });
  const bytes = await Packer.pack(doc, "uint8array");
  return { name: fileName(spec.title, "docx"), mime: MIME.docx, bytes };
}
