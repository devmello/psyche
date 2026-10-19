import type { Provenance, SearchIndexDocKind } from "@psyche/protocol";

/**
 * Query language for the Search screen and ⌘K (UI §3.13, architecture §4.12).
 *
 *   dentist in:threads from:alice after:2026-09-01 has:approval "three slots" -cancelled
 *
 * Bare words are ANDed, `OR` between two terms makes an alternative, `"…"` is a phrase, `-x`
 * excludes, and the last bare word of the query also matches as a prefix (typing in ⌘K).
 * Filters: `in:` (pane), `type:` (file type or document kind), `from:`, `before:`, `after:`,
 * `on:`, `has:` (`approval`, `receipt`, `attachment`), `is:` (provenance), `thread:`.
 * An unknown `key:value` is searched as text.
 */

export interface QueryTerm {
  text: string;
  /** Matches any token starting with `text`. */
  prefix: boolean;
  /** `"…"` phrase (may hold several tokens). */
  phrase: boolean;
  /** `OR` joins this term to the previous positive term. */
  or: boolean;
}

export type SearchFlag = "approval" | "receipt" | "attachment";

export interface ParsedFilters {
  kinds?: SearchIndexDocKind[];
  /** MIME patterns; a trailing `/*` matches the whole family. */
  mimes?: string[];
  from?: string[];
  /** Epoch ms; documents with `createdAt < before`. */
  before?: number;
  /** Epoch ms; documents with `createdAt >= after`. */
  after?: number;
  has?: SearchFlag[];
  provenance?: Provenance[];
  threadId?: string;
}

export interface ParsedQuery {
  terms: QueryTerm[];
  excluded: QueryTerm[];
  filters: ParsedFilters;
  /** The free-text part, for sources with their own parser (memory). */
  text: string;
  /** Filter tokens that could not be understood (shown to the user as hints). */
  warnings: string[];
}

export interface ParseOptions {
  /** Epoch ms used for relative dates (`7d`, `today`). */
  now?: number;
  /** Minutes east of UTC for calendar dates; default 0 (UTC). */
  tzOffsetMinutes?: number;
}

const DAY_MS = 86_400_000;

/** `in:` values (panes) → document kinds. */
const IN_ALIASES: Record<string, SearchIndexDocKind[]> = {
  threads: ["thread", "message"],
  thread: ["thread", "message"],
  chat: ["thread", "message"],
  chats: ["thread", "message"],
  messages: ["message"],
  message: ["message"],
  tasks: ["task"],
  task: ["task"],
  activity: ["task"],
  memory: ["memory"],
  library: ["library"],
  files: ["library"],
  feed: ["feed"],
  ideas: ["idea"],
  idea: ["idea"],
  goals: ["goal"],
  goal: ["goal"],
  connectors: ["connector"],
  connector: ["connector"],
};

/** `type:` values → MIME patterns. */
const TYPE_MIMES: Record<string, string[]> = {
  pdf: ["application/pdf"],
  image: ["image/*"],
  images: ["image/*"],
  photo: ["image/*"],
  audio: ["audio/*"],
  video: ["video/*"],
  doc: [
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.oasis.opendocument.text",
  ],
  docx: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  sheet: [
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.oasis.opendocument.spreadsheet",
    "text/csv",
  ],
  spreadsheet: [
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.oasis.opendocument.spreadsheet",
    "text/csv",
  ],
  xlsx: ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  csv: ["text/csv"],
  slides: [
    "application/vnd.ms-powerpoint",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ],
  md: ["text/markdown"],
  markdown: ["text/markdown"],
  html: ["text/html"],
  text: ["text/plain"],
  txt: ["text/plain"],
  json: ["application/json"],
};

const KINDS: SearchIndexDocKind[] = [
  "thread",
  "message",
  "task",
  "memory",
  "library",
  "feed",
  "idea",
  "goal",
  "connector",
];

const PROVENANCES: Provenance[] = ["owner", "agent", "untrusted", "system"];
const FLAGS: SearchFlag[] = ["approval", "receipt", "attachment"];
const FILTER_KEYS = new Set(["in", "type", "from", "before", "after", "on", "has", "is", "thread"]);

