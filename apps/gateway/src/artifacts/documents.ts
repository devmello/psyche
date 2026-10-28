import {
  type Artifact,
  type ArtifactDeck,
  type ArtifactWorkbook,
  type Computed,
  colToIndex,
  computeWorkbook,
  indexToCol,
  PsycheError,
  parseDeck,
  parseWorkbook,
} from "@psyche/protocol";

/**
 * Export and import for the `doc`, `workbook` and `slides` artifacts (docs/design/documents-2026.md).
 * Export goes through the file generators (docx, pdf, xlsx, pptx), loaded on first use so an idle
 * Gateway holds none of them. Import is best effort: it keeps text, structure, values, formulas
 * and notes, and drops what the models do not carry (styles, comments, embedded objects).
 */

export type DocumentKind = "doc" | "workbook" | "slides";
export interface ExportedFile {
  name: string;
  mime: string;
  bytes: Uint8Array;
}

export const EXPORT_FORMATS: Record<DocumentKind, readonly string[]> = {
  doc: ["md", "docx", "pdf"],
  workbook: ["xlsx", "csv"],
  slides: ["pptx", "pdf"],
};

export const IMPORT_EXTENSIONS: Record<string, DocumentKind> = {
  docx: "doc",
  md: "doc",
  xlsx: "workbook",
  csv: "workbook",
  pptx: "slides",
};

export const extOf = (name: string): string => (name.split(".").pop() ?? "").toLowerCase();

const bad = (m: string) => new PsycheError("invalid_params", m);

const gen = () => import("@psyche/viewers/core/generate");

// --- Markdown ⇄ DocSpec ------------------------------------------------------------------------

type Block = import("@psyche/viewers/core/generate").Block;

/** The Markdown subset the doc editor produces, as generator blocks. Images become a paragraph of their alt text. */
export function markdownToBlocks(md: string): Block[] {
  const blocks: Block[] = [];
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const flatten = (s: string) =>
    s.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  for (let i = 0; i < lines.length; ) {
    const line = lines[i] as string;
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    const fence = /^(```|~~~)\s*(\S*)/.exec(line);
    if (line.trim() === "") i++;
    else if (fence) {
      const body: string[] = [];
      for (i++; i < lines.length && !(lines[i] as string).startsWith(fence[1] as string); i++)
        body.push(lines[i] as string);
      i++;
      blocks.push({
        type: "code",
        text: body.join("\n"),
        ...(fence[2] ? { lang: fence[2] } : {}),
      });
    } else if (h) {
      blocks.push({
        type: "heading",
        level: Math.min(3, (h[1] as string).length) as 1 | 2 | 3,
        text: flatten(h[2] as string),
      });
      i++;
    } else if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] ?? "")) {
      const cells = (l: string) =>
        l
          .trim()
          .replace(/^\||\|$/g, "")
          .split("|")
          .map((c) => flatten(c.trim()));
      const columns = cells(line);
      const rows: string[][] = [];
      for (i += 2; i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i] as string); i++)
        rows.push(cells(lines[i] as string));
      blocks.push({ type: "table", columns, rows });
    } else if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d/.test(line);
      const items: string[] = [];
      for (; i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i] as string); i++)
        items.push(flatten((lines[i] as string).replace(/^\s*([-*+]|\d+[.)])\s+/, "")));
      blocks.push({ type: "list", ordered, items });
    } else if (line.startsWith(">")) {
      const q: string[] = [];
      for (; i < lines.length && (lines[i] as string).startsWith(">"); i++)
        q.push((lines[i] as string).replace(/^>\s?/, ""));
      blocks.push({ type: "quote", text: flatten(q.join(" ")) });
    } else {
      const p: string[] = [];
      for (
        ;
        i < lines.length &&
        (lines[i] as string).trim() !== "" &&
        !/^(#{1,6}\s|```|~~~|>|\s*([-*+]|\d+[.)])\s)/.test(lines[i] as string);
        i++
      )
        p.push(lines[i] as string);
      blocks.push({ type: "paragraph", text: flatten(p.join(" ")) });
    }
  }
  return blocks;
}

// --- Workbook ⇄ rows ---------------------------------------------------------------------------

/** Dense rows of a sheet: row 1 is the header. Formulas keep their `{formula}` and are computed for CSV. */
function denseRows(sheet: ArtifactWorkbook["sheets"][number]) {
  let maxR = 0;
  let maxC = 0;
  for (const ref of Object.keys(sheet.cells)) {
    const m = /^([A-Z]+)(\d+)$/.exec(ref) as RegExpExecArray;
    maxR = Math.max(maxR, Number(m[2]));
    maxC = Math.max(maxC, colToIndex(m[1] as string) + 1);
  }
  return { rows: maxR, cols: Math.max(1, maxC) };
}

