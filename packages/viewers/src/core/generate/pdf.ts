import { PDFDocument, type PDFFont, type PDFPage, rgb, StandardFonts } from "@cantoo/pdf-lib";
import { Encodings } from "@cantoo/pdf-lib/standard-fonts";
import { chartSvg } from "./chart.ts";
import {
  assertLimit,
  type Block,
  cellText,
  type DocSpec,
  fileName,
  GENERATOR_LIMITS,
  type GeneratedFile,
  type InlineRun,
  MIME,
  parseInline,
} from "./model.ts";

/**
 * PDF generator on pdf-lib with the standard 14 fonts: headings, wrapped rich paragraphs, lists,
 * paginated tables, code, quotes and SVG charts. Standard fonts cover WinAnsi (Western European)
 * only; other characters print as "?". For full Unicode or CSS layout, render `docToHtml` and
 * print it with Chromium (the browser driver's print-to-PDF) instead.
 */

export interface PdfGenOptions {
  /** Default "letter". */
  pageSize?: "letter" | "a4";
}

const SIZES = { letter: [612, 792], a4: [595.28, 841.89] } as const;
const MARGIN = 56;
const INK = rgb(0.12, 0.16, 0.22);
const MUTED = rgb(0.42, 0.45, 0.5);
const RULE = rgb(0.85, 0.87, 0.9);
const SHADE = rgb(0.95, 0.96, 0.97);

/** Replaces characters the standard fonts cannot encode. */
export function winAnsiSafe(s: string): string {
  let out = "";
  for (const ch of s.replace(/\t/g, "    ")) {
    const cp = ch.codePointAt(0) ?? 63;
    out += Encodings.WinAnsi.canEncodeUnicodeCodePoint(cp) ? ch : "?";
  }
  return out;
}

interface Fonts {
  regular: PDFFont;
  bold: PDFFont;
  italic: PDFFont;
  boldItalic: PDFFont;
  mono: PDFFont;
}

interface Word {
  text: string;
  font: PDFFont;
  /** Space before this word. */
  space: boolean;
}

class Layout {
  page!: PDFPage;
  y = 0;
  readonly width: number;
  readonly doc: PDFDocument;
  readonly fonts: Fonts;
  readonly size: readonly [number, number];
  constructor(doc: PDFDocument, fonts: Fonts, size: readonly [number, number]) {
    this.doc = doc;
    this.fonts = fonts;
    this.size = size;
    this.width = size[0] - MARGIN * 2;
    this.newPage();
  }

  newPage(): void {
    this.page = this.doc.addPage([this.size[0], this.size[1]]);
    this.y = this.size[1] - MARGIN;
  }

  ensure(height: number): void {
    if (this.y - height < MARGIN) this.newPage();
  }

  fontFor(run: InlineRun): PDFFont {
    if (run.code) return this.fonts.mono;
    if (run.bold && run.italic) return this.fonts.boldItalic;
    if (run.bold) return this.fonts.bold;
    if (run.italic) return this.fonts.italic;
    return this.fonts.regular;
  }

  words(runs: InlineRun[], base?: PDFFont): Word[] {
    const out: Word[] = [];
    let pendingSpace = false;
    for (const run of runs) {
      const font = base ?? this.fontFor(run);
      for (const part of winAnsiSafe(run.text).split(/(\s+)/)) {
        if (part === "") continue;
        if (/^\s+$/.test(part)) pendingSpace = true;
        else {
          out.push({ text: part, font, space: pendingSpace && out.length > 0 });
          pendingSpace = false;
        }
      }
    }
    return out;
  }

