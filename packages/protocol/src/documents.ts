import { Value } from "@sinclair/typebox/value";
import {
  type ArtifactDeck,
  type ArtifactOp,
  type ArtifactSlide,
  type ArtifactWorkbook,
  type ArtifactWorkbookCell,
  ArtifactDeck as DeckSchema,
  ArtifactWorkbook as WorkbookSchema,
} from "./schemas/artifacts.ts";

/**
 * Pure models behind the `doc`, `slides` and `workbook` artifacts (docs/design/documents-2026.md):
 * section ops over Markdown, slide ops over a deck, cell ops and a small formula engine over a
 * workbook. Gateway (tools, export) and the canvas (editors) share them, so an owner edit and an
 * agent patch are the same ops and merge the same way. Failures throw `DocumentError` with a short
 * message the model can act on.
 */

export class DocumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocumentError";
  }
}

const bad = (message: string): DocumentError => new DocumentError(message);
const clip = (s: string): string => JSON.stringify(s.length > 60 ? `${s.slice(0, 57)}…` : s);

// --- Doc sections ------------------------------------------------------------------------------

export interface DocSection {
  heading: string;
  level: number;
  /** Line index of the heading line, and of the first line after the section's body. */
  start: number;
  end: number;
}

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;

/** Sections of a Markdown document, fenced code skipped. A section ends at the next heading of the same or a higher level. */
export function docSections(markdown: string): DocSection[] {
  const lines = markdown.split("\n");
  const found: Omit<DocSection, "end">[] = [];
  let fence: string | null = null;
  lines.forEach((line, i) => {
    const f = /^(```|~~~)/.exec(line);
    if (f) fence = fence === null ? (f[1] as string) : fence === f[1] ? null : fence;
    if (fence !== null) return;
    const m = HEADING.exec(line);
    if (m) found.push({ heading: m[2] as string, level: (m[1] as string).length, start: i });
  });
  return found.map((s, i) => {
    const next = found.slice(i + 1).find((n) => n.level <= s.level);
    return { ...s, end: next?.start ?? lines.length };
  });
}

function findSection(markdown: string, heading: string, index: number): DocSection {
  const hits = docSections(markdown).filter(
    (s) => s.heading.toLowerCase() === heading.trim().toLowerCase(),
  );
  if (hits.length !== 1)
    throw bad(
      `op ${index}: heading ${clip(heading)} matches ${hits.length === 0 ? "no section" : "more than one section"}`,
    );
  return hits[0] as DocSection;
}

const withBlank = (body: string): string[] => [
  "",
  ...body.replace(/^\n+|\n+$/g, "").split("\n"),
  "",
];

export function applyDocOp(markdown: string, op: ArtifactOp, index: number): string {
  const lines = markdown.split("\n");
  switch (op.op) {
    case "replaceSection": {
      const s = findSection(markdown, op.heading, index);
      lines.splice(s.start + 1, s.end - s.start - 1, ...withBlank(op.body));
      return lines.join("\n");
    }
    case "removeSection": {
      const s = findSection(markdown, op.heading, index);
      lines.splice(s.start, s.end - s.start);
      return lines.join("\n");
    }
    case "addSection": {
      const at = op.after === undefined ? lines.length : findSection(markdown, op.after, index).end;
      const block = [`${"#".repeat(op.level)} ${op.heading.trim()}`, ...withBlank(op.body)];
      lines.splice(at, 0, ...(at > 0 && lines[at - 1] !== "" ? ["", ...block] : block));
      return lines.join("\n");
    }
    default:
      throw bad(`op ${index}: ${op.op} does not apply to a doc`);
  }
}

// --- Slides ------------------------------------------------------------------------------------

export function parseDeck(content: string): ArtifactDeck {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw bad("slides content is not valid JSON");
  }
  if (!Value.Check(DeckSchema, parsed))
    throw bad(
      'slides content must be {theme: "light"|"dark"|"contrast", slides: [{id, layout, title?, bullets?, bullets2?, image?, notes?}]}',
    );
  const ids = new Set<string>();
  for (const s of parsed.slides) {
    if (ids.has(s.id)) throw bad(`two slides share the id ${clip(s.id)}`);
    ids.add(s.id);
  }
  return parsed;
}

export function emptyDeck(): ArtifactDeck {
  return { theme: "light", slides: [] };
}

export function applyDeckOp(deck: ArtifactDeck, op: ArtifactOp, index: number): ArtifactDeck {
  const at = (id: string): number => {
    const i = deck.slides.findIndex((s) => s.id === id);
    if (i === -1) throw bad(`op ${index}: no slide with id ${clip(id)}`);
    return i;
  };
  const slides = [...deck.slides];
  switch (op.op) {
    case "setTheme":
      return { ...deck, theme: op.theme };
    case "addSlide": {
      if (slides.some((s) => s.id === op.slide.id))
        throw bad(`op ${index}: slide id ${clip(op.slide.id)} already exists`);
      const to = op.at ?? slides.length;
      if (to > slides.length) throw bad(`op ${index}: at ${to} is past the end`);
      slides.splice(to, 0, op.slide);
      return parseDeck(JSON.stringify({ ...deck, slides }));
    }
    case "removeSlide":
      slides.splice(at(op.id), 1);
      return { ...deck, slides };
    case "moveSlide": {
      const [moved] = slides.splice(at(op.id), 1);
      if (op.to > slides.length) throw bad(`op ${index}: to ${op.to} is past the end`);
      slides.splice(op.to, 0, moved as ArtifactSlide);
      return { ...deck, slides };
    }
    case "updateSlide": {
      const i = at(op.id);
      const next: Record<string, unknown> = { ...(slides[i] as ArtifactSlide) };
      for (const [k, v] of Object.entries(op.changes)) {
        if (v === null) delete next[k];
        else if (v !== undefined) next[k] = v;
      }
      slides[i] = next as unknown as ArtifactSlide;
      return parseDeck(JSON.stringify({ ...deck, slides }));
    }
    default:
      throw bad(
        `op ${index}: ${op.op} does not apply to slides (use addSlide, updateSlide, removeSlide, moveSlide, setTheme or rewrite)`,
      );
  }
}

// --- Workbook ----------------------------------------------------------------------------------

export function parseWorkbook(content: string): ArtifactWorkbook {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw bad("workbook content is not valid JSON");
  }
  if (!Value.Check(WorkbookSchema, parsed))
    throw bad(
      "workbook content must be {sheets: [{name, cells: {A1: value | {f: formula}}}]} with 1–50 sheets",
    );
  const names = new Set<string>();
  for (const s of parsed.sheets) {
    const key = s.name.toLowerCase();
    if (names.has(key)) throw bad(`two sheets are named ${clip(s.name)}`);
    names.add(key);
  }
  return parsed;
}

export function applyWorkbookOp(
  wb: ArtifactWorkbook,
  op: ArtifactOp,
  index: number,
): ArtifactWorkbook {
  const sheets = wb.sheets.map((s) => ({ ...s, cells: { ...s.cells } }));
  const at = (name: string): number => {
    const i = sheets.findIndex((s) => s.name.toLowerCase() === name.toLowerCase());
    if (i === -1) throw bad(`op ${index}: no sheet named ${clip(name)}`);
    return i;
  };
  switch (op.op) {
    case "setCells": {
      const sheet = sheets[at(op.sheet)] as ArtifactWorkbook["sheets"][number];
      for (const [ref, v] of Object.entries(op.cells)) {
        if (v === null) delete sheet.cells[ref];
        else sheet.cells[ref] = v;
      }
      break;
    }
    case "addSheet":
      sheets.push({ name: op.name, cells: {} });
      break;
    case "renameSheet":
      (sheets[at(op.sheet)] as ArtifactWorkbook["sheets"][number]).name = op.name;
      break;
    case "removeSheet":
      if (sheets.length === 1) throw bad(`op ${index}: a workbook keeps at least one sheet`);
      sheets.splice(at(op.sheet), 1);
      break;
    default:
      throw bad(
        `op ${index}: ${op.op} does not apply to a workbook (use setCells, addSheet, renameSheet, removeSheet or rewrite)`,
      );
  }
  return parseWorkbook(JSON.stringify({ sheets }));
}

// --- Formula engine ----------------------------------------------------------------------------

/** A computed value; errors are Excel-style strings starting with `#`. */
export type Computed = string | number | boolean | null;

export const colToIndex = (col: string): number => {
  let n = 0;
  for (const ch of col) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
};
export const indexToCol = (i: number): string => {
  let n = i + 1;
  let s = "";
  while (n > 0) {
    s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
};

class Fail extends Error {}

type Tok =
  | { t: "num"; v: number }
  | { t: "str"; v: string }
  | { t: "ref"; sheet?: string; a: string; b?: string }
  | { t: "name"; v: string }
  | { t: "op"; v: string };

const REF = "\\$?[A-Za-z]{1,3}\\$?[1-9][0-9]{0,5}";

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  const re = new RegExp(
    `\\s*(?:(\\d+\\.?\\d*(?:[eE][+-]?\\d+)?|\\.\\d+)|"((?:[^"]|"")*)"|(?:('(?:[^']|'')+'|[A-Za-z_][A-Za-z0-9_.]*)!)?(${REF})(?::(${REF}))?(?![A-Za-z0-9_(])|([A-Za-z_][A-Za-z0-9_.]*)|(<=|>=|<>|[-+*/^&=<>(),%]))`,
    "y",
  );
  let pos = 0;
  while (pos < src.length) {
    if (/^\s*$/.test(src.slice(pos))) break;
    re.lastIndex = pos;
    const m = re.exec(src);
    if (!m) throw new Fail("#NAME?");
    pos = re.lastIndex;
    const strip = (r: string) => r.replace(/\$/g, "").toUpperCase();
    if (m[1] !== undefined) out.push({ t: "num", v: Number(m[1]) });
    else if (m[2] !== undefined) out.push({ t: "str", v: m[2].replace(/""/g, '"') });
    else if (m[4] !== undefined)
      out.push({
        t: "ref",
        ...(m[3] === undefined
          ? {}
          : { sheet: m[3].startsWith("'") ? m[3].slice(1, -1).replace(/''/g, "'") : m[3] }),
        a: strip(m[4]),
        ...(m[5] === undefined ? {} : { b: strip(m[5]) }),
      });
    else if (m[6] !== undefined) out.push({ t: "name", v: m[6].toUpperCase() });
    else out.push({ t: "op", v: m[7] as string });
  }
  return out;
}

type Val = Computed | Computed[][];

const num = (v: Val): number => {
  if (Array.isArray(v)) return num(v[0]?.[0] ?? null);
  if (typeof v === "string") {
    if (v.startsWith("#")) throw new Fail(v);
    const n = Number(v);
    if (v.trim() === "" || Number.isNaN(n)) throw new Fail("#VALUE!");
    return n;
  }
  return v === null ? 0 : typeof v === "boolean" ? Number(v) : v;
};
const text = (v: Val): string => {
  if (Array.isArray(v)) return text(v[0]?.[0] ?? null);
  if (typeof v === "string" && v.startsWith("#")) throw new Fail(v);
  return v === null ? "" : typeof v === "boolean" ? (v ? "TRUE" : "FALSE") : String(v);
};
const flat = (vs: Val[]): Computed[] => vs.flatMap((v) => (Array.isArray(v) ? v.flat() : [v]));
const numbers = (vs: Val[]): number[] =>
  flat(vs).flatMap((v) => {
    if (typeof v === "string" && v.startsWith("#")) throw new Fail(v);
    return typeof v === "number" ? [v] : typeof v === "boolean" ? [] : [];
  });

const FUNCS: Record<string, (args: Val[]) => Val> = {
  SUM: (a) => numbers(a).reduce((x, y) => x + y, 0),
  AVERAGE: (a) => {
    const n = numbers(a);
    if (n.length === 0) throw new Fail("#DIV/0!");
    return n.reduce((x, y) => x + y, 0) / n.length;
  },
  MIN: (a) => (numbers(a).length === 0 ? 0 : Math.min(...numbers(a))),
  MAX: (a) => (numbers(a).length === 0 ? 0 : Math.max(...numbers(a))),
  COUNT: (a) => numbers(a).length,
  COUNTA: (a) => flat(a).filter((v) => v !== null && v !== "").length,
  ABS: (a) => Math.abs(num(a[0] ?? null)),
  SQRT: (a) => {
    const n = num(a[0] ?? null);
    if (n < 0) throw new Fail("#NUM!");
    return Math.sqrt(n);
  },
  ROUND: (a) => {
    const f = 10 ** num(a[1] ?? 0);
    return Math.round(num(a[0] ?? null) * f) / f;
  },
  IF: (a) => (truthy(a[0] ?? null) ? (a[1] ?? true) : (a[2] ?? false)),
  AND: (a) => flat(a).every(truthy),
  OR: (a) => flat(a).some(truthy),
  NOT: (a) => !truthy(a[0] ?? null),
  CONCAT: (a) =>
    flat(a)
      .map((v) => text(v))
      .join(""),
  CONCATENATE: (a) =>
    flat(a)
      .map((v) => text(v))
      .join(""),
  LEN: (a) => text(a[0] ?? null).length,
  UPPER: (a) => text(a[0] ?? null).toUpperCase(),
  LOWER: (a) => text(a[0] ?? null).toLowerCase(),
};

function truthy(v: Val): boolean {
  const x = Array.isArray(v) ? (v[0]?.[0] ?? null) : v;
  if (typeof x === "string" && x.startsWith("#")) throw new Fail(x);
  return typeof x === "string" ? x !== "" && x.toUpperCase() !== "FALSE" : Boolean(x);
}

/** Computed values for every cell of every sheet (formulas evaluated, cycles → `#CIRC!`). */
export function computeWorkbook(wb: ArtifactWorkbook): Record<string, Record<string, Computed>> {
  const bySheet = new Map(wb.sheets.map((s) => [s.name.toLowerCase(), s]));
  const memo = new Map<string, Computed>();
  const busy = new Set<string>();

  const cellValue = (sheetName: string, ref: string): Computed => {
    const key = `${sheetName.toLowerCase()}!${ref}`;
    const hit = memo.get(key);
    if (hit !== undefined) return hit;
    const sheet = bySheet.get(sheetName.toLowerCase());
    if (sheet === undefined) return "#REF!";
    const raw: ArtifactWorkbookCell | undefined = sheet.cells[ref];
    if (raw === undefined || raw === null) return null;
    if (typeof raw !== "object") return raw;
    if (busy.has(key)) return "#CIRC!";
    busy.add(key);
    let v: Computed;
    try {
      v = evaluate(raw.f, sheet.name);
    } catch (e) {
      v = e instanceof Fail ? e.message : "#VALUE!";
    }
    busy.delete(key);
    memo.set(key, v);
    return v;
  };

  const range = (sheetName: string, a: string, b: string): Computed[][] => {
    const [ma, mb] = [/^([A-Z]+)(\d+)$/.exec(a), /^([A-Z]+)(\d+)$/.exec(b)];
    if (!ma || !mb) throw new Fail("#REF!");
    const [c0, c1] = [colToIndex(ma[1] as string), colToIndex(mb[1] as string)].sort(
      (x, y) => x - y,
    );
    const [r0, r1] = [Number(ma[2]), Number(mb[2])].sort((x, y) => x - y);
    if (((r1 as number) - (r0 as number) + 1) * ((c1 as number) - (c0 as number) + 1) > 100_000)
      throw new Fail("#REF!");
    const rows: Computed[][] = [];
    for (let r = r0 as number; r <= (r1 as number); r++) {
      const row: Computed[] = [];
      for (let c = c0 as number; c <= (c1 as number); c++)
        row.push(cellValue(sheetName, `${indexToCol(c)}${r}`));
      rows.push(row);
    }
    return rows;
  };

  function evaluate(formula: string, home: string): Computed {
    const toks = tokenize(formula.replace(/^=/, ""));
    let p = 0;
    const peek = () => toks[p];
    const eat = (v?: string): Tok | undefined => {
      const t = toks[p];
      if (t?.t === "op" && (v === undefined || t.v === v)) {
        p++;
        return t;
      }
      return undefined;
    };
    const cmp = (): Val => {
      let l = cat();
      for (
        let o = peek();
        o?.t === "op" && ["=", "<>", "<", ">", "<=", ">="].includes(o.v);
        o = peek()
      ) {
        p++;
        const r = cat();
        const [x, y] =
          typeof scalar(l) === "number" && typeof scalar(r) === "number"
            ? [scalar(l) as number, scalar(r) as number]
            : [text(l).toLowerCase(), text(r).toLowerCase()];
        l =
          o.v === "="
            ? x === y
            : o.v === "<>"
              ? x !== y
              : o.v === "<"
                ? x < y
                : o.v === ">"
                  ? x > y
                  : o.v === "<="
                    ? x <= y
                    : x >= y;
      }
      return l;
    };
    const scalar = (v: Val): Computed => (Array.isArray(v) ? (v[0]?.[0] ?? null) : v);
    const cat = (): Val => {
      let l = add();
      while (eat("&")) l = text(l) + text(add());
      return l;
    };
    const add = (): Val => {
      let l = mul();
      for (;;) {
        if (eat("+")) l = num(l) + num(mul());
        else if (eat("-")) l = num(l) - num(mul());
        else return l;
      }
    };
    const mul = (): Val => {
      let l = pow();
      for (;;) {
        if (eat("*")) l = num(l) * num(pow());
        else if (eat("/")) {
          const d = num(pow());
          if (d === 0) throw new Fail("#DIV/0!");
          l = num(l) / d;
        } else return l;
      }
    };
    const pow = (): Val => {
      const l = unary();
      return eat("^") ? num(l) ** num(pow()) : l;
    };
    const unary = (): Val => {
      if (eat("-")) return -num(unary());
      if (eat("+")) return unary();
      const v = atom();
      return eat("%") ? num(v) / 100 : v;
    };
    const atom = (): Val => {
      const t = toks[p++];
      if (t === undefined) throw new Fail("#VALUE!");
      if (t.t === "num" || t.t === "str") return t.v;
      if (t.t === "ref") {
        const sheet = t.sheet ?? home;
        return t.b === undefined ? cellValue(sheet, t.a) : range(sheet, t.a, t.b);
      }
      if (t.t === "name") {
        if (t.v === "TRUE") return true;
        if (t.v === "FALSE") return false;
        const fn = FUNCS[t.v];
        if (fn === undefined || !eat("(")) throw new Fail("#NAME?");
        const args: Val[] = [];
        if (!eat(")")) {
          do args.push(cmp());
          while (eat(","));
          if (!eat(")")) throw new Fail("#VALUE!");
        }
        return fn(args);
      }
      if (t.v === "(") {
        const v = cmp();
        if (!eat(")")) throw new Fail("#VALUE!");
        return v;
      }
      throw new Fail("#VALUE!");
    };
    const v = cmp();
    if (p < toks.length) throw new Fail("#VALUE!");
    const s = scalar(v);
    return typeof s === "number" && !Number.isFinite(s) ? "#NUM!" : s;
  }

  const out: Record<string, Record<string, Computed>> = {};
  for (const s of wb.sheets) {
    const vals: Record<string, Computed> = {};
    for (const ref of Object.keys(s.cells)) vals[ref] = cellValue(s.name, ref);
    out[s.name] = vals;
  }
  return out;
}

/** Applies document ops to `slides` / `workbook` content (JSON in, JSON out). */
export function applyStructuredOps(
  type: "slides" | "workbook",
  content: string,
  ops: readonly ArtifactOp[],
): string {
  if (type === "slides") {
    let deck = parseDeck(content);
    ops.forEach((op, i) => {
      deck = op.op === "rewrite" ? parseDeck(op.content) : applyDeckOp(deck, op, i);
    });
    return JSON.stringify(deck, null, 1);
  }
  let wb = parseWorkbook(content);
  ops.forEach((op, i) => {
    wb = op.op === "rewrite" ? parseWorkbook(op.content) : applyWorkbookOp(wb, op, i);
  });
  return JSON.stringify(wb);
}
