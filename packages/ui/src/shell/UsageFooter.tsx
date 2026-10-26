import type { MethodResult } from "@psyche/protocol";
import * as m from "motion/react-m";
import { type ReactElement, useEffect, useMemo } from "react";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "../components/ui/hover-card.tsx";
import { useGatewayQuery, useStoreState } from "../data/index.ts";
import { activeI18n, t } from "../i18n/core.ts";
import { formatTime } from "../lib/format.ts";
import { cn } from "../lib/utils.ts";
import { motionSpring, spring } from "../motion/tokens.ts";
import { tokens as formatTokens, usd } from "../screens/settings/UsageSection.tsx";
import { useReducedMotion } from "../theme/ThemeProvider.tsx";

/**
 * Usage under the persona's name (#599): a quiet second line and a small graphic, from the
 * Gateway's `usage.summary`. API keys show today's cost and tokens with a 7-day sparkline, or a
 * segmented bar against the monthly budget when one is set (warning at 80 %, danger at 100 %).
 * Subscription CLIs show turns and tokens today, and a ring only when the adapter reads the plan's
 * window: never an estimated percentage. Hover or focus shows the week by model; a click opens
 * Settings → Usage. The compact rail shows the graphic alone with the numbers in the card.
 */

export type UsageSummaryData = MethodResult<"usage.summary">;
export type UsageLead = "api" | "subscription" | "none";

/** Which kind of usage leads: the primary model's, else today's busiest model's. */
export function usageLead(s: UsageSummaryData): UsageLead {
  const models = [...s.today.byModel, ...s.byModel];
  if (models.length === 0 && s.today.turns === 0) return "none";
  const primary = s.primary ? models.find((x) => x.modelRef === s.primary) : undefined;
  const lead = primary ?? s.today.byModel[0] ?? s.byModel[0];
  return lead?.subscription ? "subscription" : "api";
}

/** Share of the monthly budget spent, or null without a budget. */
export function budgetFraction(s: UsageSummaryData): number | null {
  if (s.budgetUsd == null || s.budgetUsd <= 0) return null;
  return s.month.costUsd / s.budgetUsd;
}

/** The budget bar's tone: accent below 80 %, warning from 80 %, danger from 100 %. */
export function budgetTone(fraction: number): "ok" | "warning" | "danger" {
  if (fraction >= 1) return "danger";
  if (fraction >= 0.8) return "warning";
  return "ok";
}

/** The second line's text. */
export function usageLine(s: UsageSummaryData): string {
  const lead = usageLead(s);
  if (lead === "none") return t("shell.usage.none");
  if (lead === "subscription")
    return t("shell.usage.subscriptionLine", {
      turns: s.today.turns,
      tokens: formatTokens(s.today.tokens),
    });
  return t("shell.usage.apiLine", {
    cost: usd(s.today.costUsd),
    tokens: formatTokens(s.today.tokens),
  });
}

/** The days' values the sparkline draws: cost for API keys, tokens for subscriptions. */
function series(s: UsageSummaryData, lead: UsageLead): number[] {
  return s.days.map((d) =>
    lead === "api" && s.days.some((x) => x.costUsd > 0) ? d.costUsd : d.tokens,
  );
}

