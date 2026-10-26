import { useCallback, useMemo } from "react";
import { DEFAULT_OVERVIEW_PERIOD, type OverviewPeriod } from "./period.ts";

/**
 * The Recent runs filter, carried in the Overview URL so a tile, a bar or a fact can link to the
 * runs behind its number (docs/design/agent-overview-2026.md §5.4). O4 writes it; the Recent runs
 * section (O5) reads it with `useRecentFilter` and highlights the matching chip.
 *
 *   /overview?period=30d&filter=failed&day=2026-10-14
 *
 * - `filter`: `all` (default, omitted) | `tasks` (kinds task and chat) | `automations` | `chat` |
 *   `failed`
 * - `day`: a `YYYY-MM-DD` calendar day in the user's time zone; narrows the list to that day
 *   whatever the period is.
 *
 * The URL carries no hash: after navigating, callers scroll `#recent` into view with
 * `scrollToRecent()` (the host's `navigate` takes routes, and the query is the whole state).
 */
export const RECENT_FILTERS = ["all", "tasks", "automations", "chat", "failed"] as const;
export type RecentFilterKind = (typeof RECENT_FILTERS)[number];

export interface RecentFilter {
  filter: RecentFilterKind;
  /** `YYYY-MM-DD`, or null for the whole period. */
  day: string | null;
}

export const NO_RECENT_FILTER: RecentFilter = { filter: "all", day: null };
export const RECENT_ANCHOR = "recent";

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const queryOf = (routeOrQuery: string): URLSearchParams => {
  const afterPath = routeOrQuery.includes("?")
    ? routeOrQuery.slice(routeOrQuery.indexOf("?") + 1)
    : routeOrQuery;
  return new URLSearchParams(afterPath.split("#")[0]);
};

/** `?filter=&day=` from a route or query string; anything unknown is "no filter". */
export function parseRecentFilter(routeOrQuery: string): RecentFilter {
  const query = queryOf(routeOrQuery);
  const raw = query.get("filter");
  const day = query.get("day");
  return {
    filter: RECENT_FILTERS.find((f) => f === raw) ?? "all",
    day: day !== null && DAY_PATTERN.test(day) ? day : null,
  };
}

/** `/overview[?period=][&filter=][&day=]`. Defaults are left out, so the clean URL stays clean. */
export function recentHref(
  period: OverviewPeriod,
  filter: Partial<RecentFilter> = NO_RECENT_FILTER,
): string {
  const query = new URLSearchParams();
  if (period !== DEFAULT_OVERVIEW_PERIOD) query.set("period", period);
  if (filter.filter !== undefined && filter.filter !== "all") query.set("filter", filter.filter);
  if (filter.day != null && DAY_PATTERN.test(filter.day)) query.set("day", filter.day);
  const qs = query.toString();
  return qs === "" ? "/overview" : `/overview?${qs}`;
}

/** Scrolls the Recent runs section into view (a no-op until it renders). */
export function scrollToRecent(): void {
  document.getElementById(RECENT_ANCHOR)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

/** The filter held in the route, and a setter that keeps the period. `navigate` is the shell's. */
export function useRecentFilter(
  route: string,
  period: OverviewPeriod,
  navigate: (to: string) => void,
): [RecentFilter, (next: Partial<RecentFilter>) => void] {
  const current = useMemo(() => parseRecentFilter(route), [route]);
  const set = useCallback(
    (next: Partial<RecentFilter>) => navigate(recentHref(period, { ...NO_RECENT_FILTER, ...next })),
    [navigate, period],
  );
  return [current, set];
}
