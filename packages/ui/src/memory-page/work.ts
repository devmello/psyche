import type { EntitySummary, GraphWorkStatus } from "@psyche/protocol";
import { activeI18n } from "../i18n/core.ts";

/**
 * Work items for the Memory page (docs/design/memory-everything-2026.md §3.4, §3.6, §6.2): which
 * Work due group a row is in, when a row is stale, and how the one-line quick add reads "Lab
 * report, CHEM 1B, Fri". Pure functions: no I/O, and the caller passes `now`.
 */

const DAY = 86_400_000;

/** The Work due groups, in order (§6.2). */
export const DUE_GROUPS = ["past_due", "this_week", "later", "no_date", "done"] as const;
export type DueGroup = (typeof DUE_GROUPS)[number];

/** Done and dropped items stay in Work due this long (§3.6 Archive). */
export const DONE_WINDOW_DAYS = 14;
/** An assignment with no signal for this long, due within a week, is stale (§3.6). */
export const ASSIGNMENT_FRESH_DAYS = 3;
/** A project with no signal for this long is stale (§3.6). */
export const PROJECT_FRESH_DAYS = 14;

/** Statuses an assignment can be set to, in the order the control shows them (§3.4). */
export const WORK_STATUSES: readonly GraphWorkStatus[] = [
  "not_started",
  "in_progress",
  "submitted",
  "done",
  "dropped",
];

type Row = Pick<EntitySummary, "workStatus" | "dueAt" | "lastInteractionAt">;

const ms = (iso: string | null | undefined): number | null => {
  if (iso === null || iso === undefined) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
};

/** Done or dropped: nothing is owed any more. */
export function isClosed(workStatus: GraphWorkStatus | null | undefined): boolean {
  return workStatus === "done" || workStatus === "dropped";
}

// --- the owner's calendar day ---------------------------------------------------------------------

/** The time zone days are counted in: the i18n's pinned one (tests, stories), else the runtime's. */
function zone(): string | undefined {
  return activeI18n().timeZone;
}

interface Ymd {
  y: number;
  m: number;
  d: number;
}