/** A one-path 7-day sparkline, no axes (caption size). It draws in unless motion is reduced. */
export function Sparkline({
  values,
  width = 40,
  height = 14,
}: {
  values: readonly number[];
  width?: number;
  height?: number;
}): ReactElement {
  const reduce = useReducedMotion();
  const max = Math.max(...values, 0);
  const n = values.length;
  const pad = 1.5;
  const points = values.map((v, i) => {
    const x = n <= 1 ? width / 2 : pad + (i * (width - pad * 2)) / (n - 1);
    const y = max === 0 ? height - pad : height - pad - (v / max) * (height - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const d = points.length > 0 ? `M${points.join(" L")}` : "";
  const last = points.at(-1)?.split(",").map(Number);
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden="true"
      className="shrink-0 overflow-visible text-accent-9"
      data-testid="usage-sparkline"
    >
      {d ? (
        <m.path
          d={d}
          fill="none"
          stroke="currentColor"
          strokeOpacity={max === 0 ? 0.3 : 0.6}
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
          initial={reduce ? false : { pathLength: 0 }}
          animate={{ pathLength: 1 }}
          transition={motionSpring(spring.gentle)}
        />
      ) : null}
      {last && max > 0 ? <circle cx={last[0]} cy={last[1]} r={1.75} fill="currentColor" /> : null}
    </svg>
  );
}

/** A thin bar of 10 segments against the monthly budget. */
export function BudgetBar({
  fraction,
  width = 40,
}: {
  fraction: number;
  width?: number;
}): ReactElement {
  const tone = budgetTone(fraction);
  const filled = Math.min(10, Math.ceil(Math.max(0, fraction) * 10));
  return (
    <span
      aria-hidden="true"
      className="flex shrink-0 gap-px"
      style={{ width }}
      data-testid="usage-budget"
      data-tone={tone}
    >
      {Array.from({ length: 10 }, (_, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: ten fixed segments
          key={i}
          className={cn(
            "h-1 flex-1 rounded-full",
            i >= filled
              ? "bg-fill-secondary"
              : tone === "danger"
                ? "bg-danger"
                : tone === "warning"
                  ? "bg-approval"
                  : "bg-accent-9",
          )}
        />
      ))}
    </span>
  );
}

/** The plan window's share used, as a 14 px ring. */
export function PlanRing({
  fraction,
  size = 14,
}: {
  fraction: number;
  size?: number;
}): ReactElement {
  const r = (size - 2.5) / 2;
  const c = 2 * Math.PI * r;
  const tone = budgetTone(fraction);
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      aria-hidden="true"
      className={cn(
        "shrink-0 -rotate-90",
        tone === "danger" ? "text-danger" : tone === "warning" ? "text-approval" : "text-accent-9",
      )}
      data-testid="usage-ring"
    >
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="var(--fill-secondary)"
        strokeWidth={2.5}
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="currentColor"
        strokeWidth={2.5}
        strokeLinecap="round"
        strokeDasharray={`${c * Math.min(1, Math.max(0, fraction))} ${c}`}
      />
    </svg>
  );
}

/** The graphic for the summary: ring (plan window), bar (budget) or sparkline. */
export function UsageGraphic({
  summary,
  mini = false,
}: {
  summary: UsageSummaryData;
  /** The rail's 20 px form. */
  mini?: boolean;
}): ReactElement | null {
  const lead = usageLead(summary);
  if (lead === "none") return null;
  if (lead === "subscription" && summary.planWindow)
    return <PlanRing fraction={summary.planWindow.usedFraction} />;
  const budget = lead === "api" ? budgetFraction(summary) : null;
  if (budget !== null) return <BudgetBar fraction={budget} width={mini ? 20 : 40} />;
  return <Sparkline values={series(summary, lead)} width={mini ? 20 : 40} />;
}

/** A model reference as people read it: `anthropic/claude-sonnet-5-5` → `claude-sonnet-5-5`. */
function modelName(ref: string): string {
  return ref.split("/").slice(1).join("/") || ref;
}

/** The hover/focus card: the week by model, the month, the budget or plan window. */
export function UsageCard({ summary }: { summary: UsageSummaryData }): ReactElement {
  const lead = usageLead(summary);
  const budget = budgetFraction(summary);
  const i18n = activeI18n();
  return (
    <div className="flex flex-col gap-2 text-callout" data-testid="usage-card">
      <p className="text-headline text-label-primary">{usageLine(summary)}</p>
      {summary.byModel.length > 0 ? (
        <section className="flex flex-col gap-1">
          <h3 className="text-caption text-label-tertiary">{t("shell.usage.week")}</h3>
          <ul className="flex flex-col gap-0.5">
            {summary.byModel.map((row) => (
              <li key={row.modelRef} className="flex items-baseline gap-2">
                <span className="min-w-0 flex-1 truncate text-label-primary">
                  {modelName(row.modelRef)}
                </span>
                <span className="shrink-0 tabular-nums text-label-secondary">
                  {row.subscription
                    ? t("shell.usage.turnsTokens", {
                        turns: row.turns,
                        tokens: formatTokens(row.tokens),
                      })
                    : t("shell.usage.costTokens", {
                        cost: usd(row.costUsd),
                        tokens: formatTokens(row.tokens),
                      })}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {lead === "api" ? (
        <p className="text-label-secondary">
          {budget !== null && summary.budgetUsd != null
            ? t("shell.usage.budget", {
                spent: usd(summary.month.costUsd),
                budget: usd(summary.budgetUsd),
                pct: i18n.number(budget, { style: "percent", maximumFractionDigits: 0 }),
              })
            : t("shell.usage.month", { cost: usd(summary.month.costUsd) })}
        </p>
      ) : null}
      {lead === "subscription" ? (
        <p className="text-label-secondary">
          {summary.planWindow
            ? t("shell.usage.window", {
                pct: i18n.number(summary.planWindow.usedFraction, {
                  style: "percent",
                  maximumFractionDigits: 0,
                }),
                when: formatTime(summary.planWindow.resetsAt),
              })
            : t("shell.usage.noWindow")}
        </p>
      ) : null}
      <p className="text-label-tertiary">{t("shell.usage.openHint")}</p>
    </div>
  );
}

/**
 * `usage.summary` for the last 7 days in this device's time zone, fetched again a moment after
 * each run ends (the `run.updated` events the store already keeps).
 */
export function useUsageSummary(): UsageSummaryData | undefined {
  const timeZone = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", []);
  const q = useGatewayQuery("usage.summary", { days: 7, timeZone });
  const ended = useStoreState(
    (s) => Object.values(s.runs).filter((r) => r.status !== "running" && r.endedAt).length,
  );
  const { reload } = q;
  useEffect(() => {
    if (ended === 0) return;
    const timer = setTimeout(reload, 800);
    return () => clearTimeout(timer);
  }, [ended, reload]);
  // An older Gateway refuses the method (unknown_method); show nothing rather than guess.
  const data = q.data as Partial<UsageSummaryData> | undefined;
  if (q.error || !data || !Array.isArray(data.days) || !data.today || !data.month) return undefined;
  return data as UsageSummaryData;
}

export interface UsageFooterProps {
  summary: UsageSummaryData;
  /** The full sidebar's name-and-usage block, or the rail's graphic alone. */
  variant?: "full" | "rail";
  /** The persona's name: the full block's first line, beside the graphic. */
  name?: string;
  onOpenUsage?: () => void;
}

/**
 * The footer's usage control (presentational). Full: the name with the graphic, the usage line
 * under it, as one control. Rail: the graphic alone.
 */
export function UsageFooter({
  summary,
  variant = "full",
  name,
  onOpenUsage,
}: UsageFooterProps): ReactElement {
  const line = usageLine(summary);
  const rail = variant === "rail";
  return (
    <HoverCard>
      <HoverCardTrigger
        delay={300}
        render={
          <button
            type="button"
            onClick={onOpenUsage}
            aria-label={
              name ? t("shell.usage.labelNamed", { name, line }) : t("shell.usage.label", { line })
            }
            className={cn(
              "flex min-w-0 rounded-sm text-start outline-none focus-visible:ring-2 focus-visible:ring-ring",
              rail ? "h-8 w-6 items-center justify-center" : "w-full flex-col",
            )}
            data-testid="usage-footer"
          />
        }
      >
        {rail ? (
          <UsageGraphic summary={summary} mini />
        ) : (
          <>
            <span className="flex min-w-0 items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-headline text-label-primary">
                {name}
              </span>
              <UsageGraphic summary={summary} />
            </span>
            <span className="min-w-0 truncate text-callout text-label-tertiary">{line}</span>
          </>
        )}
      </HoverCardTrigger>
      <HoverCardContent side={rail ? "right" : "top"} align="start" className="w-72">
        <UsageCard summary={summary} />
      </HoverCardContent>
    </HoverCard>
  );
}

/**
 * The footer's usage with live data. While it loads, or when the Gateway can't say, the full
 * block is the name alone and the rail shows nothing.
 */
export function ConnectedUsageFooter(
  props: Omit<UsageFooterProps, "summary">,
): ReactElement | null {
  const summary = useUsageSummary();
  if (summary === undefined)
    return props.variant === "rail" ? null : (
      <span className="min-w-0 truncate text-headline">{props.name}</span>
    );
  return <UsageFooter summary={summary} {...props} />;
}
