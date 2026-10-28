/**
 * Query rewrites the eval compares (docs/design/search-roadmap-2026.md §4):
 *
 * - `raw`: the question exactly as typed. Today's Search screen ANDs every bare word, so most
 *   English questions match nothing.
 * - `keywords`: stop words dropped, the rest ORed, so BM25 ranks by how many terms a doc has.
 * - `rules`: `keywords` plus rule-based pre-filters for time ("last week", "in September",
 *   "next Thursday"), people ("from Maya", "Maya said") and source words ("email", "pdf").
 *   A prototype of the query-understanding step, with no model.
 *
 * Filter tokens the user typed (`from:maya`, `type:pdf`) pass through every rewrite unchanged.
 */

export type RewriteMode = "raw" | "keywords" | "rules";

export interface Rewrite {
  q: string;
  /** The same query with every pre-filter the rules added removed (used when it finds nothing). */
  fallback?: string;
}

const STOP = new Set(
  `a about above after again all am an and any are as at be been before being below between both
  but by can could did do does doing down during each few for from further had has have having he
  her here hers him his how i if in into is it its itself just me more most my myself no nor not
  of off on once only or other our ours out over own same she should so some such than that the
  their theirs them then there these they this those through to too under until up very was we
  were what when where which while who whom why will with would you your yours anything something
  everything thing things tell show find give get got know remember remind recall please list
  ever said say says sent send told ask asked mention mentioned wanted want need also there's
  what's whats when's where's i'm im let's lets one ones`
    .split(/\s+/)
    .filter(Boolean),
);

const FILTER_KEYS = /^-?(in|type|from|before|after|on|has|is|thread):\S+$/i;

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const DAY = 86_400_000;

/** Words that pick a source; each maps to a filter the query language already has. */
const SOURCE_WORDS: Record<string, string> = {
  email: "in:connectors",
  emails: "in:connectors",
  mail: "in:connectors",
  inbox: "in:connectors",
  text: "in:connectors",
  texts: "in:connectors",
  texted: "in:connectors",
  imessage: "in:connectors",
  note: "in:connectors",
  notes: "in:connectors",
  calendar: "in:connectors",
  event: "in:connectors",
  reminder: "in:connectors",
  reminders: "in:connectors",
  pdf: "type:pdf",
  pdfs: "type:pdf",
  spreadsheet: "type:sheet",
  task: "in:tasks",
  tasks: "in:tasks",
};

