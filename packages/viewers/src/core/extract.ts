import { detectMime } from "./detect.ts";
import { docxToText } from "./docx.ts";
import { emailToText, parseEmail, stripHtml } from "./email.ts";
import { openPdf } from "./pdf.ts";
import { extensionOf } from "./registry.ts";
import { cellRef, columnLetter, parseWorkbook } from "./sheet.ts";
import type { Provenance } from "./types.ts";

/**
 * Text extraction for the agent's file tools (P9). Output is bounded (`maxChars`, default 20k)
 * and paged with an opaque `nextCursor`; references point back into the source (PDF pages,
 * sheet cells) so the agent can cite them. Reading a 20 MB PDF returns one bounded page of text,
 * not the whole file. Extracted text inherits the item's provenance: content from the web, mail
 * or third parties stays `untrusted` (data, never instructions).
 */

export interface ExtractInput {
  bytes: Uint8Array;
  name: string;
  mime?: string;
  provenance?: Provenance;
}

/** OCR backend: the Mac node's Vision capability or Tesseract in the sandbox (injected). */
export interface OcrProvider {
  recognize(
    input: { bytes: Uint8Array; mime: string; page?: number },
    opts?: { signal?: AbortSignal },
  ): Promise<{ text: string }>;
}

export interface ExtractOptions {
  cursor?: string;
  /** Characters of text per call. Default 20 000, clamped to [500, 200 000]. */
  maxChars?: number;
  ocr?: OcrProvider;
  signal?: AbortSignal;
}

export interface TextRef {
  /** "p.12", "Sheet1!A2:F2", "slide 3". */
  ref: string;
  /** Offsets into `text`. */
  start: number;
  end: number;
}

export type ExtractKind =
  | "pdf"
  | "docx"
  | "sheet"
  | "slides"
  | "email"
  | "image"
  | "text"
  | "html"
  | "unsupported";

export interface ExtractResult {
  kind: ExtractKind;
  text: string;
  refs: TextRef[];
  /** Pass back as `cursor` for more; absent when this is the end. */
  nextCursor?: string;
  /** Total units in the source: pages, rows, slides or characters. */
  total: { unit: "page" | "row" | "slide" | "char"; count: number };
  provenance: Provenance;
  warnings: string[];
}

export const DEFAULT_MAX_CHARS = 20_000;
/** Inputs larger than this are refused before parsing. */
export const MAX_EXTRACT_BYTES = 200 * 1024 * 1024;

export class ExtractError extends Error {
  readonly code: "too_large" | "bad_cursor" | "unreadable";
  constructor(message: string, code: ExtractError["code"]) {
    super(message);
    this.name = "ExtractError";
    this.code = code;
  }
}

interface Cursor {
  k: string;
  /** Primary unit (page, slide, sheet). */
  a: number;
  /** Secondary unit (character offset within the unit, or row). */
  b: number;
}

const encodeCursor = (c: Cursor) => `${c.k}.${c.a}.${c.b}`;

function decodeCursor(cursor: string | undefined, kind: string): Cursor {
  if (cursor === undefined) return { k: kind, a: 0, b: 0 };
  const m = /^([a-z]+)\.(\d{1,9})\.(\d{1,12})$/.exec(cursor);
  if (m === null || m[1] !== kind)
    throw new ExtractError(`cursor does not belong to this ${kind} file`, "bad_cursor");
  return { k: kind, a: Number(m[2]), b: Number(m[3]) };
}

/** Accumulates bounded text with references. */
class Builder {
  text = "";
  refs: TextRef[] = [];
  readonly max: number;
  constructor(max: number) {
    this.max = max;
  }
  get room() {
    return this.max - this.text.length;
  }
  /** Adds a unit; returns how many characters of `body` fit (all of it when it fits). */
  add(ref: string | undefined, header: string, body: string): number {
    if (this.text.length > 0) this.text += "\n\n";
    const room = Math.max(0, this.max - this.text.length - header.length);
    const take = body.length <= room ? body.length : room;
    const start = this.text.length;
    this.text += header + body.slice(0, take);
    if (ref !== undefined) this.refs.push({ ref, start, end: this.text.length });
    return take;
  }
}