  /** Greedy line wrap; words longer than a line are split by characters. */
  wrap(words: Word[], size: number, width: number): Word[][] {
    const lines: Word[][] = [];
    let line: Word[] = [];
    let w = 0;
    const space = (f: PDFFont) => f.widthOfTextAtSize(" ", size);
    for (let word of words) {
      let ww = word.font.widthOfTextAtSize(word.text, size);
      while (ww > width && word.text.length > 1) {
        let cut = word.text.length - 1;
        while (cut > 1 && word.font.widthOfTextAtSize(word.text.slice(0, cut), size) > width) cut--;
        if (line.length > 0) lines.push(line);
        lines.push([{ ...word, text: word.text.slice(0, cut), space: false }]);
        line = [];
        w = 0;
        word = { ...word, text: word.text.slice(cut), space: false };
        ww = word.font.widthOfTextAtSize(word.text, size);
      }
      const add = (line.length > 0 && word.space ? space(word.font) : 0) + ww;
      if (line.length > 0 && w + add > width) {
        lines.push(line);
        line = [{ ...word, space: false }];
        w = ww;
      } else {
        line.push(line.length === 0 ? { ...word, space: false } : word);
        w += line.length === 1 ? ww : add;
      }
    }
    if (line.length > 0) lines.push(line);
    return lines;
  }

  drawLine(line: Word[], x: number, y: number, size: number, color = INK): void {
    let cx = x;
    for (const word of line) {
      if (word.space) cx += word.font.widthOfTextAtSize(" ", size);
      this.page.drawText(word.text, { x: cx, y, size, font: word.font, color });
      cx += word.font.widthOfTextAtSize(word.text, size);
    }
  }

  paragraph(
    runs: InlineRun[],
    opts: { size?: number; indent?: number; font?: PDFFont; color?: ReturnType<typeof rgb> } = {},
  ): void {
    const size = opts.size ?? 11;
    const indent = opts.indent ?? 0;
    const lead = size * 1.35;
    for (const line of this.wrap(this.words(runs, opts.font), size, this.width - indent)) {
      this.ensure(lead);
      this.y -= lead;
      this.drawLine(line, MARGIN + indent, this.y + (lead - size) / 2, size, opts.color);
    }
  }
}

function drawTable(l: Layout, columns: string[], rows: string[][]): void {
  assertLimit(rows.length, GENERATOR_LIMITS.tableRows, "table rows");
  const n = Math.max(1, columns.length, ...rows.map((r) => r.length));
  const size = n > 6 ? 8 : 9.5;
  const pad = 4;
  const colW = l.width / n;
  const lead = size * 1.3;
  const layoutRow = (cells: string[], font: PDFFont) => {
    const wrapped = Array.from({ length: n }, (_, i) =>
      l.wrap(l.words([{ text: cells[i] ?? "" }], font), size, colW - pad * 2),
    );
    return { wrapped, height: Math.max(1, ...wrapped.map((w) => w.length)) * lead + pad * 2 };
  };
  const header = layoutRow(columns, l.fonts.bold);
  const drawRow = (row: ReturnType<typeof layoutRow>, shade: boolean) => {
    l.y -= row.height;
    if (shade)
      l.page.drawRectangle({ x: MARGIN, y: l.y, width: l.width, height: row.height, color: SHADE });
    l.page.drawLine({
      start: { x: MARGIN, y: l.y },
      end: { x: MARGIN + l.width, y: l.y },
      thickness: 0.5,
      color: RULE,
    });
    row.wrapped.forEach((lines, c) => {
      lines.forEach((line, i) => {
        l.drawLine(
          line,
          MARGIN + c * colW + pad,
          l.y + row.height - pad - (i + 1) * lead + 3,
          size,
        );
      });
    });
  };
  l.ensure(header.height + lead * 2);
  l.y -= 4;
  drawRow(header, true);
  for (const r of rows) {
    const row = layoutRow(r, l.fonts.regular);
    if (l.y - row.height < MARGIN) {
      l.newPage();
      drawRow(header, true);
    }
    drawRow(row, false);
  }
  l.y -= 8;
}

