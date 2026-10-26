import type { I18n } from "../../i18n/core.ts";
import { type ChartSeries, type DayDatum, dayTotal } from "./model.ts";

/** "Tue, Oct 14": a calendar day, in UTC so the day never shifts with the viewer's zone. */
export function dayLabel(i18n: I18n, date: string): string {
  return i18n.date(`${date}T00:00:00Z`, {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** The default total: "23 runs". Callers with another noun pass their own `formatTotal`. */
export const runsTotal =
  (i18n: I18n) =>
  (n: number): string =>
    i18n.t("charts.total.runs", { n });

export function seriesValue(i18n: I18n, series: ChartSeries, n: number): string {
  return series.describe
    ? series.describe(n)
    : i18n.t("charts.series.value", { label: series.label, n: i18n.number(n) });
}

/**
 * What a bar or a heatmap day announces: "Tue, Oct 14: 23 runs, 18 tasks, 5 automations".
 * Series with nothing that day are left out; a day with nothing says so.
 */
export function describeDay(
  i18n: I18n,
  day: DayDatum,
  series: readonly ChartSeries[],
  shown: readonly string[],
  formatTotal: (n: number) => string = runsTotal(i18n),
): string {
  const date = dayLabel(i18n, day.date);
  const total = dayTotal(day, shown);
  if (total === 0) return i18n.t("charts.day.none", { date });
  const parts = series
    .filter((s) => shown.includes(s.id) && (day.values[s.id] ?? 0) > 0)
    .map((s) => seriesValue(i18n, s, day.values[s.id] ?? 0));
  return i18n.t("charts.day.announce", {
    date,
    total: formatTotal(total),
    parts: i18n.list(parts),
  });
}

export interface DataTable {
  head: string[];
  rows: string[][];
}

/** The visually hidden table behind a chart: every day and series, not only the shown ones. */
export function dataTable(
  i18n: I18n,
  days: readonly DayDatum[],
  series: readonly ChartSeries[],
): DataTable {
  return {
    head: [
      i18n.t("charts.table.date"),
      ...series.map((s) => s.label),
      i18n.t("charts.table.total"),
    ],
    rows: days.map((d) => [
      dayLabel(i18n, d.date),
      ...series.map((s) => i18n.number(d.values[s.id] ?? 0)),
      i18n.number(
        dayTotal(
          d,
          series.map((s) => s.id),
        ),
      ),
    ]),
  };
}
