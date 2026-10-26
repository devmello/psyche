import { PsycheError } from "@psyche/protocol";

/**
 * Free-time finder (docs/connectors/apple-apps-2026.md §6, #639): given busy blocks from every
 * connected calendar (Apple Calendar `calendar.free_busy`, Google free/busy), the working hours
 * and days, find the free stretches long enough for the requested duration. Pure: the Gateway
 * gathers the busy blocks; this only does the arithmetic, in the owner's time zone.
 */

export interface BusyBlock {
  start: string;
  end: string;
}

export interface FreeTimeQuery {
  /** The window to search, ISO 8601. */
  from: string;
  to: string;
  durationMinutes: number;
  /** Local working hours, "HH:MM" (default 09:00–17:00). */
  workStart?: string;
  workEnd?: string;
  /** Days to consider, 0 = Sunday … 6 = Saturday (default Monday–Friday). */
  days?: number[];
  /** Minutes kept free around busy blocks (default 0). */
  bufferMinutes?: number;
  /** IANA zone the working hours are in. */
  timeZone: string;
  limit?: number;
}

export interface FreeSlot {
  /** The proposed slot: `durationMinutes` from the start of a free stretch. */
  start: string;
  end: string;
  /** How long the free stretch lasts from `start` (minutes). */
  freeMinutes: number;
}

const MAX_DAYS = 62;

/** The zone's offset from UTC at `instant`, in minutes (e.g. -420 for PDT). */
function offsetMinutes(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(instant));
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second"));
  return Math.round((asUtc - Math.floor(instant / 1000) * 1000) / 60_000);
}

/** The UTC instant of a local wall-clock time in `timeZone` (DST-aware). */
export function zonedTime(
  y: number,
  m: number,
  d: number,
  minutesOfDay: number,
  timeZone: string,
): number {
  const guess = Date.UTC(y, m - 1, d, 0, minutesOfDay);
  let t = guess - offsetMinutes(guess, timeZone) * 60_000;
  // Re-check at the result: the offset can differ across a DST change.
  t = guess - offsetMinutes(t, timeZone) * 60_000;
  return t;
}

/** The local calendar date and weekday of `instant` in `timeZone`. */
function localDate(
  instant: number,
  timeZone: string,
): { y: number; m: number; d: number; weekday: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  }).formatToParts(new Date(instant));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"));
  return { y: Number(get("year")), m: Number(get("month")), d: Number(get("day")), weekday };
}

function hhmm(value: string | undefined, fallback: number, field: string): number {
  if (value === undefined) return fallback;
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (m === null) throw new PsycheError("invalid_params", `${field} is HH:MM`);
  return Number(m[1]) * 60 + Number(m[2]);
}

export function findFreeSlots(busy: readonly BusyBlock[], q: FreeTimeQuery): FreeSlot[] {
  const from = Date.parse(q.from);
  const to = Date.parse(q.to);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
    throw new PsycheError("invalid_params", "from and to are ISO 8601 times, to after from");
  }
  if (to - from > MAX_DAYS * 86_400_000) {
    throw new PsycheError("invalid_params", `search at most ${MAX_DAYS} days at a time`);
  }
  if (
    !Number.isInteger(q.durationMinutes) ||
    q.durationMinutes < 5 ||
    q.durationMinutes > 24 * 60
  ) {
    throw new PsycheError("invalid_params", "durationMinutes is 5 to 1440");
  }
  const workStart = hhmm(q.workStart, 9 * 60, "workStart");
  const workEnd = hhmm(q.workEnd, 17 * 60, "workEnd");
  if (workEnd <= workStart) throw new PsycheError("invalid_params", "workEnd is after workStart");
  const days = new Set(q.days ?? [1, 2, 3, 4, 5]);
  const buffer = (q.bufferMinutes ?? 0) * 60_000;
  const need = q.durationMinutes * 60_000;
  const limit = Math.min(Math.max(q.limit ?? 10, 1), 50);

  // Busy time, padded and merged.
  const blocks = busy
    .map((b) => [Date.parse(b.start) - buffer, Date.parse(b.end) + buffer] as const)
    .filter(([s, e]) => Number.isFinite(s) && Number.isFinite(e) && e > s)
    .sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const [s, e] of blocks) {
    const last = merged.at(-1);
    if (last !== undefined && s <= last[1]) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }

  const slots: FreeSlot[] = [];
  const seen = new Set<string>();
  // One working window per local day touching the search window.
  for (let t = from; t < to + 86_400_000 && slots.length < limit; t += 86_400_000) {
    const day = localDate(t, q.timeZone);
    const key = `${day.y}-${day.m}-${day.d}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!days.has(day.weekday)) continue;
    let cursor = Math.max(from, zonedTime(day.y, day.m, day.d, workStart, q.timeZone));
    const end = Math.min(to, zonedTime(day.y, day.m, day.d, workEnd, q.timeZone));
    for (const [s, e] of merged) {
      if (cursor >= end || slots.length >= limit) break;
      if (e <= cursor) continue;
      if (s >= end) break;
      if (s - cursor >= need) {
        slots.push({
          start: new Date(cursor).toISOString(),
          end: new Date(cursor + need).toISOString(),
          freeMinutes: Math.round((s - cursor) / 60_000),
        });
      }
      cursor = Math.max(cursor, e);
    }
    if (slots.length < limit && end - cursor >= need) {
      slots.push({
        start: new Date(cursor).toISOString(),
        end: new Date(cursor + need).toISOString(),
        freeMinutes: Math.round((end - cursor) / 60_000),
      });
    }
  }
  return slots;
}
