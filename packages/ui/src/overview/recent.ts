import type { RunSummary } from "@psyche/protocol";
import type { RunsFilter } from "../data/runs.ts";
import { type OverviewPeriod, periodDays } from "./period.ts";
import type { RecentFilter } from "./recentFilter.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const FINISHED = ["done", "failed", "cancelled"] as const;

/**
 * The `runs.list` params for the Recent runs section (agent-overview-2026 §5.4): finished runs
 * in the period, narrowed by what the filter can ask the Gateway for. `tasks` (kinds task and
 * chat) and `day` need `matchesRecent` on top, since `runs.list` takes one kind.
 */
export function recentRunsQuery(
  period: OverviewPeriod,
  filter: RecentFilter,
  now: number,
): RunsFilter {
  const days = periodDays(period);
  // A day filter wins over the period; 14 h of slack covers every time zone's start of that day.
  const since =
    filter.day !== null
      ? { since: new Date(Date.parse(`${filter.day}T00:00:00Z`) - 14 * 3_600_000).toISOString() }
      : days === null
        ? {}
        : { since: new Date(now - (days - 1) * DAY_MS).toISOString() };
  // `failed` implies its status; `status=done` narrows any other filter to finished-done runs.
  const status =
    filter.filter === "failed"
      ? ["failed" as const]
      : filter.status === "done"
        ? ["done" as const]
        : [...FINISHED];
  switch (filter.filter) {
    case "automations":
      return { status, kind: "automation", ...since };
    case "chat":
      return { status, kind: "chat", ...since };
    default:
      return { status, ...since };
  }
}

/** `YYYY-MM-DD` of an instant in `timeZone` (the device's when absent). */
function calendarDay(at: number, timeZone?: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    ...(timeZone ? { timeZone } : {}),
  }).format(at);
}

/** The part of a filter `runs.list` cannot do: task + chat kinds, and one calendar day. */
export function matchesRecent(
  run: Pick<RunSummary, "kind" | "startedAt">,
  filter: RecentFilter,
  timeZone?: string,
): boolean {
  if (filter.filter === "tasks" && run.kind !== "task" && run.kind !== "chat") return false;
  if (filter.day === null) return true;
  const at = Date.parse(run.startedAt);
  return !Number.isNaN(at) && calendarDay(at, timeZone) === filter.day;
}

/** `/overview/run/<runId>[?step=<stepId>]`: a run's Timeline at full width (§3). */
export function overviewRunHref(runId: string, options: { stepId?: string } = {}): string {
  const base = `/overview/run/${encodeURIComponent(runId)}`;
  return options.stepId ? `${base}?step=${encodeURIComponent(options.stepId)}` : base;
}

/** The section anchor in a route (`/overview#upcoming`), when it names one. */
export function overviewAnchor(route: string): string | undefined {
  const hash = route.split("#")[1];
  return hash && /^[a-z]+$/.test(hash) ? hash : undefined;
}
