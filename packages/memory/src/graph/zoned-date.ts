import { offsetMinutes } from "./catchup.ts";

/**
 * Due dates in the owner's time zone (docs/design/memory-everything-2026.md §3). A date with no
 * zone means the owner's local time, and a bare date means the end of that day (23:59 local). An
 * explicit `Z` or offset is honoured. Impossible dates (2026-02-31) are refused by a round trip.
 */

const ISO =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

export const validZone = (tz: string): string => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return "UTC";
  }
};

/** The UTC instant at which the owner's wall clock reads this date and time, or undefined. */
export function localToUtc(
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
  timeZone: string,
): number | undefined {
  const probe = new Date(Date.UTC(y, mo - 1, d, h, mi));
  if (
    probe.getUTCFullYear() !== y ||
    probe.getUTCMonth() !== mo - 1 ||
    probe.getUTCDate() !== d ||
    h > 23 ||
    mi > 59
  ) {
    return undefined;
  }
  const tz = validZone(timeZone);
  const wall = probe.getTime();
  let t = wall - offsetMinutes(wall, tz) * 60_000;
  t = wall - offsetMinutes(t, tz) * 60_000;
  return t;
}

/** An ISO date or date-time as UTC ISO in the owner's zone, or null when it is not one. */
export function parseDueInZone(value: string | null | undefined, timeZone: string): string | null {
  if (value === null || value === undefined) return null;
  const m = ISO.exec(value.trim());
  if (m === null) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const hasTime = m[4] !== undefined;
  const h = hasTime ? Number(m[4]) : 23;
  const mi = hasTime ? Number(m[5]) : 59;
  let t: number | undefined;
  if (m[7] !== undefined) {
    const probe = new Date(Date.UTC(y, mo - 1, d));
    if (probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d || h > 23 || mi > 59) {
      return null;
    }
    const zone = m[7] === "Z" ? "+0000" : m[7].replace(":", "");
    const sign = zone.startsWith("-") ? -1 : 1;
    const off = sign * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(3, 5)));
    t = Date.UTC(y, mo - 1, d, h, mi, Number(m[6] ?? 0)) - off * 60_000;
  } else {
    t = localToUtc(y, mo, d, h, mi, timeZone);
  }
  return t === undefined || Number.isNaN(t) ? null : new Date(t).toISOString();
}

/** The owner's local calendar date (`YYYY-MM-DD`) of an instant. */
export function localDate(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: validZone(timeZone),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(ms);
}

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
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
const MONTH_RE = new RegExp(
  `\\b(${MONTHS.map((m) => `${m.slice(0, 3)}(?:${m.slice(3)})?`).join("|")})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`,
);

/**
 * The due date a quote itself states, in the owner's zone: an ISO date, "Nov 9", "tomorrow",
 * "today", or a weekday ("Friday", "next Friday": the next one after today). An optional time
 * ("11:59pm", "23:59") is read; otherwise end of day. Undefined when the quote states no date, so
 * a model-supplied date can never stand on its own (H1).
 */
export function dateInQuote(quote: string, now: number, timeZone: string): string | undefined {
  const tz = validZone(timeZone);
  const q = quote.toLowerCase();
  const [ty, tm, td] = localDate(now, tz).split("-").map(Number) as [number, number, number];
  const addDays = (n: number): [number, number, number] => {
    const d = new Date(Date.UTC(ty, tm - 1, td + n));
    return [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()];
  };
  let ymd: [number, number, number] | undefined;
  const iso = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(q);
  const named = MONTH_RE.exec(q);
  if (iso !== null) {
    ymd = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
  } else if (named !== null) {
    const mo = MONTHS.findIndex((m) => m.startsWith((named[1] as string).slice(0, 3))) + 1;
    let y = ty;
    // A month and day already more than a week behind us mean next year.
    if (Date.UTC(y, mo - 1, Number(named[2])) < Date.UTC(ty, tm - 1, td) - 7 * 86_400_000) y += 1;
    ymd = [y, mo, Number(named[2])];
  } else if (/\btomorrow\b/.test(q)) {
    ymd = addDays(1);
  } else if (/\btoday\b|\btonight\b/.test(q)) {
    ymd = addDays(0);
  } else {
    const wd = new RegExp(`\\b(${WEEKDAYS.join("|")})\\b`).exec(q);
    if (wd !== null) {
      const target = WEEKDAYS.indexOf(wd[1] as string);
      const today = new Date(Date.UTC(ty, tm - 1, td)).getUTCDay();
      let diff = (target - today + 7) % 7;
      if (diff === 0) diff = 7;
      ymd = addDays(diff);
    }
  }
  if (ymd === undefined) return undefined;
  let h = 23;
  let mi = 59;
  const time = /\b(\d{1,2}):(\d{2})\s*(am|pm)?\b|\b(\d{1,2})\s*(am|pm)\b/.exec(q);
  if (time !== null) {
    const ap = time[3] ?? time[5];
    h = Number(time[1] ?? time[4]);
    mi = time[2] === undefined ? 0 : Number(time[2]);
    if (ap === "pm" && h < 12) h += 12;
    if (ap === "am" && h === 12) h = 0;
  }
  const t = localToUtc(ymd[0], ymd[1], ymd[2], h, mi, tz);
  return t === undefined ? undefined : new Date(t).toISOString();
}
