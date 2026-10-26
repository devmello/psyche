import type { MethodResult } from "@psyche/protocol";
import * as m from "motion/react-m";
import { type ReactElement, useEffect, useMemo } from "react";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "../components/ui/hover-card.tsx";
import { useGatewayQuery, useStoreState } from "../data/index.ts";
import { activeI18n, t } from "../i18n/core.ts";
import { formatTime } from "../lib/format.ts";
import { cn } from "../lib/utils.ts";
import { Sparkline } from "../components/sparkline.tsx";
import { tokens as formatTokens, usd } from "../screens/settings/UsageSection.tsx";

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

/** Provider kinds that drive a subscription through its CLI (no per-token cost). */
const SUBSCRIPTION_KINDS = new Set(["claude-code", "codex"]);

/**
 * Whether a model is a subscription CLI's: from the providers' kinds (`models.list`) when known,
 * else from the provider id itself (`claude-code/haiku`).
 */
export function isSubscriptionModel(
  modelRef: string | null | undefined,
  providers?: readonly { id: string; kind: string }[],
): boolean | undefined {
  if (!modelRef) return undefined;
  const id = modelRef.split("/")[0] ?? "";
  const kind = providers?.find((p) => p.id === id)?.kind;
  if (kind !== undefined) return SUBSCRIPTION_KINDS.has(kind);
  return SUBSCRIPTION_KINDS.has(id) ? true : undefined;
}

/**
 * Which kind of usage leads (#606): the primary model's provider kind when known, else the
 * primary's or today's busiest model's flag in the summary. "none" only when nothing tells.
 */
export function usageLead(s: UsageSummaryData, primarySubscription?: boolean): UsageLead {
  const known = primarySubscription ?? isSubscriptionModel(s.primary);
  if (known !== undefined) return known ? "subscription" : "api";
  const models = [...s.today.byModel, ...s.byModel];
  const primary = s.primary ? models.find((x) => x.modelRef === s.primary) : undefined;
  const lead = primary ?? s.today.byModel[0] ?? s.byModel[0];
  if (lead === undefined) return s.primary ? "api" : "none";
  return lead.subscription ? "subscription" : "api";
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

/**
 * The second line's text: "No usage today" rather than zeros; a subscription counts turns (and
 * tokens when the CLI reports them), never dollars.
 */
export function usageLine(s: UsageSummaryData, primarySubscription?: boolean): string {
  const lead = usageLead(s, primarySubscription);
  if (lead === "none" || s.today.turns === 0) return t("shell.usage.none");
  if (lead === "subscription")
    return s.today.tokens > 0
      ? t("shell.usage.subscriptionLine", {
          turns: s.today.turns,
          tokens: formatTokens(s.today.tokens),
        })
      : t("shell.usage.turnsOnly", { turns: s.today.turns });
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
  primarySubscription,
}: {
  summary: UsageSummaryData;
  /** The rail's 20 px form. */
  mini?: boolean;
  primarySubscription?: boolean;
}): ReactElement | null {
  const lead = usageLead(summary, primarySubscription);
  if (lead === "none") return null;
  if (lead === "subscription" && summary.planWindow)
    return <PlanRing fraction={summary.planWindow.usedFraction} />;
  const budget = lead === "api" ? budgetFraction(summary) : null;
  if (budget !== null) return <BudgetBar fraction={budget} width={mini ? 20 : 40} />;
  // A week with no usage draws nothing rather than a flat line.
  if (summary.days.every((d) => d.turns === 0)) return null;
  return <Sparkline values={series(summary, lead)} width={mini ? 20 : 40} testId="usage-sparkline" />;
}

/** A model reference as people read it: `anthropic/claude-sonnet-5-5` → `claude-sonnet-5-5`. */
function modelName(ref: string): string {
  return ref.split("/").slice(1).join("/") || ref;
}

/** The hover/focus card: the week by model, the month, the budget or plan window. */
export function UsageCard({
  summary,
  primarySubscription,
}: {
  summary: UsageSummaryData;
  primarySubscription?: boolean;
}): ReactElement {
  const lead = usageLead(summary, primarySubscription);
  const budget = budgetFraction(summary);
  const i18n = activeI18n();
  return (
    <div className="flex flex-col gap-2 text-callout" data-testid="usage-card">
      <p className="text-headline text-label-primary">{usageLine(summary, primarySubscription)}</p>
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
  /** The primary model is a subscription CLI's (from `models.list`); decides the variant. */
  primarySubscription?: boolean;
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
  primarySubscription,
  onOpenUsage,
}: UsageFooterProps): ReactElement {
  const line = usageLine(summary, primarySubscription);
  const kind = primarySubscription === undefined ? {} : { primarySubscription };
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
          <UsageGraphic summary={summary} mini {...kind} />
        ) : (
          <>
            <span className="flex min-w-0 items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-headline text-label-primary">
                {name}
              </span>
              <UsageGraphic summary={summary} {...kind} />
            </span>
            <span className="min-w-0 truncate text-callout text-label-tertiary">{line}</span>
          </>
        )}
      </HoverCardTrigger>
      <HoverCardContent side={rail ? "right" : "top"} align="start" className="w-72">
        <UsageCard summary={summary} {...kind} />
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
  const primarySubscription = usePrimarySubscription(summary?.primary);
  if (summary === undefined)
    return props.variant === "rail" ? null : (
      <span className="min-w-0 truncate text-headline">{props.name}</span>
    );
  return (
    <UsageFooter
      summary={summary}
      {...props}
      {...(primarySubscription === undefined ? {} : { primarySubscription })}
    />
  );
}

/** Whether the primary model's provider is a subscription CLI, from `models.list` (#606). */
export function usePrimarySubscription(primary: string | null | undefined): boolean | undefined {
  const models = useGatewayQuery("models.list", {}, { enabled: Boolean(primary) });
  const providers = models.data?.providers;
  return useMemo(
    () => isSubscriptionModel(primary, Array.isArray(providers) ? providers : undefined),
    [primary, providers],
  );
}
