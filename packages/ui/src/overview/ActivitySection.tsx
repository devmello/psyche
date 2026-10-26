import type { ReactElement, ReactNode } from "react";
import { CalendarHeatmap } from "../components/charts/CalendarHeatmap.tsx";
import { dayLabel } from "../components/charts/describe.ts";
import type { ChartSeries, DayDatum } from "../components/charts/model.ts";
import { ACTIVITY_SERIES_COLORS, StackedBars } from "../components/charts/StackedBars.tsx";
import { Skeleton } from "../components/ui/skeleton.tsx";
import { type InsightsSummary, useInsights } from "../data/insights.ts";
import { useI18n } from "../i18n/I18nProvider.tsx";
import type { MessageId } from "../i18n/index.ts";
import { formatDuration } from "../lib/format.ts";
import { usePersona } from "../slots.tsx";
import { OverviewSection } from "./OverviewSection.tsx";
import { go, type OverviewLink, recentLink } from "./overviewLinks.ts";
import type { OverviewPeriod } from "./period.ts";
import { parseRecentFilter, recentHref, scrollToRecent } from "./recentFilter.ts";
import { SectionBody, useSectionStatus } from "./SectionState.tsx";
import { hasNoRuns, PERIOD_WORD } from "./summaryModel.ts";

export interface OverviewActivityProps {
  period: OverviewPeriod;
  /** The shell's `navigate`; without it facts and days are plain links. */
  onNavigate?: (to: string) => void;
  /** The current route, to mark the day the Recent runs filter is on. */
  route?: string;
}

/** The Activity card (agent-overview-2026 §5.4): bars for a week or month, a calendar for all time. */
export function OverviewActivity({
  period,
  onNavigate,
  route = "",
}: OverviewActivityProps): ReactElement {
  const i18n = useI18n();
  const insights = useInsights(period);
  const status = useSectionStatus("activity", [
    { ...insights, has: insights.data !== undefined, key: period },
  ]);
  const meta = i18n.t("overview.activity.meta", { period: PERIOD_WORD[period] });
  return (
    <OverviewSection id="activity" meta={meta}>
      <SectionBody
        id="activity"
        status={status}
        reserve="min-h-48"
        skeleton={<Skeleton className="h-48" />}
      >
        {insights.data === undefined ? null : (
          <ActivityBody
            period={period}
            insights={insights.data}
            onNavigate={onNavigate}
            selectedDay={parseRecentFilter(route).day}
          />
        )}
      </SectionBody>
    </OverviewSection>
  );
}

export interface ActivityBodyProps {
  period: OverviewPeriod;
  insights: InsightsSummary;
  onNavigate: ((to: string) => void) | undefined;
  selectedDay?: string | null;
}

export function ActivityBody({
  period,
  insights,
  onNavigate,
  selectedDay = null,
}: ActivityBodyProps): ReactElement {
  const i18n = useI18n();
  const { name } = usePersona();
  const { totals, days } = insights;

  const series: ChartSeries[] = (["tasks", "automations", "chat"] as const).map((id) => ({
    id,
    label: i18n.t(`overview.activity.series.${id}` as MessageId),
    color: ACTIVITY_SERIES_COLORS[id],
    describe: (n: number) => i18n.t(`overview.activity.n.${id}` as MessageId, { n }),
  }));
  const data: DayDatum[] = days.map((d) => ({
    date: d.date,
    values: { tasks: d.runs.task, automations: d.runs.automation, chat: d.runs.chat },
    ...(d.wallMs > 0
      ? { detail: i18n.t("overview.activity.dayTime", { duration: formatDuration(d.wallMs) }) }
      : {}),
  }));
  // The chart hands over a day, not a click: go where a link to that day would.
  const onSelectDay = (date: string) => {
    if (onNavigate !== undefined) go(recentHref(period, { day: date }), onNavigate, scrollToRecent);
  };

  const empty = hasNoRuns(days);
  const caption = empty ? (
    <span data-testid="overview-activity-empty">
      {i18n.t("overview.summary.quiet", { period: PERIOD_WORD[period] })}
    </span>
  ) : (
    <Facts
      busiest={
        totals.busiestDay == null
          ? null
          : {
              label: dayLabel(i18n, totals.busiestDay.date),
              runs: totals.busiestDay.runs,
              link: recentLink(period, { day: totals.busiestDay.date }, onNavigate),
            }
      }
      worked={totals.wallMs > 0 ? formatDuration(totals.wallMs) : null}
      name={name}
      topAutomation={
        totals.topAutomation == null
          ? null
          : {
              title: totals.topAutomation.title,
              runs: totals.topAutomation.runs,
              link: recentLink(period, { filter: "automations" }, onNavigate),
            }
      }
    />
  );

  return period === "all" ? (
    <CalendarHeatmap
      days={data}
      series={series}
      onSelectDay={onSelectDay}
      selectedDate={selectedDay}
      caption={caption}
      label={i18n.t("overview.activity.label")}
      testId="overview-activity-heatmap"
    />
  ) : (
    <StackedBars
      days={data}
      series={series}
      onSelectDay={onSelectDay}
      selectedDate={selectedDay}
      caption={caption}
      label={i18n.t("overview.activity.label")}
      testId="overview-activity-bars"
    />
  );
}

const linkClass =
  "rounded-sm underline underline-offset-2 outline-none hover:text-label-primary focus-visible:ring-2 focus-visible:ring-ring";

function FactLink({ link, children }: { link: OverviewLink; children: ReactNode }): ReactElement {
  return (
    <a href={link.href} onClick={link.onClick} className={linkClass}>
      {children}
    </a>
  );
}

/**
 * The facts under the chart (the figcaption): busiest day, measured run time, most-run
 * automation. Each drops out when there is nothing behind it. The run time is the only place
 * the page shows time, and says it is measured (§5.4).
 */
function Facts({
  busiest,
  worked,
  name,
  topAutomation,
}: {
  busiest: { label: string; runs: number; link: OverviewLink } | null;
  worked: string | null;
  name: string;
  topAutomation: { title: string; runs: number; link: OverviewLink } | null;
}): ReactElement {
  const i18n = useI18n();
  return (
    <span
      className="flex flex-wrap gap-x-6 gap-y-1 text-callout text-label-secondary"
      data-testid="overview-activity-facts"
    >
      {busiest === null ? null : (
        <span data-testid="overview-fact-busiest">
          <FactLink link={busiest.link}>
            {i18n.t("overview.activity.busiest", { date: busiest.label, n: busiest.runs })}
          </FactLink>
        </span>
      )}
      {worked === null ? null : (
        <span data-testid="overview-fact-worked">
          {i18n.t("overview.activity.worked", { name, duration: worked })}
        </span>
      )}
      {topAutomation === null ? null : (
        <span data-testid="overview-fact-top-automation">
          <FactLink link={topAutomation.link}>
            {i18n.t("overview.activity.topAutomation", {
              title: topAutomation.title,
              n: i18n.number(topAutomation.runs),
            })}
          </FactLink>
        </span>
      )}
    </span>
  );
}
