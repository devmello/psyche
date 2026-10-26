import type { InsightDay, InsightTotals } from "@psyche/protocol";
import type { OverviewPeriod } from "./period.ts";

/**
 * The numbers behind the Summary and Activity sections (agent-overview-2026 §5.4), derived from
 * `insights.summary` and nothing else: every figure is a count or a duration the Gateway
 * measured. Pure, so it is tested without React.
 */

/** Tasks and chats: the runs a person started (kinds task and chat), subagents and automations aside. */
export const tasksOf = (t: InsightTotals): number => t.runs.task + t.runs.chat;

export const approvalsDecided = (t: InsightTotals): number =>
  t.approvals.approved + t.approvals.denied + t.approvals.expired;

const dayRuns = (d: InsightDay): number => d.runs.task + d.runs.chat + d.runs.automation;

/** Daily task-and-chat counts, oldest first (the Tasks tile's sparkline). */
export const taskSpark = (days: readonly InsightDay[]): number[] =>
  days.map((d) => d.runs.task + d.runs.chat);

/** Daily automation counts, oldest first. */
export const automationSpark = (days: readonly InsightDay[]): number[] =>
  days.map((d) => d.runs.automation);

/**
 * Share of finished runs that succeeded, as a whole percent. A failure never rounds up to
 * "100%": with any failed run the figure stops at 99. Null when nothing finished.
 */
export function okPercent(done: number, failed: number): number | null {
  const finished = done + failed;
  if (finished <= 0) return null;
  const pct = Math.round((done / finished) * 100);
  return failed > 0 ? Math.min(pct, 99) : pct;
}

export type SummaryKinds = "both" | "tasks" | "automations" | "none";

/** Which of the sentence's two run clauses survive: a clause is dropped when its number is 0. */
export function summaryKinds(totals: InsightTotals): SummaryKinds {
  const tasks = tasksOf(totals) > 0;
  const automations = totals.runs.automation > 0;
  if (tasks && automations) return "both";
  if (tasks) return "tasks";
  if (automations) return "automations";
  return "none";
}

/** True when the period had no runs at all (the chart says "Nothing this week"). */
export const hasNoRuns = (days: readonly InsightDay[]): boolean =>
  days.every((d) => dayRuns(d) === 0);

/** The comparison words key for a period: "last week" / "last month"; all time has none. */
export const comparisonKey = (period: OverviewPeriod): string | null =>
  period === "7d"
    ? "overview.summary.vs.week"
    : period === "30d"
      ? "overview.summary.vs.month"
      : null;

/** The select key the ICU templates use for a period. */
export const PERIOD_WORD = { "7d": "week", "30d": "month", all: "all" } as const;
