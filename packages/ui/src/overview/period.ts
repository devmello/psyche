import { useCallback, useMemo } from "react";
import { activeI18n, t } from "../i18n/core.ts";

/** The Overview's period control (agent-overview-2026 §5.1): Week / Month / All time. */
export const OVERVIEW_PERIODS = ["7d", "30d", "all"] as const;
export type OverviewPeriod = (typeof OVERVIEW_PERIODS)[number];
export const DEFAULT_OVERVIEW_PERIOD: OverviewPeriod = "7d";

const DAY_MS = 24 * 60 * 60 * 1000;

/** The days a period spans, or null for all time. */
export const periodDays = (period: OverviewPeriod): number | null =>
  period === "7d" ? 7 : period === "30d" ? 30 : null;

/** `?period=` from a route or query string; anything unknown is the default. */
export function parseOverviewPeriod(routeOrQuery: string): OverviewPeriod {
  const query = routeOrQuery.includes("?") ? (routeOrQuery.split("?")[1] ?? "") : routeOrQuery;
  const raw = new URLSearchParams(query.split("#")[0]).get("period");
  return OVERVIEW_PERIODS.find((p) => p === raw) ?? DEFAULT_OVERVIEW_PERIOD;
}

/** `/overview[?period=]`: the default period leaves the URL clean. */
export function overviewHref(period: OverviewPeriod = DEFAULT_OVERVIEW_PERIOD): string {
  return period === DEFAULT_OVERVIEW_PERIOD ? "/overview" : `/overview?period=${period}`;
}

/** The label for a period's segment. */
export const periodLabel = (period: OverviewPeriod): string =>
  t(
    period === "7d"
      ? "overview.period.week"
      : period === "30d"
        ? "overview.period.month"
        : "overview.period.all",
  );

/**
 * The exact range line ("Oct 20 – 26", "Sep 27 – Oct 26", "Since Aug 3"), in the user's locale
 * and time zone. The window ends today and includes it.
 */
export function formatPeriodRange(
  period: OverviewPeriod,
  now: number,
  firstActivityAt?: string | null,
): string {
  const i18n = activeI18n();
  const days = periodDays(period);
  if (days === null) {
    return firstActivityAt
      ? t("overview.range.since", { date: i18n.date(firstActivityAt) })
      : t("overview.range.allTime");
  }
  const start = now - (days - 1) * DAY_MS;
  try {
    return new Intl.DateTimeFormat(i18n.locale, {
      month: "short",
      day: "numeric",
      timeZone: i18n.timeZone,
    }).formatRange(start, now);
  } catch {
    return `${i18n.date(start)} – ${i18n.date(now)}`;
  }
}

/**
 * The period held in the route (`/overview?period=30d`), so links reproduce the view. `navigate`
 * is the shell's; choosing a period replaces the query and keeps the screen.
 */
export function useOverviewPeriod(
  route: string,
  navigate: (to: string) => void,
): [OverviewPeriod, (next: OverviewPeriod) => void] {
  const period = useMemo(() => parseOverviewPeriod(route), [route]);
  const set = useCallback((next: OverviewPeriod) => navigate(overviewHref(next)), [navigate]);
  return [period, set];
}