export function workbookToCsv(wb: ArtifactWorkbook, sheetName?: string): string {
  const sheet =
    sheetName === undefined
      ? wb.sheets[0]
      : wb.sheets.find((s) => s.name.toLowerCase() === sheetName.toLowerCase());
  if (sheet === undefined) throw bad(`no sheet named ${sheetName}`);
  const computed = computeWorkbook(wb)[sheet.name] as Record<string, Computed>;
  const { rows, cols } = denseRows(sheet);
  const quote = (v: Computed): string => {
    if (v === null) return "";
    let s = typeof v === "boolean" ? (v ? "TRUE" : "FALSE") : String(v);
    // A text cell that a spreadsheet would run as a formula is neutralised (CSV injection).
    if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const out: string[] = [];
  for (let r = 1; r <= rows; r++) {
    const row: string[] = [];
    for (let c = 0; c < cols; c++) row.push(quote(computed[`${indexToCol(c)}${r}`] ?? null));
    out.push(row.join(","));
  }
  return `${out.join("\n")}\n`;
}

async function workbookToXlsx(title: string, wb: ArtifactWorkbook): Promise<ExportedFile> {
  const { generateXlsx } = await gen();
  const sheets = wb.sheets.map((sheet) => {
    const { rows, cols } = denseRows(sheet);
    const at = (r: number, c: number) => sheet.cells[`${indexToCol(c)}${r}`] ?? null;
    const asText = (v: unknown) =>
      v === null ? "" : typeof v === "object" ? `=${(v as { f: string }).f}` : String(v);
    const columns = Array.from({ length: cols }, (_, c) => asText(at(1, c)));
    const body = [];
    for (let r = 2; r <= rows; r++) {
      body.push(
        Array.from({ length: cols }, (_, c) => {
          const v = at(r, c);
          return v !== null && typeof v === "object" ? { formula: v.f } : v;
        }),
      );
    }
    return { name: sheet.name, columns, rows: body };
  });
  return generateXlsx({ title, sheets });
}

// --- Export ------------------------------------------------------------------------------------

export async function exportArtifact(
  type: Artifact["type"],
  title: string,
  content: string,
  format: string,
): Promise<ExportedFile> {
  const g = await gen();
  const ext = format.toLowerCase().replace(/^\./, "");
  if (type === "doc" || type === "markdown") {
    if (!EXPORT_FORMATS.doc.includes(ext))
      throw bad(`a doc exports as ${EXPORT_FORMATS.doc.join(", ")}`);
    if (ext === "md")
      return {
        name: g.fileName(title, "md"),
        mime: g.MIME.markdown,
        bytes: new TextEncoder().encode(content),
      };
    const spec = { title, blocks: markdownToBlocks(content) };
    return ext === "docx" ? g.generateDocx(spec) : g.generatePdf(spec);
  }
  if (type === "workbook") {
    if (!EXPORT_FORMATS.workbook.includes(ext))
      throw bad(`a workbook exports as ${EXPORT_FORMATS.workbook.join(", ")}`);
    const wb = parseWorkbook(content);
    if (ext === "csv")
      return {
        name: g.fileName(title, "csv"),
        mime: "text/csv",
        bytes: new TextEncoder().encode(workbookToCsv(wb)),
      };
    return workbookToXlsx(title, wb);
  }
  if (type === "slides") {
    if (!EXPORT_FORMATS.slides.includes(ext))
      throw bad(`a deck exports as ${EXPORT_FORMATS.slides.join(", ")}`);
    const deck = parseDeck(content);
    if (ext === "pptx") return g.generatePptx(deckToSpec(title, deck));
    const blocks: Block[] = [{ type: "heading", level: 1, text: title }];
    for (const s of deck.slides) {
      if (s.title) blocks.push({ type: "heading", level: 2, text: s.title });
      const items = [...(s.bullets ?? []), ...(s.bullets2 ?? [])];
      if (items.length > 0) blocks.push({ type: "list", items });
      blocks.push({ type: "pageBreak" });
    }
    blocks.pop();
    return g.generatePdf({ title, blocks });
  }
  throw bad(`a ${type} artifact has no export`);
}

function deckToSpec(title: string, deck: ArtifactDeck) {
  const [first, ...rest] = deck.slides;
  const cover = first?.layout === "title" ? first : undefined;
  const slides = (cover ? rest : deck.slides).map((s) => ({
    ...(s.title ? { title: s.title } : {}),
    bullets: [...(s.bullets ?? []), ...(s.bullets2 ?? [])],
    ...(s.notes ? { notes: s.notes } : {}),
  }));
  return {
    title: cover?.title || title,
    ...(cover?.bullets?.[0] ? { subtitle: cover.bullets[0] } : {}),
    slides,
  };
}

// --- Import ------------------------------------------------------------------------------------

export interface Imported {
  type: DocumentKind;
  title: string;
  content: string;
  /** What the import could not keep, for the owner. */
  notes: string[];
}

const decodeEntities = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&");

/** mammoth's semantic HTML as Markdown (headings, lists, tables, emphasis, links). */
export function htmlToMarkdown(html: string): string {
  const inline = (h: string) =>
    decodeEntities(
      h
        .replace(/<(strong|b)>([\s\S]*?)<\/\1>/g, "**$2**")
        .replace(/<(em|i)>([\s\S]*?)<\/\1>/g, "*$2*")
        .replace(/<a [^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g, "[$2]($1)")
        .replace(/<br\s*\/?>/g, " ")
        .replace(/<[^>]+>/g, ""),
    ).trim();
  const out: string[] = [];
  const re = /<(h[1-6]|p|ul|ol|table|blockquote)\b[^>]*>([\s\S]*?)<\/\1>/g;
  for (const m of html.matchAll(re)) {
    const tag = m[1] as string;
    const body = m[2] as string;
    if (tag.startsWith("h")) out.push(`${"#".repeat(Number(tag[1]))} ${inline(body)}`);
    else if (tag === "p") {
      const t = inline(body);
      if (t !== "") out.push(t);
    } else if (tag === "blockquote") out.push(`> ${inline(body)}`);
    else if (tag === "ul" || tag === "ol") {
      const items = [...body.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/g)].map((x) =>
        inline(x[1] as string),
      );
      out.push(items.map((t, i) => (tag === "ol" ? `${i + 1}. ${t}` : `- ${t}`)).join("\n"));
    } else {
      const rows = [...body.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)].map((r) =>
        [...(r[1] as string).matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/g)].map((c) =>
          inline(c[1] as string).replace(/\|/g, "\\|"),
        ),
      );
      if (rows.length > 0) {
        const w = Math.max(...rows.map((r) => r.length));
        const pad = (r: string[]) =>
          `| ${Array.from({ length: w }, (_, i) => r[i] ?? "").join(" | ")} |`;
        out.push(
          [pad(rows[0] as string[]), `|${" --- |".repeat(w)}`, ...rows.slice(1).map(pad)].join(
            "\n",
          ),
        );
      }
    }
  }
  return `${out.join("\n\n")}\n`;
}

