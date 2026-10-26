import type { GrowthSummary } from "@psyche/protocol";
import { Check, Clock, X } from "lucide-react";
import type { ReactElement, ReactNode } from "react";
import { agentSheetHref } from "../agent/AgentSheet.tsx";
import { StatTile } from "../components/charts/StatTile.tsx";
import { Button } from "../components/ui/button.tsx";
import { Skeleton } from "../components/ui/skeleton.tsx";
import { useGatewayQuery } from "../data/hooks.ts";
import { type InsightsSummary, useInsights } from "../data/insights.ts";
import { useI18n } from "../i18n/I18nProvider.tsx";
import type { MessageId } from "../i18n/index.ts";
import { usePersona } from "../slots.tsx";
import { type OverviewLink, recentLink, routeLink, sectionLink } from "./overviewLinks.ts";
import { type OverviewPeriod, overviewHref } from "./period.ts";
import {
  approvalsDecided,
  automationSpark,
  comparisonKey,
  okPercent,
  PERIOD_WORD,
  summaryKinds,
  taskSpark,
  tasksDone,
} from "./summaryModel.ts";

export interface OverviewSummaryProps {
  period: OverviewPeriod;
  /** The shell's `navigate`; without it tiles are plain links. */
  onNavigate?: (to: string) => void;
}

/**
 * The Summary (agent-overview-2026 §5.4): one templated sentence over the computed totals and
 * four tiles. It waits for `insights.summary`; the Lessons tile waits for `growth.summary` on
 * its own, so a slow Growth never holds the sentence back.
 */
export function OverviewSummary({ period, onNavigate }: OverviewSummaryProps): ReactElement {
  const i18n = useI18n();
  const insights = useInsights(period);
  const growth = useGatewayQuery("growth.summary", { window: period });
  return (
    <section aria-label={i18n.t("overview.summary.label")} data-testid="overview-summary">
      {insights.data === undefined ? (
        insights.error === null ? (
          <SummarySkeleton />
        ) : (
          <LoadFailed onRetry={insights.reload} />
        )
      ) : (
        <SummaryBody
          period={period}
          insights={insights.data}
          growth={growth.data?.summary}
          growthState={growth.error === null ? (growth.loading ? "loading" : "ready") : "error"}
          onRetryGrowth={growth.reload}
          onNavigate={onNavigate}
        />
      )}
    </section>
  );
}

export interface SummaryBodyProps {
  period: OverviewPeriod;
  insights: InsightsSummary;
  growth: GrowthSummary | undefined;
  growthState?: "loading" | "ready" | "error";
  onRetryGrowth?: () => void;
  onNavigate: ((to: string) => void) | undefined;
}

export function SummaryBody({
  period,
  insights,
  growth,
  growthState = growth === undefined ? "loading" : "ready",
  onRetryGrowth,
  onNavigate,
}: SummaryBodyProps): ReactElement {
  const i18n = useI18n();
  const { totals, previous, days } = insights;
  const compare = comparisonKey(period);
  const vs = compare === null ? "" : i18n.t(compare as MessageId);
  // All time has no previous window, so no deltas at all (§5.4).
  const prev = previous != null && compare !== null ? previous : null;
  const decided = approvalsDecided(totals);
  const okPct = okPercent(totals.runsByKind.automation.done, totals.runsByKind.automation.failed);

  return (
    <div className="flex flex-col gap-4">
      <Sentence period={period} insights={insights} lessons={growth?.lessons.learned ?? 0} />
      <div className="grid grid-cols-2 gap-4 @min-[880px]/overview:grid-cols-4">
        <StatTile
          testId="overview-tile-tasks"
          label={i18n.t("overview.summary.tile.tasks")}
          value={tasksDone(totals)}
          {...(prev === null ? {} : { previous: tasksDone(prev), periodLabel: vs })}
          spark={taskSpark(days)}
          {...linkProps(recentLink(period, { filter: "tasks", status: "done" }, onNavigate))}
        />
        <StatTile
          testId="overview-tile-automations"
          label={i18n.t("overview.summary.tile.automations")}
          value={totals.runs.automation}
          {...(prev === null ? {} : { previous: prev.runs.automation, periodLabel: vs })}
          spark={automationSpark(days)}
          subline={
            okPct === null ? undefined : (
              <RunHealth
                pct={okPct}
                failed={totals.runsByKind.automation.failed}
                failedLink={recentLink(period, { filter: "failed" }, onNavigate)}
              />
            )
          }
          {...linkProps(recentLink(period, { filter: "automations" }, onNavigate))}
        />
        <StatTile
          testId="overview-tile-approvals"
          label={i18n.t("overview.summary.tile.approvals")}
          value={decided}
          {...(prev === null ? {} : { previous: approvalsDecided(prev), periodLabel: vs })}
          subline={<Decisions totals={totals.approvals} />}
          {...linkProps(
            routeLink(
              agentSheetHref("approvals", { back: overviewHref(period), view: "decided" }),
              onNavigate,
            ),
          )}
        />
        {growth === undefined ? (
          <LessonsPlaceholder state={growthState} onRetry={onRetryGrowth} />
        ) : (
          <StatTile
            testId="overview-tile-lessons"
            label={i18n.t("overview.summary.tile.lessons")}
            value={growth.lessons.learned}
            subline={
              growth.lessons.confirmed > 0
                ? i18n.t("overview.summary.confirmed", { n: i18n.number(growth.lessons.confirmed) })
                : undefined
            }
            {...linkProps(sectionLink("growth"))}
          />
        )}
      </div>
    </div>
  );
}