function kindOf(mime: string, name: string): ExtractKind {
  const ext = extensionOf(name);
  if (mime === "application/pdf") return "pdf";
  if (mime.includes("wordprocessingml")) return "docx";
  if (
    mime.includes("spreadsheetml") ||
    mime.includes("ms-excel") ||
    mime.includes("opendocument.spreadsheet") ||
    mime === "text/csv" ||
    mime === "text/tab-separated-values"
  )
    return "sheet";
  if (mime.includes("presentationml") || ext === "pptx") return "slides";
  if (mime === "message/rfc822") return "email";
  if (mime.startsWith("image/")) return "image";
  if (mime === "text/html") return "html";
  if (mime.startsWith("text/") || /json|xml|yaml|toml|javascript|typescript|x-sh/.test(mime))
    return "text";
  return "unsupported";
}

export async function extractText(
  input: ExtractInput,
  opts: ExtractOptions = {},
): Promise<ExtractResult> {
  if (input.bytes.byteLength > MAX_EXTRACT_BYTES) {
    throw new ExtractError(
      `file is larger than ${MAX_EXTRACT_BYTES / 1024 / 1024} MB`,
      "too_large",
    );
  }
  const maxChars = Math.min(Math.max(opts.maxChars ?? DEFAULT_MAX_CHARS, 500), 200_000);
  const mime = detectMime({
    name: input.name,
    ...(input.mime === undefined ? {} : { mime: input.mime }),
    bytes: input.bytes,
  });
  const kind = kindOf(mime, input.name);
  const provenance = input.provenance ?? "untrusted";
  const base = { kind, provenance, warnings: [] as string[] };
  switch (kind) {
    case "pdf":
      return { ...base, ...(await extractPdf(input.bytes, maxChars, opts, base.warnings)) };
    case "sheet":
      return { ...base, ...(await extractSheet(input, maxChars, opts)) };
    case "slides":
      return { ...base, ...(await extractSlides(input.bytes, maxChars, opts)) };
    case "docx":
      return {
        ...base,
        ...pageChars("docx", await docxToText(input.bytes), maxChars, opts.cursor),
      };
    case "email": {
      const mail = await parseEmail(input.bytes);
      return {
        ...base,
        ...pageChars("email", emailToText(mail, stripHtml), maxChars, opts.cursor),
      };
    }
    case "html":
      return {
        ...base,
        ...pageChars("html", stripHtml(decode(input.bytes)), maxChars, opts.cursor),
      };
    case "text":
      return { ...base, ...pageChars("text", decode(input.bytes), maxChars, opts.cursor) };
    case "image": {
      if (opts.ocr === undefined) {
        return {
          ...base,
          text: "",
          refs: [],
          total: { unit: "char", count: 0 },
          warnings: ["No OCR backend available for images"],
        };
      }
      const { text } = await opts.ocr.recognize(
        { bytes: input.bytes, mime },
        opts.signal === undefined ? {} : { signal: opts.signal },
      );
      return { ...base, ...pageChars("image", text, maxChars, opts.cursor) };
    }
    default:
      return {
        ...base,
        text: "",
        refs: [],
        total: { unit: "char", count: 0 },
        warnings: [`No text extractor for ${mime}`],
      };
  }
}

const decode = (bytes: Uint8Array) => new TextDecoder("utf-8", { fatal: false }).decode(bytes);

function pageChars(k: string, full: string, maxChars: number, cursor: string | undefined) {
  const c = decodeCursor(cursor, k);
  const start = Math.min(c.b, full.length);
  // Do not split a surrogate pair at the boundary.
  let end = Math.min(full.length, start + maxChars);
  const code = full.charCodeAt(end - 1);
  if (end < full.length && code >= 0xd800 && code <= 0xdbff) end--;
  const text = full.slice(start, end);
  return {
    text,
    refs: text.length === 0 ? [] : [{ ref: `chars ${start}-${end}`, start: 0, end: text.length }],
    total: { unit: "char" as const, count: full.length },
    ...(end < full.length ? { nextCursor: encodeCursor({ k, a: 0, b: end }) } : {}),
  };
}

