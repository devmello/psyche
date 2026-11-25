/**
 * Working-day and local-time arithmetic for the promise ledger (design section 4.1). Pure
 * functions of a timestamp and an IANA time zone, so the lifecycle tests run on a fake clock.
 * Working days are Monday to Friday; there is no holiday calendar.
 */

export const DAY_MS = 86_400_000;

/** A local calendar day. `weekday` is 0 (Sunday) to 6 (Saturday). */
export interface LocalDay {
  y: number;
  m: number;
  d: number;
  weekday: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (f === undefined) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(tz, f);
  }
  return f;
}

/** Offset of `tz` from UTC at `ms`, in milliseconds (east is positive). */
function offsetAt(ms: number, tz: string): number {
  const p: Record<string, number> = {};
  for (const part of formatter(tz).formatToParts(new Date(ms))) {
    if (part.type !== "literal") p[part.type] = Number(part.value);
  }
  const asUtc = Date.UTC(
    p.year as number,
    (p.month as number) - 1,
    p.day as number,
    p.hour as number,
    p.minute as number,
    p.second as number,
  );
  return asUtc - Math.floor(ms / 1000) * 1000;
}

export function localDay(ms: number, tz: string): LocalDay {
  const shifted = new Date(ms + offsetAt(ms, tz));
  return {
    y: shifted.getUTCFullYear(),
    m: shifted.getUTCMonth() + 1,
    d: shifted.getUTCDate(),
    weekday: shifted.getUTCDay(),
  };
}

/** The instant at which the local clock of `tz` reads `hour`:00 on the given day. */
export function localTime(
  day: { y: number; m: number; d: number },
  hour: number,
  tz: string,
): number {
  const guess = Date.UTC(day.y, day.m - 1, day.d, hour);
  const first = guess - offsetAt(guess, tz);
  return guess - offsetAt(first, tz);
}

function shiftDay(day: LocalDay, days: number): LocalDay {
  const t = new Date(Date.UTC(day.y, day.m - 1, day.d + days));
  return {
    y: t.getUTCFullYear(),
    m: t.getUTCMonth() + 1,
    d: t.getUTCDate(),
    weekday: t.getUTCDay(),
  };
}

export const isWorkingDay = (day: LocalDay): boolean => day.weekday !== 0 && day.weekday !== 6;

/** `n` working days after `day` (n may be 0; a weekend `day` stays put for 0). */
export function addWorkingDays(day: LocalDay, n: number): LocalDay {
  let cur = day;
  let left = n;
  while (left > 0) {
    cur = shiftDay(cur, 1);
    if (isWorkingDay(cur)) left -= 1;
  }
  return cur;
}

/** The working day before `day`. */
export function previousWorkingDay(day: LocalDay): LocalDay {
  let cur = shiftDay(day, -1);
  while (!isWorkingDay(cur)) cur = shiftDay(cur, -1);
  return cur;
}

/** Hour of the local day at which the one warning for a due date is sent. */
export const WARN_HOUR = 16;
/** Hour of the morning a promise is marked broken (the next 06:00). */
export const BREAK_HOUR = 6;

/** When the warning for `dueMs` is due: 16:00 on the working day before the due day. */
export function warnAt(dueMs: number, tz: string): number {
  return localTime(previousWorkingDay(localDay(dueMs, tz)), WARN_HOUR, tz);
}

/**
 * When a promise past `dueMs` becomes `broken`: 06:00 on the day after the last day of grace.
 * Yours: `graceDays` 0, so the next 06:00 after the due day ends. Theirs: the grace period in
 * working days (`promises.graceDays`, 1).
 */
export function brokenThreshold(dueMs: number, graceDays: number, tz: string): number {
  const last = addWorkingDays(localDay(dueMs, tz), graceDays);
  return localTime(shiftDay(last, 1), BREAK_HOUR, tz);
}

/** Start of the local day that holds `ms`. */
export function startOfDay(ms: number, tz: string): number {
  return localTime(localDay(ms, tz), 0, tz);
}

/** The first moment at which `dueMs` counts as "due soon": midnight at the working day before. */
export function dueSoonFrom(dueMs: number, tz: string): number {
  return localTime(previousWorkingDay(localDay(dueMs, tz)), 0, tz);
}

/** A due date below this confidence shows "No date" and schedules no warning or nudge. */
export const MIN_DUE_CONFIDENCE = 0.6;

export function hasConfidentDue(row: {
  dueAt?: string | null;
  dueKind: string;
  dueConfidence?: number | null;
}): boolean {
  if (row.dueAt === null || row.dueAt === undefined || row.dueKind === "none") return false;
  return (row.dueConfidence ?? 1) >= MIN_DUE_CONFIDENCE;
}

export const parseMs = (iso: string | null | undefined): number | null => {
  if (iso === null || iso === undefined) return null;
  const n = Date.parse(iso);
  return Number.isNaN(n) ? null : n;
};
