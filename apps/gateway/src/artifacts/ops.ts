import {
  type Artifact,
  type ArtifactCell,
  type ArtifactOp,
  ArtifactTable,
  type ArtifactTableView,
  PsycheError,
} from "@psyche/protocol";
import { Value } from "@sinclair/typebox/value";

/**
 * The artifact op engine (docs/design/chat-experience-2026.md §4.3): pure functions that turn a
 * version's content plus ops into the next version's content. Failures are short `invalid_params`
 * errors the model can act on (retry with a longer anchor, or fall back to `rewrite`).
 */

export type TextType = "doc" | "code" | "markdown" | "html";

const TEXT_TYPES = new Set<Artifact["type"]>(["doc", "code", "markdown", "html"]);
const TABLE_TYPES = new Set<Artifact["type"]>(["table", "sheet"]);

export const isTextType = (t: Artifact["type"]): boolean => TEXT_TYPES.has(t);
export const isTableType = (t: Artifact["type"]): boolean => TABLE_TYPES.has(t);

export interface Applied {
  content: string;
  view: ArtifactTableView | null;
  /** How many ops were full rewrites (tracked: rewrite should be the exception). */
  rewrites: number;
}

const bad = (message: string): PsycheError => new PsycheError("invalid_params", message);

function occurrences(haystack: string, needle: string): number {
  let n = 0;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + 1)) {
    n++;
    if (n > 1) return n;
  }
  return n;
}

/** Clips an anchor for an error message so the model can see which one failed. */
const clip = (s: string): string => JSON.stringify(s.length > 60 ? `${s.slice(0, 57)}…` : s);

function applyTextOp(content: string, op: ArtifactOp, index: number): string {
  switch (op.op) {
    case "replace": {
      const n = occurrences(content, op.old);
      if (n !== 1)
        throw bad(
          `op ${index}: replace old ${clip(op.old)} matches ${n === 0 ? "nothing" : "more than once"}; use a longer exact anchor or rewrite`,
        );
      const at = content.indexOf(op.old);
      return content.slice(0, at) + op.new + content.slice(at + op.old.length);
    }
    case "insert": {
      if (op.after === "") return op.text + content;
      const n = occurrences(content, op.after);
      if (n !== 1)
        throw bad(
          `op ${index}: insert anchor ${clip(op.after)} matches ${n === 0 ? "nothing" : "more than once"}`,
        );
      const at = content.indexOf(op.after) + op.after.length;
      return content.slice(0, at) + op.text + content.slice(at);
    }
    case "rewrite":
      return op.content;
    default:
      throw bad(`op ${index}: ${op.op} applies to tables, not text`);
  }
}

/** `B3` → zero-based [row, column] into the data rows (`A1` is the first data row). */
export function parseCell(ref: string): [number, number] {
  const m = /^([A-Z]{1,3})([1-9][0-9]{0,5})$/.exec(ref);
  if (m === null) throw bad(`bad cell ${clip(ref)}`);
  let col = 0;
  for (const ch of m[1] as string) col = col * 26 + (ch.charCodeAt(0) - 64);
  return [Number(m[2]) - 1, col - 1];
}

/** Parses table content: `ArtifactTable` JSON, or CSV with a header row. */
export function parseTable(content: string): ArtifactTable {
  const trimmed = content.trimStart();
  if (trimmed.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw bad("table content is not valid JSON");
    }
    if (!Value.Check(ArtifactTable, parsed))
      throw bad("table content must be {columns: string[], rows: cell[][]}");
    return parsed;
  }
  const lines = parseCsv(content);
  const [header, ...rows] = lines;
  if (header === undefined) throw bad("table content is empty");
  return { columns: header, rows: rows.map((r) => r.map(csvCell)) };
}

function csvCell(s: string): ArtifactCell {
  if (s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) && /^-?\d/.test(s) ? n : s;
}