async function importXlsx(bytes: Uint8Array, name: string): Promise<Imported> {
  const XLSX = await (await import("@psyche/viewers/core/libs")).loadXlsx();
  const book = XLSX.read(bytes, { type: "array", cellFormula: true, cellDates: false });
  const sheets: ArtifactWorkbook["sheets"] = [];
  const used = new Set<string>();
  for (const [i, sn] of book.SheetNames.slice(0, 50).entries()) {
    const ws = book.Sheets[sn] as import("@psyche/viewers/core/libs").XlsxWorkSheet;
    const cells: ArtifactWorkbook["sheets"][number]["cells"] = {};
    let count = 0;
    for (const key of Object.keys(ws)) {
      if (key.startsWith("!")) continue;
      const cell = ws[key] as import("@psyche/viewers/core/libs").XlsxCell;
      if (!/^[A-Z]{1,3}[1-9][0-9]{0,5}$/.test(key)) continue;
      if (++count > 200_000) throw bad("the sheet has too many cells to open");
      if (cell.f) cells[key] = { f: cell.f };
      else if (cell.t === "n" || cell.t === "s" || cell.t === "b") cells[key] = cell.v as never;
      else if (cell.v !== undefined) cells[key] = String(cell.w ?? cell.v);
    }
    let n = sn.slice(0, 31) || `Sheet${i + 1}`;
    for (let k = 2; used.has(n.toLowerCase()); k++) n = `${n.slice(0, 27)} ${k}`;
    used.add(n.toLowerCase());
    sheets.push({ name: n, cells });
  }
  if (sheets.length === 0) throw bad("the file has no sheets");
  return {
    type: "workbook",
    title: name.replace(/\.[^.]+$/, ""),
    content: JSON.stringify({ sheets }),
    notes: ["Cell formatting, charts and images are not kept."],
  };
}