function ymdOf(at: number, tz: string | undefined): Ymd {
  const parts = new Intl.DateTimeFormat("en-CA", {
    ...(tz === undefined ? {} : { timeZone: tz }),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return { y: get("year"), m: get("month"), d: get("day") };
}

/** The calendar day as a day number, so two instants compare by the owner's days. */
export function dayNumber(at: number, tz: string | undefined = zone()): number {
  const { y, m, d } = ymdOf(at, tz);
  return Math.floor(Date.UTC(y, m - 1, d) / DAY);
}

/** How far `tz` is ahead of UTC at that instant, in ms. */
function offsetAt(at: number, tz: string | undefined): number {
  if (tz === undefined) return -new Date(at).getTimezoneOffset() * 60_000;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
  return asUtc - Math.floor(at / 1000) * 1000;
}

/** 11:59 pm on that day in the owner's zone, as an ISO instant: what "due Friday" means. */
export function endOfDay(y: number, m: number, d: number, tz: string | undefined = zone()): string {
  const guess = Date.UTC(y, m - 1, d, 23, 59, 0);
  let at = guess - offsetAt(guess, tz);
  const again = offsetAt(at, tz);
  if (again !== offsetAt(guess, tz)) at = guess - again;
  return new Date(at).toISOString();
}

const pad = (n: number) => String(n).padStart(2, "0");

/** An ISO instant as the owner's calendar day, for a date input ("2026-11-06"). */
export function toDateInput(iso: string, tz: string | undefined = zone()): string {
  const { y, m, d } = ymdOf(Date.parse(iso), tz);
  return `${y}-${pad(m)}-${pad(d)}`;
}

/** A date input's value back to 11:59 pm that day, as an ISO instant; null when it is not a day. */
export function fromDateInput(value: string, tz: string | undefined = zone()): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return m ? endOfDay(Number(m[1]), Number(m[2]), Number(m[3]), tz) : null;
}

// --- Work due groups ------------------------------------------------------------------------------

/**
 * Which Work due group a row belongs to, or null when it has left the page. A done or dropped item
 * stays 14 days; a handed-in (submitted) item with a past date is shown with Done, because it no
 * longer needs the owner. `lastInteractionAt` stands in for "when it was last worked on" until the
 * summary carries `lastSignalAt`.
 */
export function dueGroup(
  row: Row,
  now: number,
  /** Items the owner closed in this view: they stay in Done even when their date is old. */
  recentlyClosed = false,
): DueGroup | null {
  const due = ms(row.dueAt);
  if (isClosed(row.workStatus)) {
    if (recentlyClosed) return "done";
    const ref = ms(row.lastInteractionAt) ?? due;
    return ref !== null && now - ref > DONE_WINDOW_DAYS * DAY ? null : "done";
  }
  if (due === null) return "no_date";
  if (due < now) return row.workStatus === "submitted" ? "done" : "past_due";
  return dayNumber(due) - dayNumber(now) <= 6 ? "this_week" : "later";
}

/** Rows grouped for the Work due tab; open groups by due date, Done newest first. */
export function groupWork<T extends Row & { id: string }>(
  rows: readonly T[],
  now: number,
  closedHere: ReadonlySet<string> = new Set(),
): Record<DueGroup, T[]> {
  const out: Record<DueGroup, T[]> = {
    past_due: [],
    this_week: [],
    later: [],
    no_date: [],
    done: [],
  };
  for (const row of rows) {
    const g = dueGroup(row, now, closedHere.has(row.id));
    if (g !== null) out[g].push(row);
  }
  const byDue = (a: T, b: T) => (ms(a.dueAt) ?? 0) - (ms(b.dueAt) ?? 0);
  for (const g of ["past_due", "this_week", "later"] as const) out[g].sort(byDue);
  out.done.sort((a, b) => byDue(b, a));
  return out;
}

// --- stale (§3.6) ---------------------------------------------------------------------------------

export interface StaleInput {
  kind: "assignment" | "project";
  workStatus?: GraphWorkStatus | null | undefined;
  projectStatus?: string | null | undefined;
  dueAt?: string | null | undefined;
  /**
   * The last signal: `lastSignalAt` on a card (null: none yet). A list row only has
   * `lastInteractionAt`; where nothing is known (undefined) the mark is left off rather than
   * guessed, so a new item is never called stale.
   */
  lastSignalAt?: string | null | undefined;
}

/**
 * Whether the status may be out of date. An assignment is fresh with a signal in the last 3 days
 * or a due date a week or more away; a project with a signal in the last 14 days. Closed and
 * handed-in assignments, and paused or done projects, are never stale.
 */
export function isStale(item: StaleInput, now: number): boolean {
  if (item.lastSignalAt === undefined) return false;
  const signal = ms(item.lastSignalAt);
  if (item.kind === "project") {
    if (item.projectStatus === "paused" || item.projectStatus === "done") return false;
    return signal === null || now - signal > PROJECT_FRESH_DAYS * DAY;
  }
  if (isClosed(item.workStatus) || item.workStatus === "submitted") return false;
  if (signal !== null && now - signal <= ASSIGNMENT_FRESH_DAYS * DAY) return false;
  const due = ms(item.dueAt);
  return !(due !== null && due - now >= 7 * DAY);
}

/** `next_step` and `stopped_at` older than this "may be out of date" (§3.6). */
export function isStaleFact(recordedAt: string, now: number): boolean {
  const at = ms(recordedAt);
  return at !== null && now - at > PROJECT_FRESH_DAYS * DAY;
}

/** Whether an open assignment is past its date (the computed `overdue`). */
export function isOverdue(row: Row, now: number): boolean {
  const due = ms(row.dueAt);
  return due !== null && due < now && !isClosed(row.workStatus) && row.workStatus !== "submitted";
}

// --- quick add ("Lab report, CHEM 1B, Fri") --------------------------------------------------------

export interface QuickAddParent {
  id: string;
  name: string;
  /** Other names that point at it: "CHEM 1B", a course code. */
  aliases?: readonly string[];
}

export interface QuickAddParse {
  title: string;
  /** The course or project the text names, when one exists. */
  parent: { id: string; name: string } | null;
  /** What the text said about a parent that matched nothing. */
  unmatched: string | null;
  /** 11:59 pm on the day it names, as an ISO instant. */
  dueAt: string | null;
}

const WEEKDAYS: Record<string, number> = {
  sun: 0,
  sunday: 0,
  mon: 1,
  monday: 1,
  tue: 2,
  tues: 2,
  tuesday: 2,
  wed: 3,
  weds: 3,
  wednesday: 3,
  thu: 4,
  thur: 4,
  thurs: 4,
  thursday: 4,
  fri: 5,
  friday: 5,
  sat: 6,
  saturday: 6,
};

const MONTHS: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

function addDays({ y, m, d }: Ymd, days: number): Ymd {
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

function weekday({ y, m, d }: Ymd): number {
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** A month and day with no year: this year, or next when it is more than two months behind. */
function monthDay(m: number, d: number, today: Ymd): Ymd | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const check = new Date(Date.UTC(today.y, m - 1, d));
  if (check.getUTCMonth() !== m - 1) return null;
  const todayMs = Date.UTC(today.y, today.m - 1, today.d);
  const year = todayMs - check.getTime() > 60 * DAY ? today.y + 1 : today.y;
  return { y: year, m, d };
}

/** The day a short phrase names ("fri", "tomorrow", "nov 9", "11/9", "in 3 days"), or null. */
export function parseDay(text: string, now: number, tz: string | undefined = zone()): Ymd | null {
  const s = text.trim().toLowerCase().replace(/\./g, "").replace(/\s+/g, " ");
  if (s === "") return null;
  const today = ymdOf(now, tz);
  if (s === "today" || s === "tonight") return today;
  if (s === "tomorrow" || s === "tmrw") return addDays(today, 1);

  const next = /^(?:next |this |on )?([a-z]+)$/.exec(s);
  const dayName = next?.[1];
  if (dayName !== undefined && dayName in WEEKDAYS) {
    const delta = ((WEEKDAYS[dayName] as number) - weekday(today) + 7) % 7;
    return addDays(today, s.startsWith("next ") ? delta + 7 : delta);
  }

  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (iso) return { y: Number(iso[1]), m: Number(iso[2]), d: Number(iso[3]) };

  const slash = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/.exec(s);
  if (slash) {
    if (slash[3] !== undefined) {
      const year = Number(slash[3]);
      return { y: year < 100 ? 2000 + year : year, m: Number(slash[1]), d: Number(slash[2]) };
    }
    return monthDay(Number(slash[1]), Number(slash[2]), today);
  }

  const named = /^([a-z]+) (\d{1,2})(?:st|nd|rd|th)?$/.exec(s) ?? undefined;
  if (named && (named[1] as string) in MONTHS)
    return monthDay(MONTHS[named[1] as string] as number, Number(named[2]), today);
  const reversed = /^(\d{1,2})(?:st|nd|rd|th)? ([a-z]+)$/.exec(s) ?? undefined;
  if (reversed && (reversed[2] as string) in MONTHS)
    return monthDay(MONTHS[reversed[2] as string] as number, Number(reversed[1]), today);

  const inN = /^in (\d{1,3}) (day|days|week|weeks)$/.exec(s);
  if (inN) return addDays(today, Number(inN[1]) * (inN[2]?.startsWith("week") ? 7 : 1));
  return null;
}

const normalize = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/** The course or project a phrase names, by its name or an alias, ignoring case and spacing. */
function matchParent(
  text: string,
  parents: readonly QuickAddParent[],
): { id: string; name: string } | null {
  const needle = normalize(text);
  if (needle === "") return null;
  const hit = parents.find((p) =>
    [p.name, ...(p.aliases ?? [])].some((n) => normalize(n) === needle),
  );
  if (hit) return { id: hit.id, name: hit.name };
  // "CHEM 1B" in "CHEM 1B (Fall 2026)", or the other way round, when exactly one course fits.
  const loose = parents.filter((p) =>
    [p.name, ...(p.aliases ?? [])].some((n) => {
      const hay = normalize(n);
      return hay.startsWith(`${needle} `) || needle.startsWith(`${hay} `);
    }),
  );
  return loose.length === 1 && loose[0] ? { id: loose[0].id, name: loose[0].name } : null;
}

/**
 * Reads a one-line form: the title first, then a course or project and a day in any order
 * ("Lab report, CHEM 1B, Fri", "Problem set, Nov 9", "File taxes"). English phrases only; what it
 * cannot read becomes `unmatched`, so the form can say so before it saves.
 */
export function parseQuickAdd(
  text: string,
  parents: readonly QuickAddParent[],
  now: number,
  tz: string | undefined = zone(),
): QuickAddParse | null {
  const parts = text
    .split(/[,;·]/)
    .map((p) => p.trim())
    .filter((p) => p !== "");
  const title = parts.shift();
  if (title === undefined) return null;
  let parent: QuickAddParse["parent"] = null;
  let unmatched: string | null = null;
  let day: Ymd | null = null;
  for (const part of parts) {
    const matched: QuickAddParse["parent"] = parent === null ? matchParent(part, parents) : null;
    if (matched) {
      parent = matched;
      continue;
    }
    const when: Ymd | null = day === null ? parseDay(part, now, tz) : null;
    if (when) {
      day = when;
      continue;
    }
    if (unmatched === null && parent === null) unmatched = part;
  }
  return {
    title,
    parent,
    unmatched: parent === null ? unmatched : null,
    dueAt: day === null ? null : endOfDay(day.y, day.m, day.d, tz),
  };
}