function parseCsv(text: string): string[][] {
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
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

function applyTableOp(
  t: ArtifactTable,
  view: ArtifactTableView | null,
  op: ArtifactOp,
  index: number,
): ArtifactTableView | null {
  const width = t.columns.length;
  const cellAt = (r: number, c: number) => {
    if (c >= width) throw bad(`op ${index}: column ${c + 1} is past the last column (${width})`);
    if (r >= t.rows.length)
      throw bad(`op ${index}: row ${r + 1} is past the last row (${t.rows.length})`);
  };
  switch (op.op) {
    case "set": {
      const [r, c] = parseCell(op.cell);
      cellAt(r, c);
      (t.rows[r] as ArtifactCell[])[c] = op.value;
      return view;
    }
    case "setRange": {
      const [from, to] = op.range.split(":") as [string, string];
      const [r0, c0] = parseCell(from);
      const [r1, c1] = parseCell(to);
      if (r1 < r0 || c1 < c0) throw bad(`op ${index}: range ${op.range} is reversed`);
      if (op.values.length !== r1 - r0 + 1 || op.values.some((v) => v.length !== c1 - c0 + 1))
        throw bad(`op ${index}: values do not match the shape of ${op.range}`);
      cellAt(r1, c1);
      op.values.forEach((vals, i) => {
        const row = t.rows[r0 + i] as ArtifactCell[];
        vals.forEach((v, j) => {
          row[c0 + j] = v;
        });
      });
      return view;
    }
    case "addRows": {
      const at = op.at ?? t.rows.length;
      if (at > t.rows.length) throw bad(`op ${index}: at ${at} is past the end`);
      const rows = op.rows.map((r) => {
        if (r.length > width) throw bad(`op ${index}: a row has more cells than columns`);
        return [...r, ...Array<ArtifactCell>(width - r.length).fill(null)];
      });
      t.rows.splice(at, 0, ...rows);
      return view;
    }
    case "deleteRows":
      if (op.at + op.count > t.rows.length) throw bad(`op ${index}: rows past the end`);
      t.rows.splice(op.at, op.count);
      return view;
    case "addColumn": {
      const at = op.at ?? width;
      if (at > width) throw bad(`op ${index}: at ${at} is past the last column`);
      t.columns.splice(at, 0, op.name);
      t.rows.forEach((row, i) => {
        row.splice(at, 0, op.values?.[i] ?? null);
      });
      return view;
    }
    case "view": {
      for (const c of [op.view.sort?.column, op.view.filter?.column])
        if (c !== undefined && !t.columns.includes(c))
          throw bad(`op ${index}: no column named ${clip(c)}`);
      return { ...(view ?? {}), ...op.view };
    }
    default:
      throw bad(`op ${index}: ${op.op} applies to text, not tables`);
  }
}

/** Applies ops in order; all or nothing. */
export function applyOps(
  type: Artifact["type"],
  content: string,
  view: ArtifactTableView | null,
  ops: readonly ArtifactOp[],
): Applied {
  const rewrites = ops.filter((o) => o.op === "rewrite").length;
  if (isTextType(type)) {
    let next = content;
    ops.forEach((op, i) => {
      next = applyTextOp(next, op, i);
    });
    return { content: next, view: null, rewrites };
  }
  if (isTableType(type)) {
    let table = parseTable(content);
    let nextView = view;
    ops.forEach((op, i) => {
      if (op.op === "rewrite") {
        table = parseTable(op.content);
        nextView = null;
      } else nextView = applyTableOp(table, nextView, op, i);
    });
    return { content: JSON.stringify(table), view: nextView, rewrites };
  }
  // Images and other stored kinds only take a whole new reference.
  if (ops.length !== 1 || ops[0]?.op !== "rewrite")
    throw bad(`a ${type} artifact only takes a single rewrite`);
  return { content: ops[0].content, view: null, rewrites };
}

/** Normalizes content at create time (tables become canonical JSON). */
export function normalizeContent(type: Artifact["type"], content: string): string {
  return isTableType(type) ? JSON.stringify(parseTable(content)) : content;
}

const lineCount = (s: string): number => (s === "" ? 0 : s.split("\n").length);

/** The one-line summary the model and the version picker see. */
export function summarize(
  type: Artifact["type"],
  content: string,
  ops?: readonly ArtifactOp[],
  previous?: string,
): string {
  const what = isTableType(type)
    ? (() => {
        const t = JSON.parse(content) as ArtifactTable;
        return `${t.rows.length} rows × ${t.columns.length} columns`;
      })()
    : isTextType(type)
      ? `${lineCount(content)} lines`
      : "replaced";
  if (ops === undefined) return what;
  const counts = new Map<string, number>();
  for (const o of ops) counts.set(o.op, (counts.get(o.op) ?? 0) + 1);
  const opText = [...counts].map(([k, n]) => `${n} ${k}`).join(", ");
  const delta =
    previous !== undefined && isTextType(type)
      ? ` (${signed(lineCount(content) - lineCount(previous))} lines)`
      : "";
  return `${opText}${delta}; ${what}`;
}

const signed = (n: number): string => (n >= 0 ? `+${n}` : `${n}`);