function importCsv(text: string, name: string): Imported {
  const cells: Record<string, string | number> = {};
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field !== "" || row.length > 0) rows.push([...row, field]);
  for (const [ri, r] of rows.entries()) {
    for (const [ci, v] of r.entries()) {
      if (v === "" || ri >= 200_000 || ci >= 18_000) continue;
      cells[`${indexToCol(ci)}${ri + 1}`] = /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v;
    }
  }
  return {
    type: "workbook",
    title: name.replace(/\.[^.]+$/, ""),
    content: JSON.stringify({ sheets: [{ name: "Sheet1", cells }] }),
    notes: [],
  };
}

async function importPptx(bytes: Uint8Array, name: string): Promise<Imported> {
  const JSZip = await (await import("@psyche/viewers/core/libs")).loadJszip();
  const zip = await JSZip.loadAsync(bytes);
  const files = Object.keys(zip.files);
  const slideFiles = files
    .filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f))
    .sort((a, b) => Number(/(\d+)\.xml$/.exec(a)?.[1]) - Number(/(\d+)\.xml$/.exec(b)?.[1]));
  if (slideFiles.length === 0) throw bad("the file has no slides");
  const paras = (xml: string): string[] =>
    [...xml.matchAll(/<a:p\b[\s\S]*?<\/a:p>/g)]
      .map((p) =>
        decodeEntities(
          [...p[0].matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((t) => t[1]).join(""),
        ).trim(),
      )
      .filter((t) => t !== "");
  const slides: ArtifactDeck["slides"] = [];
  let hasImages = false;
  for (const [i, f] of slideFiles.slice(0, 300).entries()) {
    const xml = await (zip.file(f) as { async(t: "string"): Promise<string> }).async("string");
    if (xml.includes("<p:pic")) hasImages = true;
    let title: string | undefined;
    const bullets: string[] = [];
    for (const sp of xml.matchAll(/<p:sp\b[\s\S]*?<\/p:sp>/g)) {
      const isTitle = /<p:ph [^>]*type="(title|ctrTitle)"/.test(sp[0]);
      const ps = paras(sp[0]);
      if (isTitle && title === undefined) title = ps.join(" ");
      else bullets.push(...ps);
    }
    const relName = f.replace("slides/", "slides/_rels/").concat(".rels");
    const rels = await zip.file(relName)?.async("string");
    const notesTarget = rels && /Target="\.\.\/notesSlides\/(notesSlide\d+\.xml)"/.exec(rels)?.[1];
    let notes: string | undefined;
    if (notesTarget) {
      const nx = await zip.file(`ppt/notesSlides/${notesTarget}`)?.async("string");
      if (nx) {
        const body = [...nx.matchAll(/<p:sp\b[\s\S]*?<\/p:sp>/g)].filter((s) =>
          /type="body"/.test(s[0]),
        );
        notes = body.flatMap((s) => paras(s[0])).join("\n") || undefined;
      }
    }
    slides.push({
      id: `s${i + 1}`,
      layout: title !== undefined && bullets.length === 0 ? "title" : "bullets",
      ...(title ? { title: title.slice(0, 200) } : {}),
      ...(bullets.length > 0 ? { bullets: bullets.slice(0, 30).map((b) => b.slice(0, 500)) } : {}),
      ...(notes ? { notes: notes.slice(0, 4000) } : {}),
    });
  }
  return {
    type: "slides",
    title: name.replace(/\.[^.]+$/, ""),
    content: JSON.stringify({ theme: "light", slides }),
    notes: [
      `Text and speaker notes are kept; shapes, layouts and styling are not${hasImages ? "; pictures were dropped" : ""}.`,
    ],
  };
}

export async function importDocument(name: string, bytes: Uint8Array): Promise<Imported> {
  const ext = extOf(name);
  const title = name.replace(/\.[^.]+$/, "");
  switch (ext) {
    case "docx": {
      const { docxToHtml } = await import("@psyche/viewers/core/docx");
      const { html } = await docxToHtml(bytes);
      return {
        type: "doc",
        title,
        content: htmlToMarkdown(html),
        notes: ["Styles, comments, headers and images are not kept."],
      };
    }
    case "md":
      return { type: "doc", title, content: new TextDecoder().decode(bytes), notes: [] };
    case "xlsx":
      return importXlsx(bytes, name);
    case "csv":
      return importCsv(new TextDecoder().decode(bytes), name);
    case "pptx":
      return importPptx(bytes, name);
    default:
      throw bad(`cannot open .${ext}: use .docx, .md, .xlsx, .csv or .pptx`);
  }
}