function drawBlock(l: Layout, b: Block): void {
  switch (b.type) {
    case "heading": {
      const size = b.level === 1 ? 18 : b.level === 2 ? 14.5 : 12.5;
      l.ensure(size * 3);
      l.y -= size * 0.6;
      l.paragraph([{ text: b.text }], { size, font: l.fonts.bold });
      l.y -= 4;
      return;
    }
    case "paragraph":
      l.paragraph(parseInline(b.text));
      l.y -= 6;
      return;
    case "list":
      b.items.forEach((item, i) => {
        const marker = b.ordered ? `${i + 1}.` : "•";
        l.ensure(15);
        const y = l.y - 15 + 3.5;
        l.page.drawText(marker, { x: MARGIN + 6, y, size: 11, font: l.fonts.regular, color: INK });
        l.paragraph(parseInline(item), { indent: 22 });
      });
      l.y -= 6;
      return;
    case "table":
      drawTable(
        l,
        b.columns,
        b.rows.map((r) => r.map(cellText)),
      );
      return;
    case "code": {
      const size = 9;
      const lead = size * 1.35;
      for (const raw of b.text.split("\n")) {
        const lines = l.wrap(l.words([{ text: raw || " " }], l.fonts.mono), size, l.width - 16);
        for (const line of lines.length > 0 ? lines : [[]]) {
          l.ensure(lead);
          l.y -= lead;
          l.page.drawRectangle({ x: MARGIN, y: l.y, width: l.width, height: lead, color: SHADE });
          l.drawLine(line, MARGIN + 8, l.y + 3.5, size);
        }
      }
      l.y -= 8;
      return;
    }
    case "quote": {
      const top = l.y;
      const page = l.page;
      l.paragraph(parseInline(b.text), { indent: 14, font: l.fonts.italic, color: MUTED });
      if (l.page === page)
        page.drawLine({
          start: { x: MARGIN + 3, y: top - 2 },
          end: { x: MARGIN + 3, y: l.y + 2 },
          thickness: 2,
          color: RULE,
        });
      l.y -= 6;
      return;
    }
    case "chart": {
      const svgW = Math.min(2000, Math.max(240, b.chart.width ?? 640));
      const svgH = Math.min(1500, Math.max(160, b.chart.height ?? 360));
      const width = Math.min(l.width, svgW);
      const height = (svgH / svgW) * width;
      l.ensure(height + 8);
      l.page.drawSvg(chartSvg(b.chart), {
        x: MARGIN,
        y: l.y,
        width,
        height,
        fonts: { Helvetica: l.fonts.regular, "Helvetica, Arial, sans-serif": l.fonts.regular },
      });
      l.y -= height + 10;
      return;
    }
    case "pageBreak":
      l.newPage();
      return;
  }
}

export async function generatePdf(spec: DocSpec, opts: PdfGenOptions = {}): Promise<GeneratedFile> {
  assertLimit(spec.blocks.length, GENERATOR_LIMITS.blocks, "blocks");
  const doc = await PDFDocument.create();
  doc.setTitle(spec.title, { showInWindowTitleBar: true });
  if (spec.author) doc.setAuthor(spec.author);
  doc.setCreator("Psyche");
  doc.setProducer("Psyche (pdf-lib)");
  const fonts: Fonts = {
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    italic: await doc.embedFont(StandardFonts.HelveticaOblique),
    boldItalic: await doc.embedFont(StandardFonts.HelveticaBoldOblique),
    mono: await doc.embedFont(StandardFonts.Courier),
  };
  const l = new Layout(doc, fonts, SIZES[opts.pageSize ?? "letter"]);
  l.paragraph([{ text: spec.title }], { size: 22, font: fonts.bold });
  if (spec.author) l.paragraph([{ text: spec.author }], { size: 11, color: MUTED });
  l.y -= 10;
  for (const b of spec.blocks) drawBlock(l, b);
  const pages = doc.getPages();
  pages.forEach((p, i) => {
    const label = `${i + 1} / ${pages.length}`;
    const w = fonts.regular.widthOfTextAtSize(label, 8);
    p.drawText(label, {
      x: (p.getWidth() - w) / 2,
      y: 28,
      size: 8,
      font: fonts.regular,
      color: MUTED,
    });
  });
  return { name: fileName(spec.title, "pdf"), mime: MIME.pdf, bytes: await doc.save() };
}
