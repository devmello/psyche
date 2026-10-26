import { type ReactElement, type ReactNode, useMemo, useState } from "react";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import { cn } from "../../lib/utils.ts";
import { ChartFigure } from "./ChartFigure.tsx";
import { ChartTooltip } from "./ChartTooltip.tsx";
import { dataTable, dayLabel, describeDay, runsTotal, seriesValue } from "./describe.ts";
import {
  bucketOf,
  bucketRanges,
  type ChartSeries,
  type DayDatum,
  dayTotal,
  quantileEdges,
  rampLevel,
  type WeekStart,
  weekColumns,
} from "./model.ts";
import { useRovingNav } from "./useRovingNav.ts";

export interface CalendarHeatmapProps {
  /** Days with activity (a sparse list is fine; the days between are drawn empty). */
  days: readonly DayDatum[];
  /** Used for the spoken breakdown and the tooltip; the colour is the all-series total. */
  series: readonly ChartSeries[];
  onSelectDay?: (date: string) => void;
  selectedDate?: string | null;
  /** First row of each column: 1 = Monday (default), 0 = Sunday. */
  weekStartsOn?: WeekStart;
  label?: string;
  caption?: ReactNode;
  /** "23 runs": the total in announcements; default counts runs. */
  formatTotal?: (n: number) => string;
  testId?: string;
}

const HEADER_ROW = 1;

/**
 * A weeks × 7 calendar of runs per day (agent-overview-2026 §5.4). Five buckets whose edges are
 * quantiles of the owner's own non-zero days, so a light user still sees contrast; the legend
 * prints the real ranges. Colour comes from `--heat-*` (a dark ramp of its own), every day is a
 * button with the spoken count, and the week columns run in the reading direction, so they
 * mirror in RTL.
 */