const linkProps = (link: OverviewLink) => ({ href: link.href, onClick: link.onClick });

/** The sentence: ICU templates over the totals, one clause dropped per zero. */
function Sentence({
  period,
  insights,
  lessons,
}: {
  period: OverviewPeriod;
  insights: InsightsSummary;
  lessons: number;
}): ReactElement {
  const i18n = useI18n();
  const { name } = usePersona();
  const { totals } = insights;
  const kinds = summaryKinds(totals);
  const args = {
    period: PERIOD_WORD[period],
    name,
    tasks: tasksDone(totals),
    automations: totals.runs.automation,
  };
  const first = i18n.t(`overview.summary.sentence.${kinds}` as MessageId, args);
  const second =
    lessons > 0 ? i18n.t("overview.summary.sentence.lessons", { name, n: lessons }) : "";
  return (
    <p className="text-title-3 text-label-primary" data-testid="overview-summary-sentence">
      {[first, second].filter((s) => s !== "").join(" ")}
    </p>
  );
}

function RunHealth({
  pct,
  failed,
  failedLink,
}: {
  pct: number;
  failed: number;
  failedLink: OverviewLink;
}): ReactElement {
  const i18n = useI18n();
  return (
    <span data-testid="overview-run-health">
      {i18n.t("overview.summary.runsOk", {
        pct: i18n.percent(pct / 100, { maximumFractionDigits: 0 }),
      })}
      {failed > 0 ? (
        <>
          {" · "}
          <a
            href={failedLink.href}
            onClick={failedLink.onClick}
            className="rounded-sm underline underline-offset-2 outline-none hover:text-label-primary focus-visible:ring-2 focus-visible:ring-ring"
          >
            {i18n.t("overview.summary.failed", { n: i18n.number(failed) })}
          </a>
        </>
      ) : null}
    </span>
  );
}

/** "16 approved · 2 denied": icons and words, never colour alone; zero parts are dropped. */
function Decisions({
  totals,
}: {
  totals: { approved: number; denied: number; expired: number };
}): ReactNode {
  const i18n = useI18n();
  const parts = [
    { key: "approved", n: totals.approved, Icon: Check },
    { key: "denied", n: totals.denied, Icon: X },
    { key: "expired", n: totals.expired, Icon: Clock },
  ] as const;
  const shown = parts.filter((p) => p.n > 0);
  if (shown.length === 0) return undefined;
  return (
    <span className="inline-flex flex-wrap gap-x-2" data-testid="overview-decisions">
      {shown.map(({ key, n, Icon }) => (
        <span key={key} className="inline-flex items-center gap-1">
          <Icon aria-hidden="true" className="size-3" />
          {i18n.t(`overview.summary.${key}` as MessageId, { n: i18n.number(n) })}
        </span>
      ))}
    </span>
  );
}

function LessonsPlaceholder({
  state,
  onRetry,
}: {
  state: "loading" | "ready" | "error";
  onRetry: (() => void) | undefined;
}): ReactElement {
  const i18n = useI18n();
  if (state === "error") {
    return (
      <div className="flex min-h-24 flex-col justify-center gap-2 rounded-lg border border-separator p-5">
        <span className="text-caption text-label-secondary">
          {i18n.t("overview.summary.tile.lessons")}
        </span>
        <LoadFailed onRetry={onRetry} />
      </div>
    );
  }
  return <Skeleton className="min-h-24" data-testid="overview-tile-lessons-loading" />;
}

function SummarySkeleton(): ReactElement {
  const i18n = useI18n();
  return (
    <div
      className="flex flex-col gap-4"
      role="status"
      aria-label={i18n.t("overview.loading")}
      data-testid="overview-summary-loading"
    >
      <Skeleton className="h-7 w-3/4" />
      <div className="grid grid-cols-2 gap-4 @min-[880px]/overview:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-24" />
        ))}
      </div>
    </div>
  );
}

/** The section-level failure: "Couldn’t load · Retry". Only this section fails (§5.5). */
export function LoadFailed({ onRetry }: { onRetry: (() => void) | undefined }): ReactElement {
  const i18n = useI18n();
  return (
    <div
      role="alert"
      className="flex items-center gap-2 text-callout text-label-secondary"
      data-testid="overview-load-failed"
    >
      <span>{i18n.t("overview.error.load")}</span>
      {onRetry === undefined ? null : (
        <>
          <span aria-hidden="true">·</span>
          <Button size="sm" variant="ghost" onClick={onRetry}>
            {i18n.t("common.retry")}
          </Button>
        </>
      )}
    </div>
  );
}
