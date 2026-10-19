import { type ReactElement, useId } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/ui/table.tsx";
import type { UsageSummary } from "../../fixtures/index.ts";
import { formatDate, formatTime } from "../../lib/format.ts";
import { cn } from "../../lib/utils.ts";
import { useSlots } from "../../slots.tsx";
import { EmptyNotice, Group, LoadGate, type LoadProps, SectionFrame } from "./shared.tsx";

/** Usage (UI design §3.18; architecture §4.4): tokens, cost, breakdowns, percent-remaining meter. */

export function usd(n: number): string {
  return n < 0.1 && n > 0 ? `$${n.toFixed(3)}` : `$${n.toFixed(2)}`;
}

export function tokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

/** Percent of the monthly budget left, as a meter with its value in text. */
export function UsageMeter({
  percentRemaining,
  label = "Budget remaining",
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
          {pct}% left
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
        {pct}% left
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
    <SectionFrame
      title="Usage"
      description="Tokens and cost from your providers, counted on this machine."
    >
      <LoadGate
        label="usage"
        loading={loading ?? false}
        error={error ?? null}
        {...(onRetry ? { onRetry } : {})}
      >
        {usage === null || usage.records.length === 0 ? (
          <EmptyNotice text="No usage yet this month. It appears here after the first reply." />
        ) : (
          <>
            <Group
              title={`${formatDate(usage.periodStart)} – ${formatDate(usage.periodEnd)}`}
              description={`${usd(usage.spentUsd)} of ${usd(usage.budgetUsd)} spent · ${usd(usage.todayUsd)} today`}
            >
              <UsageMeter percentRemaining={usage.percentRemaining} />
            </Group>
            <Group title="By thread">
              <Table aria-label="Usage by thread">
                <TableHeader>
                  <TableRow>
                    <TableHead scope="col">Thread</TableHead>
                    <TableHead scope="col" className="text-right">
                      Tokens
                    </TableHead>
                    <TableHead scope="col" className="text-right">
                      Cost
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {usage.byThread.map((t) => (
                    <TableRow key={t.threadId}>
                      <TableCell>
                        {navigate ? (
                          <button
                            type="button"
                            className="text-left underline-offset-2 hover:underline"
                            onClick={() => navigate(`/chat/${t.threadId}`)}
                          >
                            {t.title}
                          </button>
                        ) : (
                          t.title
                        )}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{tokens(t.tokens)}</TableCell>
                      <TableCell className="text-right tabular-nums">{usd(t.costUsd)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Group>
            <Group title="By automation">
              <Table aria-label="Usage by automation">
                <TableHeader>
                  <TableRow>
                    <TableHead scope="col">Automation</TableHead>
                    <TableHead scope="col" className="text-right">
                      Runs
                    </TableHead>
                    <TableHead scope="col" className="text-right">
                      Cost
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {usage.byAutomation.map((a) => (
                    <TableRow key={a.automationId}>
                      <TableCell>{a.title}</TableCell>
                      <TableCell className="text-right tabular-nums">{a.runs}</TableCell>
                      <TableCell className="text-right tabular-nums">{usd(a.costUsd)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Group>
            <Group title="Recent calls">
              <ul className="flex flex-col gap-1">
                {usage.records.map((r) => (
                  <li key={r.id} className="flex flex-wrap items-baseline gap-x-3 text-xs">
                    <span className="w-12 tabular-nums text-muted-foreground">
                      {formatTime(r.createdAt)}
                    </span>
                    <code className="font-mono">{r.modelRef}</code>
                    <span className="text-muted-foreground">{r.job ?? "chat"}</span>
                    <span className="tabular-nums">
                      {tokens(r.input)} in · {tokens(r.output)} out
                      {r.cacheRead > 0 ? ` · ${tokens(r.cacheRead)} cached` : ""}
                    </span>
                    <span className="ml-auto tabular-nums">{usd(r.costUsd)}</span>
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

export interface UsageSectionProps extends LoadProps {
  /** The protocol has no usage summary method yet; the shell passes it in. */
  usage?: UsageSummary | null;
}

export function UsageSection({ usage = null, ...load }: UsageSectionProps): ReactElement {
  return <UsagePanel usage={usage} {...load} />;
}
