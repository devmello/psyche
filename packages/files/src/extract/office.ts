import { DocumentError, type DocumentSource } from "./pager.ts";
import { inflateEntry, readZip, type ZipEntry } from "./zip.ts";

/**
 * DOCX and XLSX text from their XML parts, scanned with linear regular expressions (no DOM, no
 * entity expansion beyond the five XML entities and character references). Each part is inflated
 * on demand under `cap` bytes.
 */

const utf8 = new TextDecoder("utf-8");

export function unescapeXml(s: string): string {
  return s.replace(
    /&(?:#(\d{1,7})|#x([0-9a-fA-F]{1,6})|(lt|gt|quot|apos|amp));/g,
    (m, dec, hex, name) => {
      if (name !== undefined) {
        return { lt: "<", gt: ">", quot: '"', apos: "'", amp: "&" }[name as string] ?? m;
      }
      const cp = dec !== undefined ? Number(dec) : Number.parseInt(hex as string, 16);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : "�";
    },
  );
}

function attrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of s.matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g))
    out[m[1] ?? ""] = unescapeXml(m[2] ?? "");
  return out;
}

class Package {
  readonly bytes: Uint8Array;
  readonly cap: number;
  readonly entries: Map<string, ZipEntry>;
  constructor(bytes: Uint8Array, cap: number) {
    this.bytes = bytes;
    this.cap = cap;
    try {
      this.entries = readZip(bytes);
    } catch (err) {
      throw new DocumentError(`unreadable Office file: ${(err as Error).message}`);
    }
  }
  xml(name: string): string | undefined {
    const entry = this.entries.get(name);
    if (entry === undefined) return undefined;
    try {
      return utf8.decode(inflateEntry(this.bytes, entry, this.cap));
    } catch (err) {
      throw new DocumentError(`unreadable Office file: ${(err as Error).message}`);
    }
  }
  /** Relationship targets of `part` by id and by type suffix, resolved to package paths. */
  rels(part: string): { byId: Map<string, string>; byType: Map<string, string> } {
    const slash = part.lastIndexOf("/");
    const dir = part.slice(0, slash + 1);
    const xml = this.xml(`${dir}_rels/${part.slice(slash + 1)}.rels`) ?? "";
    const byId = new Map<string, string>();
    const byType = new Map<string, string>();
    for (const m of xml.matchAll(/<Relationship\b([^>]*?)\/?>/g)) {
      const a = attrs(m[1] ?? "");
      if (a.Target === undefined || a.TargetMode === "External") continue;
      const target = resolvePart(dir, a.Target);
      if (a.Id !== undefined) byId.set(a.Id, target);
      const type = a.Type?.slice(a.Type.lastIndexOf("/") + 1);
      if (type !== undefined && !byType.has(type)) byType.set(type, target);
    }
    return { byId, byType };
  }
  /** The main part named by the package's `officeDocument` relationship. */
  main(fallback: string): string {
    return this.rels("").byType.get("officeDocument") ?? fallback;
  }
}

function resolvePart(dir: string, target: string): string {
  const parts = (target.startsWith("/") ? target.slice(1) : dir + target).split("/");
  const out: string[] = [];
  for (const p of parts) {
    if (p === "..") out.pop();
    else if (p !== "." && p !== "") out.push(p);
  }
  return out.join("/");
}

const DOCX_TOKEN =
  /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:(tab|br|cr|lastRenderedPageBreak|pageBreakBefore)\b([^>]*?)\/>|<\/w:p>/g;

/** Text of a DOCX split into pages at Word's last rendered page breaks (or explicit ones). */
export function docxSource(bytes: Uint8Array, cap: number): DocumentSource {
  const pkg = new Package(bytes, cap);
  const xml = pkg.xml(pkg.main("word/document.xml"));
  if (xml === undefined) throw new DocumentError("not a Word document (no main document part)");
  // Word records where its last layout broke pages; without that, only explicit breaks count.
  const rendered = xml.includes("<w:lastRenderedPageBreak");
  const pages: string[] = [];
  let page = "";
  const breakPage = () => {
    pages.push(page.trimEnd());
    page = "";
  };
  for (const m of xml.matchAll(DOCX_TOKEN)) {
    if (m[1] !== undefined) {
      page += unescapeXml(m[1]);
      continue;
    }
    const a = m[3] ?? "";
    switch (m[2]) {
      case undefined:
        page += "\n";
        break;
      case "tab":
        page += "\t";
        break;
      case "lastRenderedPageBreak":
        if (rendered) breakPage();
        break;
      case "pageBreakBefore":
        if (!rendered && !/w:val="(0|false|off)"/.test(a)) breakPage();
        break;
      default:
        // br and cr: a page break starts a page unless Word's layout marks pages already.
        if (!rendered && /w:type="page"/.test(a)) breakPage();
        else page += "\n";
    }
  }
  breakPage();
  // A break before the first text leaves an empty first page.
  if (pages.length > 1 && pages[0] === "") pages.shift();
  const known = rendered || pages.length > 1;
  return {
    unit: "page",
    count: pages.length,
    label: (i) => `page ${i + 1}`,
    text: (i) => pages[i] ?? "",
    warnings: () =>
      known
        ? ["DOCX page numbers follow the document's last saved layout and may differ in Word"]
        : ["The DOCX records no page breaks, so its text is one page"],
  };
}

