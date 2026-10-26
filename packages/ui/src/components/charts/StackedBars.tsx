import { type ReactElement, type ReactNode, useMemo, useState } from "react";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import { cn } from "../../lib/utils.ts";
import { duration } from "../../motion/tokens.ts";
import { useReducedMotion } from "../../theme/ThemeProvider.tsx";
import { ChartFigure } from "./ChartFigure.tsx";
import { ChartTooltip } from "./ChartTooltip.tsx";
import { dataTable, dayLabel, describeDay, runsTotal, seriesValue } from "./describe.ts";
import { type ChartSeries, type DayDatum, dayTotal, layoutBars } from "./model.ts";
import { useRovingNav } from "./useRovingNav.ts";

/** The overview's three series, in a fixed order: the colour follows the series, never its rank. */
export const ACTIVITY_SERIES_COLORS = {
  tasks: "var(--chart-1)",
  automations: "var(--chart-2)",
  chat: "var(--chart-3)",
} as const;

export interface StackedBarsProps {
  /** One entry per calendar day, oldest first. */
  days: readonly DayDatum[];
  /** Stack order, bottom to top; also the legend order. */
  series: readonly ChartSeries[];
  /** Click or Enter on a day (the Activity card filters Recent runs to it). */
  onSelectDay?: (date: string) => void;
  selectedDate?: string | null;
  /** Series hidden at first; the legend toggles them. */
  defaultHidden?: readonly string[];
  /** The chart's name (figure label and hidden table). */
  label?: string;
  /** The facts line under the chart (figcaption). */
  caption?: ReactNode;
  /** "23 runs": the total in announcements; default counts runs. */
  formatTotal?: (n: number) => string;
  height?: number;
  testId?: string;
}

/**
 * Daily stacked bars by series (agent-overview-2026 §5.4). The legend doubles as the series
 * toggles, each bar is a button in a roving-tabindex group (arrows move, Enter selects), hover
 * and focus show a tooltip, and heights tween for 150 ms unless motion is reduced. The time axis
 * runs oldest to newest in the reading direction, so it mirrors in RTL.
 */