async function extractPdf(
  bytes: Uint8Array,
  maxChars: number,
  opts: ExtractOptions,
  warnings: string[],
) {
  const pdf = await openPdf(bytes).catch((err: Error) => {
    throw new ExtractError(`unreadable PDF: ${err.message}`, "unreadable");
  });
  try {
    const n = pdf.info.numPages;
    const c = decodeCursor(opts.cursor, "pdf");
    if (pdf.info.isPureXfa) warnings.push("XFA form: field values are not extracted");
    const out = new Builder(maxChars);
    let page = Math.max(1, c.a || 1);
    let offset = c.b;
    let next: Cursor | undefined;
    let ocrMissing = 0;
    for (; page <= n; page++) {
      opts.signal?.throwIfAborted();
      let text = await pdf.pageText(page);
      if (text.trim() === "") {
        if (opts.ocr !== undefined) {
          text = (
            await opts.ocr.recognize(
              { bytes, mime: "application/pdf", page },
              opts.signal === undefined ? {} : { signal: opts.signal },
            )
          ).text;
        } else ocrMissing++;
      }
      const body = text.slice(offset);
      const header = `[page ${page}${offset > 0 ? " cont." : ""}]\n`;
      // Keep pages whole unless a single page is bigger than the whole budget.
      if (out.text.length > 0 && header.length + body.length + 2 > out.room) {
        next = { k: "pdf", a: page, b: offset };
        break;
      }
      const took = out.add(`p.${page}`, header, body);
      if (took < body.length) {
        next = { k: "pdf", a: page, b: offset + took };
        break;
      }
      offset = 0;
    }
    if (ocrMissing > 0)
      warnings.push(`${ocrMissing} page(s) have no text layer (scanned?); OCR is not configured`);
    return {
      text: out.text,
      refs: out.refs,
      total: { unit: "page" as const, count: n },
      ...(next === undefined ? {} : { nextCursor: encodeCursor(next) }),
    };
  } finally {
    await pdf.close();
  }
}

async function extractSheet(input: ExtractInput, maxChars: number, opts: ExtractOptions) {
  const wb = await parseWorkbook(input.bytes, input.name);
  const c = decodeCursor(opts.cursor, "sheet");
  const out = new Builder(maxChars);
  let next: Cursor | undefined;
  let totalRows = 0;
  for (const s of wb.sheets) totalRows += s.rows.length;
  outer: for (let si = c.a; si < wb.sheets.length; si++) {
    const sheet = wb.sheets[si];
    if (sheet === undefined) continue;
    const startRow = si === c.a ? c.b : 0;
    if (startRow === 0) {
      const cols = Array.from(
        { length: sheet.columnCount },
        (_, i) => `${columnLetter(i)}=${sheet.header?.[i] ?? ""}`,
      );
      out.add(
        `${sheet.name}`,
        `[sheet ${sheet.name}: ${sheet.rows.length} rows]\n`,
        sheet.header === null ? "" : `columns: ${cols.join(", ")}`,
      );
    }
    for (let r = startRow; r < sheet.rows.length; r++) {
      const row = sheet.rows[r] ?? [];
      const ref = `${sheet.name}!${cellRef(sheet, r, 0)}:${cellRef(sheet, r, Math.max(0, sheet.columnCount - 1))}`;
      const line = `${cellRef(sheet, r, 0).replace(/^[A-Z]+/, "")}: ${row.join(" | ")}`;
      if (out.room < line.length + 2) {
        next = { k: "sheet", a: si, b: r };
        break outer;
      }
      // Rows are joined with single newlines; Builder adds "\n\n" between units, so append directly.
      const start = out.text.length + 1;
      out.text += `\n${line}`;
      out.refs.push({ ref, start, end: out.text.length });
    }
  }
  return {
    text: out.text,
    refs: out.refs,
    total: { unit: "row" as const, count: totalRows },
    ...(next === undefined ? {} : { nextCursor: encodeCursor(next) }),
  };
}

async function extractSlides(bytes: Uint8Array, maxChars: number, opts: ExtractOptions) {
  const { default: JSZip } = await import("jszip");
  const zip = await JSZip.loadAsync(bytes);
  const slides = Object.keys(zip.files)
    .map((p) => /^ppt\/slides\/slide(\d+)\.xml$/.exec(p))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ path: m[0], n: Number(m[1]) }))
    .sort((a, b) => a.n - b.n);
  const c = decodeCursor(opts.cursor, "slides");
  const out = new Builder(maxChars);
  let next: Cursor | undefined;
  for (let i = c.a; i < slides.length; i++) {
    const slide = slides[i];
    if (slide === undefined) continue;
    const xml = (await zip.file(slide.path)?.async("string")) ?? "";
    const paras = xml
      .split(/<\/a:p>/)
      .map((p) =>
        [...p.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => unescapeXml(m[1] ?? "")).join(""),
      );
    const body = paras.filter((p) => p.trim() !== "").join("\n");
    const header = `[slide ${slide.n}]\n`;
    if (out.room < header.length + Math.min(body.length, 200) && out.text.length > 0) {
      next = { k: "slides", a: i, b: 0 };
      break;
    }
    out.add(`slide ${slide.n}`, header, body);
  }
  return {
    text: out.text,
    refs: out.refs,
    total: { unit: "slide" as const, count: slides.length },
    ...(next === undefined ? {} : { nextCursor: encodeCursor(next) }),
  };
}

const unescapeXml = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
