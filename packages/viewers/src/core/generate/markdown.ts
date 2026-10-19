import { chartSvg } from "./chart.ts";
import {
  assertLimit,
  type Block,
  cellText,
  type DocSpec,
  fileName,
  GENERATOR_LIMITS,
  type GeneratedFile,
  MIME,
} from "./model.ts";

/**
 * Markdown generator. Inline `**bold**` / `*italic*` / `` `code` `` pass through; everything else
 * that Markdown would interpret (HTML tags, link syntax at line start, table pipes) is escaped so
 * model text stays text. Charts become a fenced data table plus an optional sibling SVG file.
 */

/** Escapes HTML and block-level Markdown syntax, keeping inline emphasis markers. */
export function escapeMarkdownText(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    .replace(/^(\s*)([#>+*-]|\d+[.)])(\s)/gm, "$1\\$2$3")
    .replace(/^(\s*)(={3,}|-{3,}|\*{3,})\s*$/gm, "$1\\$2");
}

function cell(s: string): string {
  return escapeMarkdownText(s).replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
}

function table(columns: string[], rows: string[][]): string {
  assertLimit(rows.length, GENERATOR_LIMITS.tableRows, "table rows");
  const width = Math.max(columns.length, ...rows.map((r) => r.length), 1);
  const pad = (r: string[]) => Array.from({ length: width }, (_, i) => cell(r[i] ?? ""));
  return [
    `| ${pad(columns).join(" | ")} |`,
    `| ${Array.from({ length: width }, () => "---").join(" | ")} |`,
    ...rows.map((r) => `| ${pad(r).join(" | ")} |`),
  ].join("\n");
}

function fence(text: string, lang = ""): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const f = "`".repeat(longest + 1);
  return `${f}${lang.replace(/[^\w+-]/g, "")}\n${text}\n${f}`;
}

function block(b: Block, charts: { name: string; svg: string }[], base: string): string {
  switch (b.type) {
    case "heading":
      return `${"#".repeat(b.level + 1)} ${escapeMarkdownText(b.text)}`;
    case "paragraph":
      return escapeMarkdownText(b.text);
    case "list":
      return b.items
        .map(
          (item, i) =>
            `${b.ordered ? `${i + 1}.` : "-"} ${escapeMarkdownText(item).replace(/\n/g, "\n   ")}`,
        )
        .join("\n");
    case "table":
      return table(
        b.columns,
        b.rows.map((r) => r.map(cellText)),
      );
    case "code":
      return fence(b.text, b.lang);
    case "quote":
      return escapeMarkdownText(b.text)
        .split("\n")
        .map((l) => `> ${l}`)
        .join("\n");
    case "chart": {
      const name = `${base}-chart-${charts.length + 1}.svg`;
      charts.push({ name, svg: chartSvg(b.chart) });
      const head = b.chart.title ? `**${escapeMarkdownText(b.chart.title)}**\n\n` : "";
      const rows = b.chart.labels.map((label, i) => [
        label,
        ...b.chart.series.map((s) => (s.values[i] === undefined ? "" : String(s.values[i]))),
      ]);
      return `${head}![${cell(b.chart.title ?? "Chart")}](${name})\n\n${table(
        ["", ...b.chart.series.map((s) => s.name)],
        rows,
      )}`;
    }
    case "pageBreak":
      return "---";
  }
}

export interface MarkdownOutput {
  markdown: string;
  /** SVGs the Markdown references by relative name; save them next to the `.md` file. */
  charts: { name: string; svg: string }[];
}

export function docToMarkdown(spec: DocSpec): MarkdownOutput {
  assertLimit(spec.blocks.length, GENERATOR_LIMITS.blocks, "blocks");
  const base = fileName(spec.title, "md").replace(/\.md$/, "").replace(/\s+/g, "-").toLowerCase();
  const charts: { name: string; svg: string }[] = [];
  const parts = [`# ${escapeMarkdownText(spec.title)}`];
  if (spec.author) parts.push(`*${escapeMarkdownText(spec.author)}*`);
  for (const b of spec.blocks) parts.push(block(b, charts, base));
  return { markdown: `${parts.join("\n\n")}\n`, charts };
}

/** The `.md` file first, then any chart SVGs it references. */
export function generateMarkdown(spec: DocSpec): GeneratedFile[] {
  const out = docToMarkdown(spec);
  const enc = new TextEncoder();
  return [
    { name: fileName(spec.title, "md"), mime: MIME.markdown, bytes: enc.encode(out.markdown) },
    ...out.charts.map((c) => ({ name: c.name, mime: MIME.svg, bytes: enc.encode(c.svg) })),
  ];
}
