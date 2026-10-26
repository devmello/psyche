import type { GrowthWindow, MethodResult } from "@psyche/protocol";
import { useMemo } from "react";
import { type LoadState, useGatewayQuery } from "./hooks.ts";

/**
 * `insights.summary` (docs/design/agent-overview-2026.md §6.2): the Overview's aggregates. The
 * store marks the query stale, at most every 2 s, on the events that feed it (`run.updated`,
 * `approval.*`, `artifact.updated`, `specialist.result`, `growth.updated` and the people graph's
 * `memory.entity.updated`, `memory.loop.updated`, `memory.suggestion.created`), and
 * `useGatewayQuery` refetches it.
 */

export type InsightsSummary = MethodResult<"insights.summary">;
export type InsightsWindow = GrowthWindow;

/** This device's IANA time zone, which the Gateway counts days in. */
function deviceTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/**
 * The aggregates for `window`, days counted in this device's time zone (or `options.timeZone`).
 * `data` is undefined until the first answer, and stays undefined against a Gateway that does not
 * have the method (`error` is then set).
 */
export function useInsights(
  window: InsightsWindow,
  options: { timeZone?: string } = {},
): LoadState & { data: InsightsSummary | undefined } {
  const device = useMemo(deviceTimeZone, []);
  const timeZone = options.timeZone ?? device;
  return useGatewayQuery("insights.summary", { window, timeZone });
}
