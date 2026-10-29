import type { EverythingMemorySettings, EverythingSource } from "@psyche/protocol";

/**
 * The cost shown before anything is turned on (docs/design/everything-memory-2026.md §6.5). The
 * Gateway has no per-source counts for the estimate, so it is built from the doc's typical day:
 * about 110 items a day reach a Haiku-class model after filtering, for about $0.12. Each source's
 * share of that day is below. The figures are an estimate, not a quote; Settings says so.
 */

/** Items a typical day sends to the model after the free pre-filter, per source. */
export const ITEMS_PER_DAY: Record<EverythingSource, number> = {
  mail: 25,
  messages: 60,
  notes: 8,
  calendar: 6,
  reminders: 2,
  chats: 0,
  files: 5,
  browser: 5,
  transcripts: 5,
};

/** $0.12 for the typical 111 items (§6.5): about a tenth of a cent each. */
export const USD_PER_ITEM = 0.12 / 111;
/** Light and heavy days from the doc's table, relative to typical ($0.05, $0.12, $0.30). */
const LIGHT = 0.05 / 0.12;
const HEAVY = 0.3 / 0.12;

export interface CostEstimate {
  /** US dollars per month; all zero for None and Local. */
  low: number;
  typical: number;
  high: number;
}

const ZERO: CostEstimate = { low: 0, typical: 0, high: 0 };

function dailyItems(sources: Partial<Record<EverythingSource, boolean>>): number {
  return (Object.keys(ITEMS_PER_DAY) as EverythingSource[]).reduce(
    (n, s) => n + (sources[s] === true ? ITEMS_PER_DAY[s] : 0),
    0,
  );
}

export function estimateMonthly(
  kind: EverythingMemorySettings["model"]["default"]["kind"],
  sources: Partial<Record<EverythingSource, boolean>>,
): CostEstimate {
  if (kind !== "cloud") return ZERO;
  const typical = dailyItems(sources) * USD_PER_ITEM * 30;
  return { low: typical * LIGHT, typical, high: typical * HEAVY };
}

/** First-run backfill at full price (the provider's batch API is about half). */
export function estimateBackfill(
  kind: EverythingMemorySettings["model"]["default"]["kind"],
  sources: Partial<Record<EverythingSource, boolean>>,
  days: number,
): number {
  return kind === "cloud" ? dailyItems(sources) * USD_PER_ITEM * days : 0;
}

export const formatUsd = (n: number): string => (n < 1 ? `$${n.toFixed(2)}` : `$${Math.round(n)}`);
