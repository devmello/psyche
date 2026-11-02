import type { GraphEntityKind, GraphFact } from "@psyche/protocol";
import type { GraphStore } from "./store.ts";

/**
 * Coming up (docs/design/everything-memory-2026.md §12.3, §12.5): birthdays, anniversaries and
 * dated events in the next days, from facts the owner accepted (or added from their own words)
 * and from event entities. Deterministic; no model reads a date here.
 */

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
const monthOf = (word: string): number | undefined => {
  const w = word.toLowerCase().replace(/\.$/, "");
  const i = MONTHS.findIndex((m) => m === w || (w.length >= 3 && m.startsWith(w)));
  return i < 0 ? undefined : i + 1;
};

export interface MonthDay {
  month: number;
  day: number;
  year?: number;
}

/**
 * "May 3", "3 May", "May 3, 1990", "3rd of May 1990", "1990-05-03", "05-03". Numeric `a/b` is
 * not guessed (month first or day first): it is read only when one side cannot be a month.
 */
export function parseMonthDay(value: string): MonthDay | undefined {
  const v = value.trim();
  const valid = (month: number, day: number, year?: number): MonthDay | undefined =>
    month >= 1 && month <= 12 && day >= 1 && day <= 31
      ? { month, day, ...(year === undefined ? {} : { year }) }
      : undefined;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(v);
  if (m) return valid(Number(m[2]), Number(m[3]), Number(m[1]));
  m = /^(?:--)?(\d{1,2})-(\d{1,2})$/.exec(v);
  if (m) return valid(Number(m[1]), Number(m[2]));
  m = /^([A-Za-z]{3,9}\.?)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?$/.exec(v);
  if (m) {
    const mo = monthOf(m[1] as string);
    return mo === undefined ? undefined : valid(mo, Number(m[2]), m[3] ? Number(m[3]) : undefined);
  }
  m = /^(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?([A-Za-z]{3,9}\.?)(?:,?\s+(\d{4}))?$/.exec(v);
  if (m) {
    const mo = monthOf(m[2] as string);
    return mo === undefined ? undefined : valid(mo, Number(m[1]), m[3] ? Number(m[3]) : undefined);
  }
  m = /^(\d{1,2})[/.](\d{1,2})(?:[/.](\d{4}))?$/.exec(v);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const year = m[3] ? Number(m[3]) : undefined;
    if (a > 12 && b <= 12) return valid(b, a, year);
    if (b > 12 && a <= 12) return valid(a, b, year);
  }
  return undefined;
}

export type UpcomingKind = "birthday" | "anniversary" | "event";

export interface UpcomingItem {
  entityId: string;
  name: string;
  entityKind: GraphEntityKind;
  kind: UpcomingKind;
  /** The next occurrence, `YYYY-MM-DD` in the owner's zone. */
  date: string;
  daysAway: number;
  /** The age or number of years it will be, when the year is known. */
  turns: number | null;
  /** The last time the owner and this person were in touch, if ever. */
  lastContactAt: string | null;
}

const DAY_MS = 86_400_000;

function localDate(ms: number, timeZone: string): { y: number; m: number; d: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(ms));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return { y: get("year"), m: get("month"), d: get("day") };
}

const utcDay = (y: number, m: number, d: number): number => Date.UTC(y, m - 1, d);
const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function upcoming(
  graph: GraphStore,
  opts: {
    now: number;
    days: number;
    timeZone?: string;
    entityId?: string;
    /** Only facts this accepts are read (relationship nudges drop anything sensitive). */
    fact?: (fact: GraphFact) => boolean;
  },
): UpcomingItem[] {
  const tz = opts.timeZone ?? "UTC";
  const today = localDate(opts.now, tz);
  const start = utcDay(today.y, today.m, today.d);
  const out: UpcomingItem[] = [];
  const people = opts.entityId
    ? [graph.getEntity(opts.entityId)].filter((e) => e !== undefined)
    : graph.listEntities(["person", "org", "event"]);
  for (const e of people) {
    if (e === undefined || e.hidden || e.status !== "active") continue;
    const lastContactAt = e.lastInteractionAt ?? null;
    if (e.kind === "event") {
      if (e.dueAt === null || e.dueAt === undefined) continue;
      const when = Date.parse(e.dueAt);
      const at = localDate(when, tz);
      const day = utcDay(at.y, at.m, at.d);
      const away = Math.round((day - start) / DAY_MS);
      if (away >= 0 && away <= opts.days) {
        out.push({
          entityId: e.id,
          name: e.name,
          entityKind: e.kind,
          kind: "event",
          date: iso(day),
          daysAway: away,
          turns: null,
          lastContactAt,
        });
      }
      continue;
    }
    for (const f of graph.facts(e.id)) {
      if (f.attribute !== "birthday" && f.attribute !== "anniversary") continue;
      if (opts.fact !== undefined && !opts.fact(f)) continue;
      const md = parseMonthDay(f.value);
      if (md === undefined) continue;
      for (const year of [today.y, today.y + 1]) {
        // 29 February is kept on the 28th in years without one.
        const day = md.month === 2 && md.day === 29 && !isLeap(year) ? 28 : md.day;
        const at = utcDay(year, md.month, day);
        const away = Math.round((at - start) / DAY_MS);
        if (away < 0) continue;
        if (away <= opts.days) {
          out.push({
            entityId: e.id,
            name: e.name,
            entityKind: e.kind,
            kind: f.attribute,
            date: iso(at),
            daysAway: away,
            turns: md.year === undefined ? null : year - md.year,
            lastContactAt,
          });
        }
        break;
      }
    }
  }
  return out.sort((a, b) => a.daysAway - b.daysAway || a.name.localeCompare(b.name));
}

const WEEKDAY = new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: "UTC" });
const MONTH_DAY = new Intl.DateTimeFormat("en-US", {
  month: "long",
  day: "numeric",
  timeZone: "UTC",
});

const ago = (iso: string | null, now: number): string | undefined => {
  if (iso === null) return undefined;
  const days = Math.floor((now - Date.parse(iso)) / DAY_MS);
  if (days < 0) return undefined;
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 14) return `${days} days ago`;
  if (days < 60) return `${Math.round(days / 7)} weeks ago`;
  return `${Math.round(days / 30)} months ago`;
};

/** "Ava turns 7 on Friday (May 3); you last talked 3 weeks ago." One plain line. */
export function describeUpcoming(i: UpcomingItem, now: number): string {
  const when =
    i.daysAway === 0
      ? "today"
      : i.daysAway === 1
        ? "tomorrow"
        : i.daysAway < 7
          ? `on ${WEEKDAY.format(new Date(`${i.date}T00:00:00Z`))}`
          : `on ${MONTH_DAY.format(new Date(`${i.date}T00:00:00Z`))}`;
  const turns = i.turns !== null && i.turns > 0 ? ` turns ${i.turns}` : "";
  const subject =
    i.kind === "birthday"
      ? turns !== ""
        ? `${i.name}${turns} ${when}`
        : `${i.name}'s birthday is ${when}`
      : i.kind === "anniversary"
        ? i.turns !== null && i.turns > 0
          ? `${i.name}'s ${i.turns}-year anniversary is ${when}`
          : `${i.name}'s anniversary is ${when}`
        : `${i.name} is ${when}`;
  const last = i.entityKind === "person" ? ago(i.lastContactAt, now) : undefined;
  return last === undefined ? subject : `${subject}; you last talked ${last}`;
}
