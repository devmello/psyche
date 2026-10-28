/**
 * Query understanding for plain-English questions (docs/design/search-roadmap-2026.md §4, R1/R6).
 *
 * "what did Alex send me about the lease last week?" is not a search expression: ANDing every
 * word matches nothing. `understand` rewrites it, with rules and no model, into queries in the
 * language `query-parser.ts` already speaks:
 *
 *   from:alex after:2026-10-12 before:2026-10-19 send OR lease        (filtered)
 *   send OR lease OR alex OR last OR week                              (filters relaxed)
 *
 * - Stop words are dropped (English, with short Spanish, Portuguese, French and German lists)
 *   and the content words are ORed, so BM25 ranks by how many of them a document has.
 * - `"exact phrases"` stay required and typed syntax (`from:`, `in:`, `type:`, `source:`,
 *   `before:`, …, `-excluded`) passes through untouched.
 * - Rule-based filters become *chips* the Search screen can show and remove: time phrases
 *   ("last week", "in March", "two days ago"), people ("from Alex", "with Sam"), sources and
 *   file types ("in my email", "PDF").
 * - `attempts` is the ladder the index walks: filtered, then without the chips, then OR over
 *   every word. It never ends in zero results while some document has one of the words.
 *
 * Short input (fewer than four words, no "?") is left as typed, so ⌘K keeps its prefix-AND.
 */

export type SearchIntent = "find" | "answer" | "list";
export type ChipKind = "time" | "person" | "source" | "type";

export interface QueryChip {
  /** Stable id (`time:last week`); send it back as `dropChips` to turn the chip off. */
  id: string;
  kind: ChipKind;
  /**
   * `time`: the phrase as typed ("last week"); `person`: the name ("Alex"); `source`: a source
   * key (`mail`, `imessage`, `notes`, `calendar`, `reminders`, `files`); `type`: a file type
   * (`pdf`, `image`, `sheet`).
   */
  label: string;
  /** The query-language tokens the chip stands for. */
  token: string;
}

export interface Attempt {
  q: string;
  /** `none`: as understood; `filters`: chips dropped; `or`: OR over every word. */
  relaxed: "none" | "filters" | "or";
}

export interface Understanding {
  /** The input read as a question; false for short input, which runs as typed. */
  natural: boolean;
  intent: SearchIntent;
  chips: QueryChip[];
  /** Queries to try in order; the first is the best reading. */
  attempts: Attempt[];
}

export interface UnderstandOptions {
  /** Epoch ms for relative phrases. */
  now: number;
  /** Minutes east of UTC of the owner's zone. */
  tzOffsetMinutes?: number;
  /** Names/addresses a person is known by (the people graph or contacts), or undefined. */
  resolvePerson?: (name: string) => readonly string[] | undefined;
  /** Chip ids the user removed. */
  disabled?: readonly string[];
}

const DAY = 86_400_000;

const STOP = new Set(
  `a about above after again all am an and any are as at be been before being below between both
  but by can could did do does doing down during each few for from further had has have having he
  her here hers him his how i if in into is it its itself just me more most my myself no nor not
  of off on once only or other our ours out over own same she should so some such than that the
  their theirs them then there these they this those through to too under until up very was we
  were what when where which while who whom why will with would you your yours anything something
  everything thing things tell show find give get got know remember remind recall please list
  ever said say says sent send told ask asked mention mentioned wanted want need also there's
  what's whats when's where's i'm im let's lets one ones
  el la los las un una unos unas de del al y o en con por para que qué como cómo cuál cuando cuándo
  donde dónde quién es son fue era está están mi mis tu tus su sus se lo le les me te nos ya
  um uma uns umas do da dos das no na nos nas em com por para que como qual quando onde quem é são
  foi era está estão meu minha meus minhas seu sua seus suas se lhe eu você ele ela
  le la les un une des du de et ou dans avec pour que qui quoi quel quelle quand où est sont été
  mon ma mes ton ta tes son sa ses je tu il elle nous vous ils elles ne pas
  der die das ein eine einen dem den des und oder in mit für dass was wer wie wann wo ist sind war
  mein meine dein deine sein seine ich du er sie es wir ihr nicht auf von zu im am`
    .split(/\s+/)
    .filter(Boolean),
);

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
const NUMBER_WORDS: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  couple: 2,
  few: 3,
};
const NUM = `(\\d{1,3}|${Object.keys(NUMBER_WORDS).join("|")})`;