interface Token {
  key?: string;
  value: string;
  quoted: boolean;
  negated: boolean;
  /** Ends at the end of the input (no trailing whitespace). */
  last: boolean;
}

function tokenize(input: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  const n = input.length;
  while (i < n) {
    while (i < n && /\s/.test(input[i] ?? "")) i += 1;
    if (i >= n) break;
    let negated = false;
    if (input[i] === "-" && i + 1 < n && !/\s/.test(input[i + 1] ?? "")) {
      negated = true;
      i += 1;
    }
    let key: string | undefined;
    const keyMatch = /^([a-zA-Z]+):(?=\S)/.exec(input.slice(i));
    if (keyMatch?.[1] !== undefined && FILTER_KEYS.has(keyMatch[1].toLowerCase())) {
      key = keyMatch[1].toLowerCase();
      i += keyMatch[0].length;
    }
    let value = "";
    let quoted = false;
    if (input[i] === '"') {
      quoted = true;
      const end = input.indexOf('"', i + 1);
      value = end < 0 ? input.slice(i + 1) : input.slice(i + 1, end);
      i = end < 0 ? n : end + 1;
    } else {
      const start = i;
      while (i < n && !/\s/.test(input[i] ?? "")) i += 1;
      value = input.slice(start, i);
    }
    out.push({ key, value, quoted, negated, last: i >= n });
  }
  return out;
}

/** Calendar date `YYYY-MM-DD` → epoch ms of its local midnight; relative forms supported. */
export function parseDate(value: string, opts: ParseOptions = {}): number | undefined {
  const now = opts.now ?? Date.now();
  const tz = (opts.tzOffsetMinutes ?? 0) * 60_000;
  const startOfDay = (ms: number) => Math.floor((ms + tz) / DAY_MS) * DAY_MS - tz;
  const v = value.toLowerCase();
  if (v === "today") return startOfDay(now);
  if (v === "yesterday") return startOfDay(now) - DAY_MS;
  const rel = /^(\d{1,4})([dwmy])$/.exec(v);
  if (rel !== null) {
    const count = Number(rel[1]);
    const unit = rel[2];
    const days = unit === "d" ? 1 : unit === "w" ? 7 : unit === "m" ? 30 : 365;
    return now - count * days * DAY_MS;
  }
  const iso = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(v);
  if (iso !== null) {
    const ms = Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3] ?? "1"));
    return Number.isNaN(ms) ? undefined : ms - tz;
  }
  return undefined;
}

function pushUnique<T>(list: T[] | undefined, values: T[]): T[] {
  const out = list ?? [];
  for (const v of values) if (!out.includes(v)) out.push(v);
  return out;
}

