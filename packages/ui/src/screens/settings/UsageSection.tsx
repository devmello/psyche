import { type ReactElement, useId } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/ui/table.tsx";
import { useGatewayQuery } from "../../data/hooks.ts";
import type { UsageSummary } from "../../fixtures/index.ts";
import { activeI18n, t } from "../../i18n/core.ts";
import { formatTime } from "../../lib/format.ts";
import { cn } from "../../lib/utils.ts";
import type { UsageSummaryData } from "../../shell/UsageFooter.tsx";
import { useSlots } from "../../slots.tsx";
import { EmptyNotice, Group, LoadGate, type LoadProps, SectionFrame } from "./shared.tsx";

/** Usage (UI design §3.18; architecture §4.4): tokens, cost, breakdowns, percent-remaining meter. */

/** US dollars in the region format; amounts under 10 cents keep a third digit. */
export function usd(n: number): string {
  const digits = n < 0.1 && n > 0 ? 3 : 2;
  return activeI18n().number(n, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function tokens(n: number): string {
  const i18n = activeI18n();
  if (n >= 1_000_000)
    return t("settings.usage.millions", {
      n: i18n.number(n / 1_000_000, { minimumFractionDigits: 1, maximumFractionDigits: 1 }),
    });
  if (n >= 1000) return t("settings.usage.thousands", { n: i18n.number(Math.round(n / 1000)) });
  return i18n.number(n);
}

/** Percent of the monthly budget left, as a meter with its value in text. */
export function UsageMeter({
  percentRemaining,
  label = t("settings.usage.budgetRemaining"),
}: {
  percentRemaining: number;
  label?: string;
}): ReactElement {
  const id = useId();
  const pct = Math.max(0, Math.min(100, Math.round(percentRemaining)));
  const low = pct <= 15;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between text-sm">
        <span id={id} className="font-medium">
          {label}
        </span>
        <span className={cn("tabular-nums", low ? "text-danger-text" : "text-muted-foreground")}>
          {t("settings.usage.left", { pct })}
        </span>
      </div>
      <meter
        className="sr-only"
        aria-labelledby={id}
        min={0}
        max={100}
        low={16}
        optimum={100}
        value={pct}
      >
        {t("settings.usage.left", { pct })}
      </meter>
      <div aria-hidden="true" className="h-2 w-full overflow-hidden rounded-full bg-gray-4">
        <div
          className={cn("h-full rounded-full", low ? "bg-danger" : "bg-accent-9")}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

export interface UsagePanelProps extends LoadProps {
  usage: UsageSummary | null;
}

export function UsagePanel({ usage, loading, error, onRetry }: UsagePanelProps): ReactElement {
  const { navigate } = useSlots();
  return (
    <SectionFrame title={t("settings.usage.title")} description={t("settings.usage.description")}>
      <LoadGate
        label={t("settings.usage.loadLabel")}
        loading={loading ?? false}
        error={error ?? null}
        {...(onRetry ? { onRetry } : {})}
      >
        {usage === null || usage.records.length === 0 ? (
          <EmptyNotice text={t("settings.usage.empty")} />
        ) : (
          <>
            <Group
              title={t("settings.usage.period", {
                // Billing periods are calendar days (UTC midnight), not instants.
                start: activeI18n().date(usage.periodStart, {
                  month: "short",
                  day: "numeric",
                  timeZone: "UTC",
                }),
                end: activeI18n().date(usage.periodEnd, {
                  month: "short",
                  day: "numeric",
                  timeZone: "UTC",
                }),
              })}
              description={t("settings.usage.spent", {
                spent: usd(usage.spentUsd),
                budget: usd(usage.budgetUsd),
                today: usd(usage.todayUsd),
              })}
            >
              <UsageMeter percentRemaining={usage.percentRemaining} />
            </Group>
            <Group
              title={t("settings.usage.byThread")}
              description={t("settings.usage.byThreadHint")}
            >
              <Table aria-label={t("settings.usage.byThreadTable")}>
                <TableHeader>
                  <TableRow>
                    <TableHead scope="col">{t("settings.usage.thread")}</TableHead>
                    <TableHead scope="col" className="text-end">
                      {t("settings.usage.tokens")}
                    </TableHead>
                    <TableHead scope="col" className="text-end">
                      {t("settings.usage.cost")}
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {usage.byThread.map((row) => (
                    <TableRow key={row.threadId}>
                      <TableCell>
                        {navigate ? (
                          <button
                            type="button"
                            className="text-start underline-offset-2 hover:underline"
                            onClick={() => navigate(`/chat/${row.threadId}`)}
                          >
                            {row.title}
                          </button>
                        ) : (
                          row.title
                        )}
                      </TableCell>
                      <TableCell className="text-end tabular-nums">{tokens(row.tokens)}</TableCell>
                      <TableCell className="text-end tabular-nums">{usd(row.costUsd)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Group>
            <Group title={t("settings.usage.byAutomation")}>
              <Table aria-label={t("settings.usage.byAutomationTable")}>
                <TableHeader>
                  <TableRow>
                    <TableHead scope="col">{t("settings.usage.automation")}</TableHead>
                    <TableHead scope="col" className="text-end">
                      {t("settings.usage.runs")}
                    </TableHead>
                    <TableHead scope="col" className="text-end">
                      {t("settings.usage.cost")}
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {usage.byAutomation.map((a) => (
                    <TableRow key={a.automationId}>
                      <TableCell>{a.title}</TableCell>
                      <TableCell className="text-end tabular-nums">
                        {activeI18n().number(a.runs)}
                      </TableCell>
                      <TableCell className="text-end tabular-nums">{usd(a.costUsd)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Group>
            <Group title={t("settings.usage.recent")}>
              <ul className="flex flex-col gap-1">
                {usage.records.map((r) => (
                  <li key={r.id} className="flex flex-wrap items-baseline gap-x-3 text-callout">
                    <span className="min-w-12 whitespace-nowrap tabular-nums text-muted-foreground">
                      {formatTime(r.createdAt)}
                    </span>
                    <code className="font-mono">{r.modelRef}</code>
                    <span className="text-muted-foreground">
                      {r.job ?? t("settings.usage.chat")}
                    </span>
                    <span className="tabular-nums">
                      {t("settings.usage.inOut", {
                        input: tokens(r.input),
                        output: tokens(r.output),
                        cached: r.cacheRead > 0,
                        cache: tokens(r.cacheRead),
                      })}
                    </span>
                    <span className="ms-auto tabular-nums">{usd(r.costUsd)}</span>
                  </li>
                ))}
              </ul>
            </Group>
          </>
        )}
      </LoadGate>
    </SectionFrame>
  );
}

/**
 * Usage from the Gateway's `usage.summary` (#599): this month, today and the last 7 days by
 * model. Subscription CLIs have no per-token cost, so their rows show turns, and their plan's
 * window when the adapter reads it.
 */
export function UsageLivePanel({
  summary,
  loading = false,
  error = null,
  onRetry,
}: {
  summary: UsageSummaryData | undefined;
  loading?: boolean;
  /** Why `usage.summary` failed, in words. Shown with a retry instead of "not available". */
  error?: string | null;
  onRetry?: () => void;
}): ReactElement {
  const month = summary?.month;
  const budget = summary?.budgetUsd ?? null;
  return (
    <SectionFrame title={t("settings.usage.title")} description={t("settings.usage.description")}>
      <LoadGate
        label={t("settings.usage.loadLabel")}
        loading={loading && summary === undefined}
        error={summary === undefined ? error : null}
        {...(onRetry ? { onRetry } : {})}
      >
        {summary === undefined || month === undefined ? (
          <EmptyNotice text={t("settings.usage.unavailable")} />
        ) : (
          <>
            <Group
              title={t("settings.usage.thisMonth")}
              description={t("settings.usage.monthLine", {
                cost: usd(month.costUsd),
                tokens: tokens(month.tokens),
                turns: month.turns,
                today: usd(summary.today.costUsd),
              })}
            >
              {budget !== null && budget > 0 ? (
                <UsageMeter percentRemaining={100 - (month.costUsd / budget) * 100} />
              ) : (
                <p className="text-callout text-label-secondary">{t("settings.usage.noBudget")}</p>
              )}
            </Group>
            <Group title={t("settings.usage.byModel")}>
              {summary.byModel.length === 0 ? (
                <p className="text-callout text-label-secondary">{t("settings.usage.empty")}</p>
              ) : (
                <Table aria-label={t("settings.usage.byModel")}>
                  <TableHeader>
                    <TableRow>
                      <TableHead scope="col">{t("settings.usage.model")}</TableHead>
                      <TableHead scope="col" className="text-end">
                        {t("settings.usage.tokens")}
                      </TableHead>
                      <TableHead scope="col" className="text-end">
                        {t("settings.usage.cost")}
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {summary.byModel.map((m) => (
                      <TableRow key={m.modelRef}>
                        <TableCell className="font-mono text-callout">{m.modelRef}</TableCell>
                        <TableCell className="text-end tabular-nums">{tokens(m.tokens)}</TableCell>
                        <TableCell className="text-end tabular-nums">
                          {m.subscription
                            ? t("settings.usage.turns", { n: m.turns })
                            : usd(m.costUsd)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </Group>
            {summary.planWindow ? (
              <p className="px-1 text-callout text-label-secondary">
                {t("settings.usage.planWindow", {
                  model: summary.planWindow.modelRef,
                  pct: Math.round(summary.planWindow.usedFraction * 100),
                  when: formatTime(summary.planWindow.resetsAt),
                })}
              </p>
            ) : null}
          </>
        )}
      </LoadGate>
    </SectionFrame>
  );
}

function ConnectedUsage(): ReactElement {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const q = useGatewayQuery("usage.summary", { days: 7, timeZone });
  // An older Gateway refuses the method: say so instead of loading forever.
  const data = q.data as Partial<UsageSummaryData> | undefined;
  const summary =
    data && Array.isArray(data.byModel) && data.today && data.month
      ? (data as UsageSummaryData)
      : undefined;
  // A failed call says what failed (a rate limit, a refused scope, a timeout) and offers a retry;
  // "not available" is for an answer that arrived without a summary in it.
  return (
    <UsageLivePanel
      summary={summary}
      loading={q.loading && q.error === null}
      error={q.error}
      onRetry={q.reload}
    />
  );
}

export interface UsageSectionProps extends LoadProps {
  /** A summary to show instead of the Gateway's (stories, tests). */
  usage?: UsageSummary | null;
}

export function UsageSection({ usage, ...load }: UsageSectionProps): ReactElement {
  if (usage === undefined) return <ConnectedUsage />;
  return <UsagePanel usage={usage} {...load} />;
}