export function CalendarHeatmap({
  days,
  series,
  onSelectDay,
  selectedDate = null,
  weekStartsOn = 1,
  label,
  caption,
  formatTotal,
  testId = "calendar-heatmap",
}: CalendarHeatmapProps): ReactElement {
  const i18n = useI18n();
  const rtl = i18n.dir === "rtl";
  const [hot, setHot] = useState<string | null>(null);
  const ids = useMemo(() => series.map((s) => s.id), [series]);
  const total = formatTotal ?? runsTotal(i18n);
  const name = label ?? i18n.t("charts.heatmap.label");
  const byDate = useMemo(() => new Map(days.map((d) => [d.date, d])), [days]);
  const dates = useMemo(() => [...byDate.keys()].sort(), [byDate]);
  const weeks = useMemo(
    () =>
      dates.length === 0
        ? []
        : weekColumns(dates[0] as string, dates.at(-1) as string, weekStartsOn),
    [dates, weekStartsOn],
  );
  const edges = useMemo(() => quantileEdges(days.map((d) => dayTotal(d, ids))), [days, ids]);
  const ranges = useMemo(() => bucketRanges(edges), [edges]);
  const slots = useMemo(() => weeks.flat(), [weeks]);
  // The roving stop starts on the newest day.
  const lastSlot = slots.reduce((acc, c, i) => (c ? i : acc), 0);
  const nav = useRovingNav(
    { count: slots.length, rows: 7, rtl, enabled: (i) => slots[i] != null },
    lastSlot,
  );
  const stop = slots[nav.active] != null ? nav.active : lastSlot;
  const table = dataTable(
    i18n,
    days.length ? [...days].sort((a, b) => a.date.localeCompare(b.date)) : [],
    series,
  );
  const empty: DayDatum = { date: "", values: {} };
  const rangeText = (from: number, to: number) =>
    from === to
      ? i18n.number(to)
      : i18n.t("charts.legend.range", { from: i18n.number(from), to: i18n.number(to) });
  let lastMonth = -1;

  return (
    <ChartFigure
      label={name}
      caption={caption}
      table={table}
      hint={i18n.t("charts.hint")}
      testId={testId}
    >
      {(hintId) => (
        <div dir={i18n.dir}>
          {/* biome-ignore lint/a11y/useSemanticElements: a toolbar-like group of controls, not a form fieldset */}
          <div
            role="group"
            aria-label={name}
            aria-describedby={hintId}
            className="grid gap-[3px]"
            style={{
              gridTemplateColumns: `repeat(${Math.max(1, weeks.length)}, minmax(0, 1fr))`,
              gridTemplateRows: "auto",
            }}
          >
            {weeks.map((week, w) => {
              const first = week.find((c) => c !== null);
              const month = first ? new Date(`${first.date}T00:00:00Z`).getUTCMonth() : -1;
              const showMonth = first !== undefined && month !== lastMonth;
              if (first) lastMonth = month;
              return showMonth && w < weeks.length - 1 ? (
                <span
                  key={`m-${first?.date}`}
                  aria-hidden="true"
                  className="whitespace-nowrap text-caption text-label-tertiary"
                  style={{ gridColumn: w + 1, gridRow: HEADER_ROW }}
                >
                  {i18n.date(`${first?.date}T00:00:00Z`, { month: "short", timeZone: "UTC" })}
                </span>
              ) : null;
            })}
            {weeks.flatMap((week, w) =>
              week.map((cell, row) => {
                if (cell === null) return null;
                const slot = w * 7 + row;
                const day = byDate.get(cell.date) ?? { ...empty, date: cell.date };
                const value = dayTotal(day, ids);
                const bucket = bucketOf(value, edges);
                const level = rampLevel(bucket, edges.length);
                const selected = cell.date === selectedDate;
                return (
                  // biome-ignore lint/a11y/noStaticElementInteractions: hover and Esc only show or hide the tooltip; the button inside is the control
                  <div
                    key={cell.date}
                    className="relative aspect-square"
                    style={{ gridColumn: w + 1, gridRow: row + HEADER_ROW + 1 }}
                    onPointerEnter={() => setHot(cell.date)}
                    onPointerLeave={() => setHot((h) => (h === cell.date ? null : h))}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") setHot(null);
                    }}
                  >
                    <button
                      type="button"
                      ref={nav.register(slot)}
                      tabIndex={slot === stop ? 0 : -1}
                      aria-label={describeDay(i18n, day, series, ids, total)}
                      aria-pressed={onSelectDay ? selected : undefined}
                      data-level={level}
                      onClick={() => onSelectDay?.(cell.date)}
                      onKeyDown={nav.onKeyDown(slot)}
                      onFocus={() => {
                        nav.setActive(slot);
                        setHot(cell.date);
                      }}
                      onBlur={() => setHot((h) => (h === cell.date ? null : h))}
                      className={cn(
                        "block size-full rounded-[3px] outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        selected && "outline-2 outline-label-primary",
                      )}
                      style={{ background: `var(--heat-${level})` }}
                    />
                    {hot === cell.date ? (
                      <ChartTooltip
                        title={dayLabel(i18n, cell.date)}
                        rows={series
                          .filter((s) => (day.values[s.id] ?? 0) > 0)
                          .map((s) => ({
                            color: s.color,
                            label: s.label,
                            value: seriesValue(i18n, s, day.values[s.id] ?? 0),
                          }))}
                        footer={
                          <>
                            {total(value)}
                            {day.detail ? ` · ${day.detail}` : ""}
                          </>
                        }
                      />
                    ) : null}
                  </div>
                );
              }),
            )}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-caption text-label-secondary">
            {ranges.length === 0 ? (
              <span>{i18n.t("charts.legend.empty")}</span>
            ) : (
              <>
                <span>{i18n.t("charts.legend.fewer")}</span>
                <ul className="m-0 flex list-none flex-wrap items-center gap-x-3 gap-y-1 p-0">
                  {ranges.map((r) => (
                    <li key={r.bucket} className="flex items-center gap-1">
                      <span
                        aria-hidden="true"
                        className="size-3 rounded-[3px]"
                        style={{ background: `var(--heat-${r.level})` }}
                      />
                      <bdi className="tabular-nums">{rangeText(r.from, r.to)}</bdi>
                    </li>
                  ))}
                </ul>
                <span>{i18n.t("charts.legend.more")}</span>
              </>
            )}
          </div>
        </div>
      )}
    </ChartFigure>
  );
}
