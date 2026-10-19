import { type AutomationKind, PsycheError } from "@psyche/protocol";
import { CronExpressionParser } from "cron-parser";

const MINUTE = 60_000;

/** A parsed `Automation.schedule`: the next fire time strictly after `after`. */
/** Missed fire times folded into one run. */
export interface Fold {
  /** Fire times in `[due, now]` (at least 1), counted up to the cap. */
  count: number;
  /** The latest of them. */
  latest: number;
  /** The first fire time after `now`. */
  next: number | undefined;
}

export interface Schedule {
  readonly type: "cron" | "interval" | "once";
  next(after: number): number | undefined;
  /** Folds every fire time from `due` (itself a fire time, `<= now`) up to `now`. */
  fold(due: number, now: number, cap: number): Fold;
  /** Interval length (interval schedules only); used for watch backoff. */
  readonly intervalMs?: number;
}

/** ISO-8601 duration subset: `PnW`, `PnDTnHnMnS` (no years / months: they have no fixed length). */
export function parseIsoDuration(text: string): number | undefined {
  const m = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(text);
  if (m === null || text === "P" || text.endsWith("T")) return undefined;
  const [w, d, h, mi, s] = [m[1], m[2], m[3], m[4], m[5]].map((x) => Number(x ?? 0)) as [
    number,
    number,
    number,
    number,
    number,
  ];
  const ms = (((w * 7 + d) * 24 + h) * 60 + mi) * MINUTE + Math.round(s * 1000);
  return ms > 0 ? ms : undefined;
}

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The shortest interval an automation may run at (keeps a typo from becoming a hot loop). */
export const MIN_INTERVAL_MS = MINUTE;

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

function bad(message: string): never {
  throw new PsycheError("invalid_params", message);
}

/**
 * Parses a schedule. `reminder` takes an ISO-8601 instant with an offset (one-shot); `watch` an
 * ISO-8601 duration; every other kind a duration (`PT30M`, interval anchored on the previous
 * fire time) or a 5-field cron expression evaluated in `timezone` (DST-aware: a wall time that
 * does not exist fires once at the next valid time; a repeated one fires once).
 */
export function parseSchedule(kind: AutomationKind, schedule: string, timezone: string): Schedule {
  if (!isValidTimezone(timezone)) bad(`unknown timezone ${JSON.stringify(timezone)}`);
  const text = schedule.trim();
  if (kind === "reminder") {
    if (!ISO_INSTANT.test(text)) bad("a reminder needs an ISO-8601 instant with an offset");
    const at = Date.parse(text);
    if (Number.isNaN(at)) bad(`bad instant ${JSON.stringify(text)}`);
    return {
      type: "once",
      next: (after) => (at > after ? at : undefined),
      fold: (due) => ({ count: 1, latest: due, next: undefined }),
    };
  }
  if (text.startsWith("P")) {
    const ms = parseIsoDuration(text);
    if (ms === undefined) bad(`bad ISO-8601 duration ${JSON.stringify(text)}`);
    if (ms < MIN_INTERVAL_MS) bad("intervals must be at least one minute");
    return {
      type: "interval",
      intervalMs: ms,
      next: (after) => after + ms,
      // Arithmetic, so a month asleep costs nothing; the phase is kept.
      fold(due, now) {
        const steps = Math.floor((now - due) / ms);
        const latest = due + steps * ms;
        return { count: steps + 1, latest, next: latest + ms };
      },
    };
  }
  if (kind === "watch") bad("a watch needs an ISO-8601 duration (for example PT1H)");
  const fields = text.split(/\s+/);
  if (fields.length !== 5) bad(`cron needs 5 fields (minute hour day month weekday): ${text}`);
  try {
    CronExpressionParser.parse(text, { tz: timezone, currentDate: new Date(0) });
  } catch (e) {
    bad(`bad cron expression ${JSON.stringify(text)}: ${(e as Error).message}`);
  }
  const next = (after: number): number | undefined => {
    const it = CronExpressionParser.parse(text, {
      tz: timezone,
      currentDate: new Date(Math.floor(after / 1000) * 1000),
    });
    for (let i = 0; i < 4; i += 1) {
      if (!it.hasNext()) return undefined;
      const t = it.next().getTime();
      if (t > after) return t;
    }
    return undefined;
  };
  return {
    type: "cron",
    next,
    // One iterator for the whole walk; past the cap, jump straight to `now`.
    fold(due, now, cap) {
      const it = CronExpressionParser.parse(text, {
        tz: timezone,
        currentDate: new Date(Math.floor(due / 1000) * 1000),
      });
      let count = 1;
      let latest = due;
      while (count < cap && it.hasNext()) {
        const t = it.next().getTime();
        if (t <= latest) continue;
        if (t > now) return { count, latest, next: t };
        count += 1;
        latest = t;
      }
      // Cap reached: the run stands for the latest fire time at or before `now`.
      const back = CronExpressionParser.parse(text, {
        tz: timezone,
        currentDate: new Date(Math.floor(now / 1000) * 1000 + 1000),
      });
      const prev = back.hasPrev() ? back.prev().getTime() : latest;
      return { count, latest: Math.max(latest, prev <= now ? prev : latest), next: next(now) };
    },
  };
}