export function parseQuery(input: string, opts: ParseOptions = {}): ParsedQuery {
  const tokens = tokenize(input.normalize("NFC"));
  const terms: QueryTerm[] = [];
  const excluded: QueryTerm[] = [];
  const filters: ParsedFilters = {};
  const warnings: string[] = [];
  const text: string[] = [];
  let pendingOr = false;

  const addTerm = (t: Token) => {
    const term: QueryTerm = {
      text: t.value,
      prefix: false,
      phrase: t.quoted,
      or: false,
    };
    if (t.negated) {
      excluded.push(term);
      return;
    }
    term.or = pendingOr && terms.length > 0;
    pendingOr = false;
    terms.push(term);
    text.push(t.value);
  };

  for (const t of tokens) {
    if (t.key === undefined) {
      if (!t.quoted && !t.negated && t.value === "OR") {
        pendingOr = true;
        continue;
      }
      if (t.value.length > 0) addTerm(t);
      continue;
    }
    const value = t.value.trim();
    const lower = value.toLowerCase();
    const unknown = () => {
      warnings.push(`${t.key}:${value}`);
      addTerm({ ...t, value: `${t.key}:${value}`, key: undefined });
    };
    switch (t.key) {
      case "in": {
        const kinds = IN_ALIASES[lower];
        if (kinds === undefined) unknown();
        else filters.kinds = pushUnique(filters.kinds, kinds);
        break;
      }
      case "type": {
        const mimes = TYPE_MIMES[lower];
        if (mimes !== undefined) filters.mimes = pushUnique(filters.mimes, mimes);
        else if (KINDS.includes(lower as SearchIndexDocKind))
          filters.kinds = pushUnique(filters.kinds, [lower as SearchIndexDocKind]);
        else if (/^[a-z]+\/[a-z0-9.+*-]+$/.test(lower))
          filters.mimes = pushUnique(filters.mimes, [lower]);
        else unknown();
        break;
      }
      case "from":
        if (value.length === 0) unknown();
        else filters.from = pushUnique(filters.from, [lower]);
        break;
      case "before":
      case "after":
      case "on": {
        const ms = parseDate(value, opts);
        if (ms === undefined) {
          unknown();
          break;
        }
        if (t.key === "before") filters.before = Math.min(filters.before ?? Infinity, ms);
        else if (t.key === "after") filters.after = Math.max(filters.after ?? -Infinity, ms);
        else {
          filters.after = Math.max(filters.after ?? -Infinity, ms);
          filters.before = Math.min(filters.before ?? Infinity, ms + DAY_MS);
        }
        break;
      }
      case "has": {
        const flag = lower.replace(/s$/, "") as SearchFlag;
        if (FLAGS.includes(flag)) filters.has = pushUnique(filters.has, [flag]);
        else unknown();
        break;
      }
      case "is": {
        if (PROVENANCES.includes(lower as Provenance))
          filters.provenance = pushUnique(filters.provenance, [lower as Provenance]);
        else unknown();
        break;
      }
      case "thread":
        filters.threadId = value;
        break;
      default:
        unknown();
    }
  }

  // The last bare word also matches as a prefix while the user is still typing it.
  const lastToken = tokens[tokens.length - 1];
  const lastTerm = terms[terms.length - 1];
  if (
    lastToken?.last === true &&
    lastToken.key === undefined &&
    !lastToken.quoted &&
    !lastToken.negated &&
    lastTerm !== undefined &&
    !lastTerm.phrase &&
    lastTerm.text === lastToken.value
  ) {
    lastTerm.prefix = true;
  }

  return { terms, excluded, filters, text: text.join(" "), warnings };
}

/** Splits a term into FTS tokens the way the `unicode61` tokenizer would (letters and digits). */
function ftsTokens(text: string): string[] {
  return text.match(/[\p{L}\p{N}\p{M}]+/gu) ?? [];
}

function quote(text: string): string {
  return `"${text.replaceAll('"', '""')}"`;
}

function termExpr(term: QueryTerm): string | undefined {
  const tokens = ftsTokens(term.text);
  if (tokens.length === 0) return undefined;
  if (term.phrase || tokens.length > 1) {
    // "a-b" or "a.b" is a phrase of its tokens, like FTS5 does for unquoted punctuation.
    return quote(tokens.join(" "));
  }
  return `${quote(tokens[0] ?? "")}${term.prefix ? "*" : ""}`;
}

/** FTS5 MATCH expression for the positive terms, or `undefined` when there are none. */
export function toFtsMatch(terms: QueryTerm[]): string | undefined {
  let expr = "";
  for (const term of terms) {
    const e = termExpr(term);
    if (e === undefined) continue;
    expr = expr.length === 0 ? e : `${expr} ${term.or ? "OR" : "AND"} ${e}`;
  }
  return expr.length === 0 ? undefined : expr;
}

/** FTS5 MATCH expression that matches any excluded term, or `undefined`. */
export function toFtsExclusion(excluded: QueryTerm[]): string | undefined {
  const parts = excluded.map(termExpr).filter((e): e is string => e !== undefined);
  return parts.length === 0 ? undefined : parts.join(" OR ");
}

/** Lower-case word tokens of the positive terms, used for highlighting outside FTS. */
export function highlightTokens(parsed: ParsedQuery): string[] {
  return parsed.terms.flatMap((t) => ftsTokens(t.text.toLowerCase()));
}