export function StackedBars({
  days,
  series,
  onSelectDay,
  selectedDate = null,
  defaultHidden = [],
  label,
  caption,
  formatTotal,
  height = 160,
  testId = "stacked-bars",
}: StackedBarsProps): ReactElement {
  const i18n = useI18n();
  const reduce = useReducedMotion();
  const rtl = i18n.dir === "rtl";
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set(defaultHidden));
  const [hot, setHot] = useState<number | null>(null);
  const nav = useRovingNav({ count: days.length, rtl });
  const order = useMemo(() => series.map((s) => s.id), [series]);
  const shown = useMemo(() => order.filter((id) => !hidden.has(id)), [order, hidden]);
  const { max, bars } = useMemo(
    () => layoutBars(days, order, shown, height),
    [days, order, shown, height],
  );
  const total = formatTotal ?? runsTotal(i18n);
  const name = label ?? i18n.t("charts.bars.label");
  const byId = new Map(series.map((s) => [s.id, s]));
  const step = Math.max(1, Math.ceil(days.length / 7));
  const toggle = (id: string) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else if (shown.length > 1) next.add(id);
      return next;
    });
  const tween = reduce ? "none" : `height ${duration.short}ms ease-out`;

  return (
    <ChartFigure
      label={name}
      caption={caption}
      table={dataTable(i18n, days, series)}
      hint={i18n.t("charts.hint")}
      testId={testId}
    >
      {(hintId) => (
        <div dir={i18n.dir}>
          {/* biome-ignore lint/a11y/useSemanticElements: a toolbar-like group of controls, not a form fieldset */}
          <div
            role="group"
            aria-label={i18n.t("charts.legend.series")}
            className="mb-3 flex flex-wrap gap-x-4 gap-y-1"
          >
            {series.map((s) => {
              const on = !hidden.has(s.id);
              const sum = days.reduce((n, d) => n + (d.values[s.id] ?? 0), 0);
              return (
                <button
                  key={s.id}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggle(s.id)}
                  className="inline-flex items-center gap-1.5 rounded-md px-1 py-0.5 text-callout text-label-secondary outline-none hover:bg-fill-quaternary focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span
                    aria-hidden="true"
                    className={cn("size-2.5 rounded-[3px]", !on && "opacity-30")}
                    style={{ background: s.color }}
                  />
                  <span className={cn(!on && "line-through")}>{s.label}</span>
                  <span className="tabular-nums text-label-tertiary">{i18n.number(sum)}</span>
                </button>
              );
            })}
          </div>
          <div className="relative mt-5" style={{ height }}>
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-x-0 top-0 border-t border-separator"
            />
            <span
              aria-hidden="true"
              className="pointer-events-none absolute -top-4 start-0 text-caption text-label-tertiary tabular-nums"
            >
              {i18n.number(max)}
            </span>
            {/* biome-ignore lint/a11y/useSemanticElements: a toolbar-like group of controls, not a form fieldset */}
            <div
              role="group"
              aria-label={name}
              aria-describedby={hintId}
              className="relative flex h-full items-end gap-1 border-b border-separator-strong"
            >
              {days.map((day, i) => {
                const bar = bars[i];
                const selected = day.date === selectedDate;
                return (
                  // biome-ignore lint/a11y/noStaticElementInteractions: hover and Esc only show or hide the tooltip; the button inside is the control
                  <div
                    key={day.date}
                    className="relative flex h-full min-w-0 flex-1 items-end"
                    onPointerEnter={() => setHot(i)}
                    onPointerLeave={() => setHot((h) => (h === i ? null : h))}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") setHot(null);
                    }}
                  >
                    <button
                      type="button"
                      ref={nav.register(i)}
                      tabIndex={nav.tabIndex(i)}
                      aria-label={describeDay(i18n, day, series, shown, total)}
                      aria-pressed={onSelectDay ? selected : undefined}
                      onClick={() => onSelectDay?.(day.date)}
                      onKeyDown={nav.onKeyDown(i)}
                      onFocus={() => {
                        nav.setActive(i);
                        setHot(i);
                      }}
                      onBlur={() => setHot((h) => (h === i ? null : h))}
                      className={cn(
                        "flex h-full w-full flex-col-reverse justify-start rounded-t-[4px] outline-none hover:bg-fill-quaternary focus-visible:ring-2 focus-visible:ring-ring",
                        selected && "bg-fill-secondary",
                      )}
                    >
                      {bar?.segments.map((seg, k) => (
                        <span
                          key={seg.id}
                          data-series={seg.id}
                          className={cn(
                            "block w-full",
                            k === bar.segments.length - 1 && "rounded-t-[4px]",
                          )}
                          style={{
                            height: seg.height,
                            // Column-reverse: the bottom margin is the gap to the fill below.
                            marginBottom: seg.gap,
                            background: byId.get(seg.id)?.color,
                            transition: tween,
                          }}
                        />
                      ))}
                    </button>
                    {hot === i ? (
                      <ChartTooltip
                        title={dayLabel(i18n, day.date)}
                        rows={series
                          .filter((s) => shown.includes(s.id))
                          .map((s) => ({
                            color: s.color,
                            label: s.label,
                            value: seriesValue(i18n, s, day.values[s.id] ?? 0),
                          }))}
                        footer={
                          <>
                            {total(dayTotal(day, shown))}
                            {day.detail ? ` · ${day.detail}` : ""}
                          </>
                        }
                      />
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>
          <div aria-hidden="true" className="mt-1 flex gap-1 text-caption text-label-tertiary">
            {days.map((day, i) => (
              <span key={day.date} className="relative h-3.5 min-w-0 flex-1">
                {i % step === 0 ? (
                  <span className="absolute start-1/2 -translate-x-1/2 whitespace-nowrap rtl:translate-x-1/2">
                    {i18n.date(`${day.date}T00:00:00Z`, {
                      month: "short",
                      day: "numeric",
                      timeZone: "UTC",
                    })}
                  </span>
                ) : null}
              </span>
            ))}
          </div>
        </div>
      )}
    </ChartFigure>
  );
}
