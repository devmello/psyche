import type { Automation, UpcomingItem } from "@psyche/protocol";

/** One scheduled thing, with the full automation behind it when the list has it. */
export interface UpcomingEntry {
  item: UpcomingItem;
  automation: Automation | undefined;
}

export const UPCOMING_GROUPS = ["today", "tomorrow", "week", "later"] as const;
export type UpcomingGroup = (typeof UPCOMING_GROUPS)[number];

const MIN_MS = 60_000;
const HOUR_MS = 60 * MIN_MS;
const DAY_MS = 24 * HOUR_MS;

/** Automations that run at least this often are one row with their cadence, not a calendar slot. */
export const FREQUENT_CADENCE_MS = 12 * HOUR_MS;

/** How often a schedule fires, from an ISO duration (`PT45M`) or a stepped cron; else null. */
export function cadenceMs(schedule: string | undefined): number | null {
  if (schedule === undefined) return null;
  const iso = /^P(?:T(?:(\d+)H)?(?:(\d+)M)?)$/.exec(schedule);
  if (iso && (iso[1] || iso[2])) return (Number(iso[1] ?? 0) * 60 + Number(iso[2] ?? 0)) * MIN_MS;
  const parts = schedule.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [min = "", hour = "", dom = "", month = "", dow = ""] = parts;
  if (dom !== "*" || month !== "*" || dow !== "*") return null;
  const everyMin = /^\*\/(\d+)$/.exec(min);
  if (everyMin && hour === "*") return Number(everyMin[1]) * MIN_MS;
  if (min === "*" && hour === "*") return MIN_MS;
  const everyHour = /^\*\/(\d+)$/.exec(hour);
  if (everyHour && /^\d+$/.test(min)) return Number(everyHour[1]) * HOUR_MS;
  return null;
}

export const isFrequent = (schedule: string | undefined): boolean => {
  const every = cadenceMs(schedule);
  return every !== null && every <= FREQUENT_CADENCE_MS;
};

/** Whole calendar days from `now` to `at` in `timeZone` (0 today, 1 tomorrow, negative: overdue). */
export function dayOffset(at: number, now: number, timeZone?: string): number {
  const day = (ms: number): number => {
    const parts = new Intl.DateTimeFormat("en-CA", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      ...(timeZone ? { timeZone } : {}),
    }).format(ms);
    return Date.parse(`${parts}T00:00:00Z`);
  };
  return Math.round((day(at) - day(now)) / DAY_MS);
}

/**
 * Today / Tomorrow / This week / Later, by the next run's calendar day. Frequent automations
 * ("every 45 min") are one row under Today whatever their next slot. Overdue runs are due now,
 * so they sit in Today. Entries keep their order (soonest first).
 */
export function groupUpcoming(
  entries: readonly UpcomingEntry[],
  now: number,
  timeZone?: string,
): Record<UpcomingGroup, UpcomingEntry[]> {
  const groups: Record<UpcomingGroup, UpcomingEntry[]> = {
    today: [],
    tomorrow: [],
    week: [],
    later: [],
  };
  for (const entry of entries) {
    const next = entry.item.nextRunAt ? Date.parse(entry.item.nextRunAt) : Number.NaN;
    if (Number.isNaN(next)) continue;
    const offset = dayOffset(next, now, timeZone);
    const group: UpcomingGroup =
      isFrequent(entry.item.schedule) || offset <= 0
        ? "today"
        : offset === 1
          ? "tomorrow"
          : offset < 7
            ? "week"
            : "later";
    groups[group].push(entry);
  }
  return groups;
}