function ymd(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Midnight (in the owner's zone) of the day containing `ms`, as epoch ms. */
function startOfDay(ms: number, tz: number): number {
  const local = ms + tz * 60_000;
  return local - (local % DAY) - tz * 60_000;
}

function range(from: number, to: number): string[] {
  return [`after:${ymd(from)}`, `before:${ymd(to)}`];
}

/** Temporal phrases → `after:` / `before:` filters; returns the filters and the leftover text. */
export function temporal(text: string, now: number, tz = 0): { filters: string[]; rest: string } {
  const today = startOfDay(now, tz) + tz * 60_000; // calendar-date anchor for ymd()
  const dow = new Date(today).getUTCDay();
  const monday = today - ((dow + 6) % 7) * DAY;
  const year = new Date(today).getUTCFullYear();
  const filters: string[] = [];
  let rest = ` ${text.toLowerCase()} `;
  const take = (re: RegExp, f: (m: RegExpMatchArray) => string[] | undefined) => {
    const m = rest.match(re);
    if (m === null) return;
    const out = f(m);
    if (out === undefined) return;
    filters.push(...out);
    rest = rest.replace(re, " ");
  };

  take(/\btoday\b|\bthis morning\b|\btonight\b/, () => range(today, today + DAY));
  take(/\byesterday\b/, () => range(today - DAY, today));
  take(/\b(?:last|past) (\d+) days\b/, (m) => range(today - Number(m[1]) * DAY, today + DAY));
  take(/\blast week\b/, () => range(monday - 7 * DAY, monday));
  take(/\bthis week\b/, () => range(monday, monday + 7 * DAY));
  take(/\bnext week\b/, () => range(monday + 7 * DAY, monday + 14 * DAY));
  take(/\b(last|this) weekend\b/, (m) => {
    const sat = monday + (m[1] === "last" ? -2 : 5) * DAY;
    return range(sat, sat + 2 * DAY);
  });
  take(/\blast month\b/, () => {
    const d = new Date(today);
    return range(Date.UTC(year, d.getUTCMonth() - 1, 1), Date.UTC(year, d.getUTCMonth(), 1));
  });
  take(/\bthis month\b/, () => {
    const d = new Date(today);
    return range(Date.UTC(year, d.getUTCMonth(), 1), Date.UTC(year, d.getUTCMonth() + 1, 1));
  });
  take(new RegExp(`\\b(last|next|this) (${WEEKDAYS.join("|")})\\b`), (m) => {
    const want = WEEKDAYS.indexOf(m[2] ?? "");
    let delta = want - dow;
    if (m[1] === "last") delta = delta >= 0 ? delta - 7 : delta;
    else if (m[1] === "next") delta = delta <= 0 ? delta + 7 : delta;
    const day = today + delta * DAY;
    return range(day, day + DAY);
  });
  take(new RegExp(`\\b(?:in |during |since )?(${MONTHS.join("|")})\\b`), (m) => {
    const i = MONTHS.indexOf(m[1] ?? "");
    // "may" is also a verb; only take it with a preposition.
    if (i === 4 && !/\b(in|during|since) may\b/.test(rest)) return undefined;
    if (/\bsince\b/.test(m[0])) return [`after:${ymd(Date.UTC(year, i, 1))}`];
    return range(Date.UTC(year, i, 1), Date.UTC(year, i + 1, 1));
  });
  return { filters, rest: rest.trim() };
}

/** Lowercased content words, punctuation and possessives stripped, stop words dropped. */
export function contentWords(text: string): string[] {
  return text
    .split(/\s+/)
    .map((w) =>
      w
        .replace(/[’']s$/i, "")
        .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "")
        .toLowerCase(),
    )
    .filter((w) => w.length > 1 && !STOP.has(w) && w !== "or");
}

function orJoin(words: readonly string[]): string {
  return [...new Set(words)].join(" OR ");
}

/** Capitalised words after "from" or before "said/texted/…": the people the question is about. */
function people(original: string): string[] {
  const out = new Set<string>();
  for (const m of original.matchAll(/\bfrom ([A-Z][\p{L}]+)/gu)) out.add(m[1] ?? "");
  for (const m of original.matchAll(
    /\b([A-Z][\p{L}]+) (?:said|say|says|sent|text|texted|email|emailed|wrote|asked|told|mentioned)\b/gu,
  ))
    out.add(m[1] ?? "");
  out.delete("");
  out.delete("I");
  return [...out].map((p) => `from:${p.toLowerCase()}`);
}

export function rewrite(q: string, mode: RewriteMode, now: number, tz = 0): Rewrite {
  if (mode === "raw") return { q };
  const typed = q.split(/\s+/).filter((t) => FILTER_KEYS.test(t));
  const free = q
    .split(/\s+/)
    .filter((t) => !FILTER_KEYS.test(t))
    .join(" ");
  if (mode === "keywords") {
    const words = contentWords(free);
    return { q: [...typed, orJoin(words)].filter(Boolean).join(" ") };
  }
  const t = temporal(free, now, tz);
  const who = people(free);
  const words = contentWords(t.rest);
  const sources = [...new Set(words.flatMap((w) => SOURCE_WORDS[w] ?? []))].slice(0, 1);
  const kept = words.filter((w) => SOURCE_WORDS[w] === undefined);
  const added = [...t.filters, ...who, ...sources];
  const body = orJoin(kept.length > 0 ? kept : words);
  const full = [...typed, ...added, body].filter(Boolean).join(" ");
  if (added.length === 0) return { q: full };
  return { q: full, fallback: [...typed, orJoin(contentWords(free))].filter(Boolean).join(" ") };
}
