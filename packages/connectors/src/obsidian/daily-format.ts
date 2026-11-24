/**
 * Obsidian's daily-note name and template (the core Daily notes plugin, `.obsidian/daily-notes.json`).
 * The format is a moment.js format: this module supports the tokens owners use, with English names
 * and the en locale's weeks (Sunday first, the week that holds 1 January is week 1). Any other
 * letter is unknown, and an unknown format falls back to YYYY-MM-DD rather than writing an odd path.
 */

export const DEFAULT_DAILY_FORMAT = "YYYY-MM-DD";

const DAY_MS = 86_400_000;
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Longest first, so `MMMM` wins over `MMM` and `Do` over `D`. */
const TOKENS = [
  "YYYY",
  "gggg",
  "YY",
  "MMMM",
  "MMM",
  "MM",
  "M",
  "DDDD",
  "DDD",
  "DD",
  "Do",
  "D",
  "dddd",
  "ddd",
  "dd",
  "d",
  "ww",
  "w",
] as const;

interface Day {
  year: number;
  month: number;
  day: number;
  dow: number;
  dayOfYear: number;
  weekYear: number;
  week: number;
}

const pad = (n: number, width: number) => String(n).padStart(width, "0");

/** Milliseconds of the Sunday that starts week 1 of `year` (the week holding 1 January). */
function week1Start(year: number): number {
  const jan1 = Date.UTC(year, 0, 1);
  return jan1 - new Date(jan1).getUTCDay() * DAY_MS;
}

function parseDay(date: string): Day | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (m === null) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const ms = Date.UTC(year, month - 1, day);
  const dt = new Date(ms);
  if (dt.getUTCFullYear() !== year || dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) {
    return null;
  }
  const dow = dt.getUTCDay();
  const weekStart = ms - dow * DAY_MS;
  const weekYear = [year + 1, year, year - 1].find((y) => weekStart >= week1Start(y)) ?? year;
  return {
    year,
    month,
    day,
    dow,
    dayOfYear: Math.round((ms - Date.UTC(year, 0, 1)) / DAY_MS) + 1,
    weekYear,
    week: Math.round((weekStart - week1Start(weekYear)) / (7 * DAY_MS)) + 1,
  };
}

function ordinal(n: number): string {
  const last2 = n % 100;
  if (last2 >= 11 && last2 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

function render(token: (typeof TOKENS)[number], d: Day): string {
  switch (token) {
    case "YYYY":
      return pad(d.year, 4);
    case "YY":
      return pad(d.year % 100, 2);
    case "gggg":
      return pad(d.weekYear, 4);
    case "MMMM":
      return MONTHS[d.month - 1] ?? "";
    case "MMM":
      return (MONTHS[d.month - 1] ?? "").slice(0, 3);
    case "MM":
      return pad(d.month, 2);
    case "M":
      return String(d.month);
    case "DDDD":
      return pad(d.dayOfYear, 3);
    case "DDD":
      return String(d.dayOfYear);
    case "DD":
      return pad(d.day, 2);
    case "Do":
      return ordinal(d.day);
    case "D":
      return String(d.day);
    case "dddd":
      return WEEKDAYS[d.dow] ?? "";
    case "ddd":
      return (WEEKDAYS[d.dow] ?? "").slice(0, 3);
    case "dd":
      return (WEEKDAYS[d.dow] ?? "").slice(0, 2);
    case "d":
      return String(d.dow);
    case "ww":
      return pad(d.week, 2);
    case "w":
      return String(d.week);
  }
}

/**
 * The date (YYYY-MM-DD) in a moment.js-style format, or null when the format holds a letter that
 * is not a supported token (`[...]` is literal text). Used for file names and template `{{date}}`.
 */
export function formatDailyName(date: string, format: string): string | null {
  const d = parseDay(date);
  if (d === null) return null;
  let out = "";
  let i = 0;
  while (i < format.length) {
    if (format[i] === "[") {
      const end = format.indexOf("]", i);
      if (end < 0) return null;
      out += format.slice(i + 1, end);
      i = end + 1;
      continue;
    }
    const token = TOKENS.find((t) => format.startsWith(t, i));
    if (token !== undefined) {
      out += render(token, d);
      i += token.length;
      continue;
    }
    if (/[A-Za-z]/.test(format[i] ?? "")) return null;
    out += format[i];
    i += 1;
  }
  return out;
}

/** A relative path that names a file under the vault: no empty, dot or hidden segments, no odd characters. */
function isSafeRelativePath(name: string): boolean {
  return name.split("/").every((s) => s !== "" && !s.startsWith(".") && !/[\0:*?"<>|\\]/.test(s));
}

/**
 * The daily note's vault-relative name without `.md`, e.g. `2026/10/2026-10-22`. A format that is
 * not understood, or that would not name a file inside the vault, falls back to YYYY-MM-DD.
 */
export function dailyNoteName(date: string, format: unknown): string {
  const f = typeof format === "string" && format.trim() !== "" ? format : DEFAULT_DAILY_FORMAT;
  const name = formatDailyName(date, f);
  if (name !== null && isSafeRelativePath(name)) return name;
  return formatDailyName(date, DEFAULT_DAILY_FORMAT) ?? date;
}

/**
 * Obsidian's template variables for a new daily note: `{{date}}` and `{{date:FORMAT}}`,
 * `{{title}}` (the note's name) and `{{time}}` (local HH:mm now). Other text is left as it is.
 */
export function renderDailyTemplate(text: string, date: string, title: string, now: Date): string {
  return text.replace(
    /\{\{\s*(date|time|title)(?::([^}]*))?\s*\}\}/g,
    (_match, key: string, fmt: string | undefined) => {
      if (key === "title") return title;
      if (key === "time") return `${pad(now.getHours(), 2)}:${pad(now.getMinutes(), 2)}`;
      const f = fmt?.trim() || DEFAULT_DAILY_FORMAT;
      return formatDailyName(date, f) ?? formatDailyName(date, DEFAULT_DAILY_FORMAT) ?? date;
    },
  );
}

/** Today's date (YYYY-MM-DD) on the machine's clock: the owner's time zone. */
export function localDay(now: Date): string {
  return `${pad(now.getFullYear(), 4)}-${pad(now.getMonth() + 1, 2)}-${pad(now.getDate(), 2)}`;
}