/** Source words → the `source:` value they select. Ambiguous words need "in my …". */
const SOURCE_WORDS: Record<string, { source: string; needsPrep: boolean }> = {
  email: { source: "mail", needsPrep: false },
  emails: { source: "mail", needsPrep: false },
  emailed: { source: "mail", needsPrep: false },
  mail: { source: "mail", needsPrep: true },
  inbox: { source: "mail", needsPrep: false },
  imessage: { source: "imessage", needsPrep: false },
  imessages: { source: "imessage", needsPrep: false },
  texts: { source: "imessage", needsPrep: false },
  texted: { source: "imessage", needsPrep: false },
  text: { source: "imessage", needsPrep: true },
  notes: { source: "notes", needsPrep: true },
  note: { source: "notes", needsPrep: true },
  calendar: { source: "calendar", needsPrep: false },
  event: { source: "calendar", needsPrep: true },
  events: { source: "calendar", needsPrep: true },
  reminder: { source: "reminders", needsPrep: false },
  reminders: { source: "reminders", needsPrep: false },
  tasks: { source: "tasks", needsPrep: false },
  task: { source: "tasks", needsPrep: true },
  files: { source: "files", needsPrep: true },
  documents: { source: "files", needsPrep: true },
};
const TYPE_WORDS: Record<string, string> = {
  pdf: "pdf",
  pdfs: "pdf",
  spreadsheet: "sheet",
  spreadsheets: "sheet",
  photo: "image",
  photos: "image",
  image: "image",
  images: "image",
  screenshot: "image",
  screenshots: "image",
  slides: "slides",
  powerpoint: "slides",
};

const TYPED = /^-?(?:in|type|source|from|before|after|on|has|is|thread):/i;
const NOT_NAMES = new Set([
  ...MONTHS.map((m) => m[0]?.toUpperCase() + m.slice(1)),
  ...WEEKDAYS.map((m) => m[0]?.toUpperCase() + m.slice(1)),
  "I",
  "Psyche",
  "The",
  "My",
  "Me",
  "Last",
  "Next",
  "This",
  "Today",
  "Yesterday",
  "Tomorrow",
]);

const pad = (n: number) => String(n).padStart(2, "0");

