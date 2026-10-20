/**
 * Pages extracted document text the way `read_file` pages text files: one bounded window per
 * call from `offset`, with `nextOffset` when more remains. A document position packs the unit
 * (page or sheet, 0-based) and a character offset within it: `unit × UNIT_STRIDE + char`, so a
 * call only extracts the units it returns. Every unit starts with a reference line such as
 * `[page 3]` or `[sheet Budget]` (`[page 3 cont.]` when a call starts mid-page).
 */

export type DocumentFormat = "pdf" | "docx" | "xlsx";

/** Positions per unit; also the cap on one unit's text. */
export const UNIT_STRIDE = 10_000_000;

/** A document opened for extraction: units are pages (PDF, DOCX) or sheets (XLSX). */
export interface DocumentSource {
  unit: "page" | "sheet";
  count: number;
  /** The reference shown in brackets: "page 3", "sheet Budget". */
  label(index: number): string;
  text(index: number): Promise<string> | string;
  warnings(): string[];
  close?(): Promise<void> | void;
}

export interface DocumentPage {
  format: DocumentFormat;
  unit: "page" | "sheet";
  /** Pages or sheets in the document. */
  total: number;
  /** 1-based first and last unit this call returned (absent when it returned none). */
  from?: number;
  to?: number;
  offset: number;
  nextOffset?: number;
  text: string;
  warnings: string[];
}

/** A document the extractor cannot read; the message is safe to show (no document text). */
export class DocumentError extends Error {}

/** Where to cut `rest` to fit `room` characters: a line end when one is near, never mid-pair. */
function cutAt(rest: string, room: number): number {
  const nl = rest.lastIndexOf("\n", room - 1);
  let cut = nl >= room / 2 ? nl + 1 : room;
  const code = rest.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut--;
  return Math.max(1, cut);
}

export async function pageDocument(
  format: DocumentFormat,
  src: DocumentSource,
  offset: number,
  maxChars: number,
): Promise<DocumentPage> {
  let unit = Math.floor(offset / UNIT_STRIDE);
  let char = offset % UNIT_STRIDE;
  let text = "";
  let from: number | undefined;
  let to: number | undefined;
  let next: number | undefined;
  const warnings: string[] = [];
  while (unit < src.count) {
    let body = await src.text(unit);
    if (body.length >= UNIT_STRIDE) {
      body = body.slice(0, UNIT_STRIDE - 1);
      warnings.push(`${src.label(unit)} was cut at ${UNIT_STRIDE - 1} characters`);
    }
    const rest = body.slice(Math.min(char, body.length));
    const header = `[${src.label(unit)}${char > 0 ? " cont." : ""}]\n`;
    const sep = text === "" ? "" : "\n\n";
    const room = maxChars - text.length - sep.length - header.length;
    if (rest.length <= room) {
      text += sep + header + rest;
      from ??= unit + 1;
      to = unit + 1;
      unit++;
      char = 0;
      continue;
    }
    // Keep a unit whole for the next call when it fits there, or when little room is left.
    if (text !== "" && (header.length + rest.length <= maxChars || room < 200)) {
      next = unit * UNIT_STRIDE + char;
      break;
    }
    const cut = cutAt(rest, room);
    text += sep + header + rest.slice(0, cut);
    from ??= unit + 1;
    to = unit + 1;
    next = unit * UNIT_STRIDE + char + cut;
    break;
  }
  return {
    format,
    unit: src.unit,
    total: src.count,
    ...(from === undefined ? {} : { from, to }),
    offset,
    ...(next === undefined ? {} : { nextOffset: next }),
    text,
    warnings: [...src.warnings(), ...warnings],
  };
}