/** Built-in number formats that show dates or times (ECMA-376 §18.8.30). */
const DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 30, 36, 45, 46, 47, 50, 57]);

function isDateFormat(code: string): boolean {
  const bare = code.replace(/"[^"]*"|\[[^\]]*\]|\\./g, "");
  return /[dmyhs]/i.test(bare) && !/^general$/i.test(bare);
}

function excelDate(serial: number, date1904: boolean): string {
  // Excel's 1900 system counts a nonexistent 29 Feb 1900 (serial 60).
  const epoch = date1904
    ? Date.UTC(1904, 0, 1)
    : serial < 61
      ? Date.UTC(1899, 11, 31)
      : Date.UTC(1899, 11, 30);
  const d = new Date(epoch + Math.round(serial * 86_400_000));
  if (Number.isNaN(d.getTime())) return String(serial);
  const iso = d.toISOString();
  return Number.isInteger(serial) ? iso.slice(0, 10) : `${iso.slice(0, 10)} ${iso.slice(11, 19)}`;
}

function columnIndex(ref: string): number | undefined {
  const m = /^([A-Z]{1,3})\d*$/.exec(ref);
  if (m === null) return undefined;
  let n = 0;
  for (const ch of m[1] ?? "") n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

const MAX_COLUMNS = 16_384;
const runText = (xml: string) =>
  [...xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, "").matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)]
    .map((m) => unescapeXml(m[1] ?? ""))
    .join("");

/** One unit per sheet: rows as `12: a | b | c` (row number, then cells from column A). */
export function xlsxSource(bytes: Uint8Array, cap: number): DocumentSource {
  const pkg = new Package(bytes, cap);
  const book = pkg.main("xl/workbook.xml");
  const workbook = pkg.xml(book);
  if (workbook === undefined) throw new DocumentError("not an Excel workbook (no workbook part)");
  const rels = pkg.rels(book);
  const date1904 = /<workbookPr\b[^>]*\bdate1904="(1|true)"/.test(workbook);
  const sheets = [...workbook.matchAll(/<sheet\b([^>]*?)\/?>/g)].map((m) => {
    const a = attrs(m[1] ?? "");
    return { name: a.name ?? "", part: rels.byId.get(a["r:id"] ?? "") };
  });

  let shared: string[] | undefined;
  let dateStyles: boolean[] | undefined;
  const sharedStrings = () => {
    shared ??= [
      ...(pkg.xml(rels.byType.get("sharedStrings") ?? "xl/sharedStrings.xml") ?? "").matchAll(
        /<si>([\s\S]*?)<\/si>/g,
      ),
    ].map((m) => runText(m[1] ?? ""));
    return shared;
  };
  const styles = () => {
    if (dateStyles === undefined) {
      const xml = pkg.xml(rels.byType.get("styles") ?? "xl/styles.xml") ?? "";
      const custom = new Map<number, string>();
      for (const m of xml.matchAll(/<numFmt\b([^>]*?)\/?>/g)) {
        const a = attrs(m[1] ?? "");
        custom.set(Number(a.numFmtId), a.formatCode ?? "");
      }
      const xfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml)?.[1] ?? "";
      dateStyles = [...xfs.matchAll(/<xf\b([^>]*?)\/?>/g)].map((m) => {
        const id = Number(attrs(m[1] ?? "").numFmtId ?? 0);
        const code = custom.get(id);
        return code === undefined ? DATE_FORMATS.has(id) : isDateFormat(code);
      });
    }
    return dateStyles;
  };

  const cellValue = (a: Record<string, string>, inner: string): string => {
    const v = /<v>([^<]*)<\/v>/.exec(inner)?.[1];
    switch (a.t) {
      case "s":
        return sharedStrings()[Number(v)] ?? "";
      case "inlineStr":
        return runText(/<is>([\s\S]*?)<\/is>/.exec(inner)?.[1] ?? "");
      case "b":
        return v === "1" ? "TRUE" : v === "0" ? "FALSE" : "";
      case "str":
      case "e":
      case "d":
        return unescapeXml(v ?? "");
      default: {
        if (v === undefined) return "";
        const n = Number(v);
        if (a.s !== undefined && Number.isFinite(n) && styles()[Number(a.s)] === true) {
          return excelDate(n, date1904);
        }
        return v;
      }
    }
  };

  const sheetText = (index: number): string => {
    const part = sheets[index]?.part;
    if (part === undefined || !part.includes("worksheets/")) return "(no cell data)";
    const xml = pkg.xml(part) ?? "";
    const lines: string[] = [];
    let rowNumber = 0;
    for (const row of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      rowNumber = Number(attrs(row[1] ?? "").r) || rowNumber + 1;
      const values: string[] = [];
      let col = -1;
      for (const c of (row[2] ?? "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const a = attrs(c[1] ?? "");
        col = (a.r === undefined ? undefined : columnIndex(a.r)) ?? col + 1;
        if (col >= MAX_COLUMNS) break;
        const value = cellValue(a, c[2] ?? "").replace(/\r?\n/g, " ");
        if (value === "") continue;
        while (values.length < col) values.push("");
        values[col] = value;
      }
      if (values.length > 0) lines.push(`${rowNumber}: ${values.join(" | ")}`);
    }
    return lines.join("\n");
  };

  return {
    unit: "sheet",
    count: sheets.length,
    label: (i) => `sheet ${sheets[i]?.name ?? i + 1}`,
    text: sheetText,
    warnings: () => [],
  };
}