/** `YYYY-MM-DD` of a calendar date held as UTC midnight. */
function ymd(cal: number): string {
  const d = new Date(cal);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

const dateRange = (from: number, to: number) => `after:${ymd(from)} before:${ymd(to)}`;

function count(word: string): number {
  return NUMBER_WORDS[word] ?? Number(word);
}

interface TimeRule {
  re: RegExp;
  /** The filter tokens, or undefined to leave the phrase as text. */
  to: (m: RegExpExecArray, c: Calendar) => string | undefined;
}

interface Calendar {
  today: number;
  monday: number;
  dow: number;
  year: number;
  month: number;
}

function calendar(now: number, tzMin: number): Calendar {
  const local = now + tzMin * 60_000;
  const today = Math.floor(local / DAY) * DAY;
  const d = new Date(today);
  const dow = d.getUTCDay();
  return {
    today,
    monday: today - ((dow + 6) % 7) * DAY,
    dow,
    year: d.getUTCFullYear(),
    month: d.getUTCMonth(),
  };
}

const utc = (y: number, m: number, d = 1) => Date.UTC(y, m, d);

/** Ordered: the first rule that matches wins, so longer phrases come before their parts. */
const TIME_RULES: TimeRule[] = [
  {
    re: /\bday before yesterday\b/,
    to: (_m, c) => dateRange(c.today - 2 * DAY, c.today - DAY),
  },
  { re: /\byesterday\b/, to: (_m, c) => dateRange(c.today - DAY, c.today) },
  {
    re: /\b(?:today|tonight|this (?:morning|afternoon|evening))\b/,
    to: (_m, c) => dateRange(c.today, c.today + DAY),
  },
  {
    re: new RegExp(`\\b${NUM} days? ago\\b`),
    to: (m, c) => {
      const day = c.today - count(m[1] ?? "1") * DAY;
      return dateRange(day, day + DAY);
    },
  },
  {
    re: new RegExp(`\\b${NUM} weeks? ago\\b`),
    to: (m, c) => {
      const day = c.today - count(m[1] ?? "1") * 7 * DAY;
      return dateRange(day - 3 * DAY, day + 4 * DAY);
    },
  },
  {
    re: new RegExp(`\\b${NUM} months? ago\\b`),
    to: (m, c) => {
      const day = c.today - count(m[1] ?? "1") * 30 * DAY;
      return dateRange(day - 15 * DAY, day + 15 * DAY);
    },
  },
  {
    re: new RegExp(`\\b(?:in )?(?:the )?(?:last|past) ${NUM} (days?|weeks?|months?)\\b`),
    to: (m, c) => lastN(m, c),
  },
  { re: /\blast week\b/, to: (_m, c) => dateRange(c.monday - 7 * DAY, c.monday) },
  { re: /\bthis week\b/, to: (_m, c) => dateRange(c.monday, c.monday + 7 * DAY) },
  { re: /\bnext week\b/, to: (_m, c) => dateRange(c.monday + 7 * DAY, c.monday + 14 * DAY) },
  {
    re: /\b(last|this) weekend\b/,
    to: (m, c) => {
      const sat = c.monday + (m[1] === "last" ? -2 : 5) * DAY;
      return dateRange(sat, sat + 2 * DAY);
    },
  },
  {
    re: /\blast month\b/,
    to: (_m, c) => dateRange(utc(c.year, c.month - 1), utc(c.year, c.month)),
  },
  {
    re: /\bthis month\b/,
    to: (_m, c) => dateRange(utc(c.year, c.month), utc(c.year, c.month + 1)),
  },
  { re: /\blast year\b/, to: (_m, c) => dateRange(utc(c.year - 1, 0), utc(c.year, 0)) },
  { re: /\bthis year\b/, to: (_m, c) => dateRange(utc(c.year, 0), utc(c.year + 1, 0)) },
  {
    re: new RegExp(`\\b(last|next|this) (${WEEKDAYS.join("|")})\\b`),
    to: (m, c) => {
      const want = WEEKDAYS.indexOf(m[2] ?? "");
      let delta = want - c.dow;
      if (m[1] === "last") delta = delta >= 0 ? delta - 7 : delta;
      else if (m[1] === "next") delta = delta <= 0 ? delta + 7 : delta;
      const day = c.today + delta * DAY;
      return dateRange(day, day + DAY);
    },
  },
  {
    re: new RegExp(
      `\\b(since|in|during) (?:(?:early|mid|late|the start of|the end of) )?(${MONTHS.join("|")})(?: (20\\d\\d))?\\b`,
    ),
    to: (m, c) => {
      const i = MONTHS.indexOf(m[2] ?? "");
      // A month that has not come yet this year means last year's.
      const year = m[3] !== undefined ? Number(m[3]) : i > c.month ? c.year - 1 : c.year;
      if (m[1] === "since") return `after:${ymd(utc(year, i))}`;
      return dateRange(utc(year, i), utc(year, i + 1));
    },
  },
  {
    re: new RegExp(`\\b(${MONTHS.filter((x) => x !== "may").join("|")})(?: (20\\d\\d))\\b`),
    to: (m) => {
      const i = MONTHS.indexOf(m[1] ?? "");
      const year = Number(m[2]);
      return dateRange(utc(year, i), utc(year, i + 1));
    },
  },
  {
    re: /\bin (20\d\d)\b/,
    to: (m) => dateRange(utc(Number(m[1]), 0), utc(Number(m[1]) + 1, 0)),
  },
];

function lastN(m: RegExpExecArray, c: Calendar): string {
  const n = count(m[1] ?? "1");
  const unit = (m[2] ?? "d").startsWith("w") ? 7 : (m[2] ?? "d").startsWith("m") ? 30 : 1;
  return dateRange(c.today - n * unit * DAY, c.today + DAY);
}

/** Replaces `[start, end)` with spaces so offsets in the parallel strings stay aligned. */
function blank(s: string, start: number, end: number): string {
  return s.slice(0, start) + " ".repeat(end - start) + s.slice(end);
}

function quoteValue(v: string): string {
  return /\s/.test(v) ? `"${v}"` : v;
}

/** Lower-case content words: punctuation and possessives stripped, stop words dropped. */
export function contentWords(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\s+/)) {
    const w = raw
      .replace(/[’']s$/i, "")
      .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "")
      .toLowerCase();
    if (w.length === 0 || STOP.has(w)) continue;
    if (w.length < 2 && !/\d/.test(w)) continue;
    if (!out.includes(w)) out.push(w);
  }
  return out;
}

const orJoin = (words: readonly string[]) => words.join(" OR ");

function intentOf(text: string): SearchIntent {
  const t = text.trim().toLowerCase();
  if (/\b(?:list|every|all (?:of )?(?:my|the)|show me all|how many)\b/.test(t)) return "list";
  if (
    t.includes("?") ||
    /^(?:what|when|where|who|whom|whose|why|how|which|is|are|was|were|do|does|did|can|could|should|will|would|tell me)\b/.test(
      t,
    )
  )
    return "answer";
  return "find";
}

/** Splits input into typed syntax, quoted phrases and free text. */
function split(input: string): { typed: string[]; phrases: string[]; free: string } {
  const typed: string[] = [];
  const phrases: string[] = [];
  const free: string[] = [];
  const re = /(-?[a-zA-Z]+:"[^"]*"|-?[a-zA-Z]+:\S+|-"[^"]*"|"[^"]*"|"[^"]*$|-\S+|\S+)/g;
  for (const m of input.matchAll(re)) {
    const t = m[0];
    if (TYPED.test(t) || (t.startsWith("-") && t.length > 1)) typed.push(t);
    else if (t.startsWith('"')) {
      const inner = t.replace(/^"|"$/g, "");
      if (inner.trim().length > 0) phrases.push(`"${inner.trim()}"`);
    } else free.push(t);
  }
  return { typed, phrases, free: free.join(" ") };
}

/** Number of words that make a question rather than a lookup. */
const NATURAL_WORDS = 4;

export function understand(input: string, opts: UnderstandOptions): Understanding {
  const { typed, phrases, free } = split(input.normalize("NFC"));
  const disabled = new Set(opts.disabled ?? []);
  const words = free.split(/\s+/).filter(Boolean);
  const natural = words.length >= NATURAL_WORDS || free.includes("?");
  const intent = intentOf(free);
  const allWords = contentWords(free);
  const keep = [...typed];

  // Short input runs as typed (⌘K keeps prefix-AND). Only a miss relaxes it, to OR.
  if (!natural) {
    const asTyped = input.trim();
    const attempts: Attempt[] = [{ q: asTyped, relaxed: "none" }];
    const hasOr = /\bOR\b/.test(free);
    if (!hasOr && allWords.length >= 2) {
      attempts.push({
        q: [...keep, ...phrases, orJoin(allWords)].join(" "),
        relaxed: "or",
      });
    }
    return { natural: false, intent, chips: [], attempts };
  }

  const tz = opts.tzOffsetMinutes ?? 0;
  const cal = calendar(opts.now, tz);
  let orig = free;
  let low = free.toLowerCase();
  const chips: QueryChip[] = [];
  const nameWords: string[] = [];
  const add = (chip: QueryChip, start: number, end: number): void => {
    if (disabled.has(chip.id)) return;
    chips.push(chip);
    orig = blank(orig, start, end);
    low = blank(low, start, end);
  };

  // 1. Time: the first phrase that matches.
  for (const rule of TIME_RULES) {
    const m = rule.re.exec(low);
    if (m === null) continue;
    const token = rule.to(m, cal);
    if (token === undefined) continue;
    const phrase = m[0].trim();
    if (disabled.has(`time:${phrase}`)) continue;
    add(
      { id: `time:${phrase}`, kind: "time", label: phrase, token },
      m.index,
      m.index + m[0].length,
    );
    break;
  }

  // 2. People: "from Alex", "with Sam", "Maya said".
  const name = "\\p{Lu}[\\p{L}'’-]+(?:\\s+\\p{Lu}[\\p{L}'’-]+)?";
  const personRes = [
    new RegExp(`\\b(?:[Ff]rom|[Ww]ith|[Bb]y)\\s+(${name})`, "u"),
    new RegExp(
      `(${name})\\s+(?:said|says|say|sent|send|texted|text|emailed|email|wrote|write|asked|ask|told|tell|mentioned|mention|messaged|message|replied|reply)\\b`,
      "u",
    ),
  ];
  for (const re of personRes) {
    for (let guard = 0; guard < 3; guard += 1) {
      const m = re.exec(orig);
      if (m === null) break;
      const lead = /^(?:[Ff]rom|[Ww]ith|[Bb]y)\s+/.exec(m[0]);
      const raw = (m[1] ?? "").replace(/[’']s$/i, "");
      const first = raw.split(/\s+/)[0] ?? "";
      if (!/^\p{Lu}/u.test(first) || NOT_NAMES.has(first)) break;
      // "from the US": short all-caps words are not names.
      if (first.length <= 3 && first === first.toUpperCase()) break;
      const start = m.index + (lead?.[0].length ?? 0);
      const end = m.index + m[0].length;
      const id = `person:${raw.toLowerCase()}`;
      if (disabled.has(id)) break;
      nameWords.push(...contentWords(raw));
      const aliases = opts.resolvePerson?.(raw);
      const keys = [
        ...new Set([raw.toLowerCase(), ...(aliases ?? []).map((a) => a.toLowerCase())]),
      ];
      const token = keys.map((k) => `from:${quoteValue(k)}`).join(" ");
      // The preposition goes with the chip; for "Maya said" only the name is the chip.
      add(
        { id, kind: "person", label: raw, token },
        lead === null ? start : m.index,
        lead === null ? start + raw.length : end,
      );
    }
  }

  // 3. Source and file type.
  let haveSource = false;
  let haveType = false;
  for (const m of low.matchAll(
    /(?:\b(?:in|on|from|via|over|by)\s+(?:my|the|your)\s+)?([\p{L}]+)/gu,
  )) {
    const word = m[1] ?? "";
    const prep = m[0].length > word.length;
    const src = SOURCE_WORDS[word];
    const type = TYPE_WORDS[word];
    if (src !== undefined && !haveSource && (prep || !src.needsPrep)) {
      const id = `source:${src.source}`;
      if (disabled.has(id)) continue;
      haveSource = true;
      chips.push({ id, kind: "source", label: src.source, token: `source:${src.source}` });
      const start = (m.index ?? 0) + (prep ? 0 : m[0].length - word.length);
      orig = blank(orig, start, (m.index ?? 0) + m[0].length);
      low = blank(low, start, (m.index ?? 0) + m[0].length);
    } else if (type !== undefined && !haveType) {
      const id = `type:${type}`;
      if (disabled.has(id)) continue;
      haveType = true;
      chips.push({ id, kind: "type", label: type, token: `type:${type}` });
      const start = (m.index ?? 0) + (prep ? 0 : m[0].length - word.length);
      orig = blank(orig, start, (m.index ?? 0) + m[0].length);
      low = blank(low, start, (m.index ?? 0) + m[0].length);
    }
  }

  const rest = [...new Set([...nameWords, ...contentWords(orig)])];
  const phraseTerms = phrases;
  const chipTokens = chips.map((c) => c.token);
  const body = (ws: readonly string[]) => (ws.length === 0 ? [] : [orJoin(ws)]);
  const attempts: Attempt[] = [];
  const push = (a: Attempt) => {
    if (!attempts.some((x) => x.q === a.q)) attempts.push(a);
  };
  // Phrases stay required while filters apply; the last rung ORs them in.
  push({ q: [...keep, ...chipTokens, ...phraseTerms, ...body(rest)].join(" "), relaxed: "none" });
  if (chips.length > 0) {
    push({ q: [...keep, ...phraseTerms, ...body(allWords)].join(" "), relaxed: "filters" });
  }
  const orAll = [...phraseTerms, ...allWords];
  push({ q: [...keep, orJoin(orAll)].join(" "), relaxed: "or" });
  return { natural: true, intent, chips, attempts: attempts.filter((a) => a.q.trim().length > 0) };
}

/** Minutes east of UTC of an IANA zone at `ms` (DST aware); 0 for an unknown zone. */
export function tzOffsetMinutesAt(zone: string | undefined, ms: number): number {
  if (zone === undefined) return 0;
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(new Date(ms));
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
    const asUtc = Date.UTC(
      get("year"),
      get("month") - 1,
      get("day"),
      get("hour"),
      get("minute"),
      get("second"),
    );
    return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60_000);
  } catch {
    return 0;
  }
}
