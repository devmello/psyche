import type { AutomationRun, Run, RunStep, Thread } from "@psyche/protocol";
import { ChevronRight } from "lucide-react";
import { type ReactElement, type ReactNode, useEffect, useMemo, useState } from "react";
import { DisclosureProvider } from "../blocks/disclosure.tsx";
import { Markdown } from "../blocks/Markdown.tsx";
import { Button } from "../components/ui/button.tsx";
import { useGatewayQuery, useRun, useStore, useStoreState } from "../data/index.ts";
import { t } from "../i18n/core.ts";
import { formatDuration, formatRelative } from "../lib/format.ts";
import { useNow } from "../lib/use-now.ts";
import { cn } from "../lib/utils.ts";
import { absoluteWhen, statusLabel } from "../screens/scheduled/format.ts";
import { useSlots } from "../slots.tsx";
import { timelineRoute } from "./steps/model.ts";
import { StepList } from "./steps/StepList.tsx";

/**
 * An automation's one chat (`kind: automation`): every run is a block, newest first, folded to
 * one line (time, status, how long, what it came to). Opening a block shows the run's own steps,
 * the same rows the chat and the Timeline show: what the model wrote, each tool call with its
 * input and result, approvals and errors. Nothing is typed here; the work happens on a schedule.
 */

/** The automation a thread belongs to: its one chat, or one of the hidden threads a run works in. */
export function automationOfThread(
  thread: Pick<Thread, "kind" | "sessionKey"> | null | undefined,
): { automationId: string; runThread: boolean } | null {
  if (thread?.kind !== "automation") return null;
  const key = thread.sessionKey;
  if (key.startsWith("automation:")) {
    return { automationId: key.slice("automation:".length), runThread: false };
  }
  if (key.startsWith("cron:")) {
    const id = key.slice("cron:".length).split(":")[0] ?? "";
    return id === "" ? null : { automationId: id, runThread: true };
  }
  return null;
}

export type RunTone = "running" | "needs-you" | "failed" | "done";

/** How a run reads: amber when it waits for the owner, a red dot when it failed, else quiet. */
export function runTone(status: AutomationRun["status"], live?: Run["status"]): RunTone {
  if (status === "running") {
    return live === "awaiting_approval" || live === "awaiting_input" ? "needs-you" : "running";
  }
  return status === "failed" ? "failed" : "done";
}

const DOT: Record<RunTone, string> = {
  running: "bg-accent-9",
  "needs-you": "bg-approval",
  failed: "bg-danger",
  done: "bg-label-tertiary",
};

/** A status chip: a dot and words, never a coloured pill. */
export function RunStatusChip({
  status,
  live,
}: {
  status: AutomationRun["status"];
  live?: Run["status"] | undefined;
}): ReactElement {
  const tone = runTone(status, live);
  const words =
    tone === "needs-you"
      ? t("automationChat.status.needsYou")
      : tone === "running"
        ? t("automationChat.status.running")
        : statusLabel(status);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5",
        tone === "needs-you" && "text-approval-text",
        tone === "failed" && "text-danger-text",
      )}
      data-testid="run-status"
      data-tone={tone}
    >
      <span aria-hidden="true" className={cn("size-2 shrink-0 rounded-full", DOT[tone])} />
      {words}
    </span>
  );
}

/** The first line of a run's result, as plain text. */
export function resultLine(summary: string | null | undefined): string {
  if (summary == null) return "";
  const line = summary
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[`*_~>#|]/g, "")
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l !== "");
  return line ?? "";
}

export interface AutomationRunBlockProps {
  run: AutomationRun;
  now: number;
  timezone: string;
  open: boolean;
  onToggle: () => void;
  /** The run's agent status, when it is still going (a parked approval reads "Needs you"). */
  live?: Run["status"] | undefined;
  /** The opened body: the run's steps and result. */
  children?: ReactNode;
}

/** One run, folded to a line; the header is the button that opens it. */
export function AutomationRunBlock({
  run,
  now,
  timezone,
  open,
  onToggle,
  live,
  children,
}: AutomationRunBlockProps): ReactElement {
  const when = absoluteWhen(run.startedAt, timezone);
  const took =
    run.endedAt == null
      ? null
      : formatDuration(Math.max(0, Date.parse(run.endedAt) - Date.parse(run.startedAt)));
  const how = [
    run.trigger === "manual" ? t("automationChat.trigger.manual") : null,
    run.trigger === "event" ? t("automationChat.trigger.event") : null,
    run.coalesced > 1 ? t("automationChat.coalesced", { n: run.coalesced }) : null,
  ].filter((x): x is string => x !== null);
  const line = resultLine(run.summary);
  const panelId = `run-${run.id}`;
  return (
    <li
      className="border-b border-separator last:border-b-0"
      data-testid="automation-run"
      data-run-id={run.id}
      data-open={open ? "true" : "false"}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={panelId}
        className="flex w-full min-w-0 cursor-default flex-col gap-0.5 rounded-sm px-2 py-2 text-start outline-none hover:bg-fill-quaternary focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 text-body">
          <ChevronRight
            aria-hidden="true"
            className={cn(
              "size-3.5 shrink-0 text-label-tertiary transition-transform duration-(--spring-snappy-duration) ease-(--spring-snappy)",
              open ? "rotate-90" : "rtl:rotate-180",
            )}
          />
          <span className="font-medium text-label-primary" title={when}>
            {formatRelative(run.startedAt, now)}
          </span>
          <RunStatusChip status={run.status} live={live} />
          <span className="text-callout text-label-tertiary">
            {[...(took === null ? [] : [took]), ...how].join(" · ")}
          </span>
        </span>
        <span
          className={cn(
            "ps-5.5 truncate text-callout",
            line === "" ? "text-label-tertiary" : "text-label-secondary",
          )}
        >
          {line === "" && run.status !== "running" ? t("automationChat.noResult") : line}
        </span>
      </button>
      {open ? (
        <div id={panelId} className="flex flex-col gap-3 pb-3 ps-7 pe-2">
          {children}
        </div>
      ) : null}
    </li>
  );
}

export interface AutomationChatViewProps {
  title: string;
  runs: readonly AutomationRun[];
  loading?: boolean;
  error?: string | null;
  now: number;
  timezone: string;
  /** The run a link names (an approval, an old bookmark): it opens, with any run still going. */
  focusRunId?: string | undefined;
  hasMore?: boolean;
  onMore?: () => void;
  onRunNow?: () => void;
  onOpenScheduled?: () => void;
  /** The opened body of a run (its steps and result). */
  renderRun: (run: AutomationRun) => ReactNode;
  /** A run's agent status while it works, for the "Needs you" reading. */
  liveOf?: (run: AutomationRun) => Run["status"] | undefined;
}

/** The chat as a list of runs, newest first. */
export function AutomationChatView({
  title,
  runs,
  loading = false,
  error = null,
  now,
  timezone,
  focusRunId,
  hasMore = false,
  onMore,
  onRunNow,
  onOpenScheduled,
  renderRun,
  liveOf,
}: AutomationChatViewProps): ReactElement {
  const opens = (r: AutomationRun) => r.status === "running" || r.id === focusRunId;
  const [open, setOpen] = useState<ReadonlySet<string>>(
    () => new Set(runs.filter(opens).map((r) => r.id)),
  );
  // A run that arrives while the chat is open opens itself if it is going or named; one the
  // owner folded stays folded.
  const [seen, setSeen] = useState<ReadonlySet<string>>(() => new Set(runs.map((r) => r.id)));
  // biome-ignore lint/correctness/useExhaustiveDependencies: `opens` only reads focusRunId
  useEffect(() => {
    const fresh = runs.filter((r) => !seen.has(r.id));
    if (fresh.length === 0) return;
    setSeen((s) => new Set([...s, ...fresh.map((r) => r.id)]));
    setOpen((o) => new Set([...o, ...fresh.filter(opens).map((r) => r.id)]));
  }, [runs, seen, focusRunId]);
  const toggle = (id: string) =>
    setOpen((o) => {
      const next = new Set(o);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  // A run nobody watched has only its record: tool inputs and results are shown in the rows.
  return (
    <DisclosureProvider level={2} keyboard={false}>
      <section
        aria-label={t("automationChat.label", { title })}
        className="flex min-h-0 min-w-0 flex-1 flex-col"
        data-testid="automation-chat"
      >
        <header className="border-b border-separator px-4 py-2">
          <div className="mx-auto flex max-w-3xl flex-wrap items-center gap-x-3 gap-y-1">
            <h2 className="min-w-0 flex-1 truncate text-headline text-label-primary">{title}</h2>
            <span className="text-callout text-label-secondary">
              {t("automationChat.runs", { n: runs.length })}
              {hasMore ? "+" : ""}
            </span>
            {onOpenScheduled ? (
              <Button type="button" size="sm" variant="ghost" onClick={onOpenScheduled}>
                {t("automationChat.openScheduled")}
              </Button>
            ) : null}
            {onRunNow ? (
              <Button type="button" size="sm" variant="outline" onClick={onRunNow}>
                {t("automationChat.runNow")}
              </Button>
            ) : null}
          </div>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
          {error && runs.length === 0 ? (
            <p role="alert" className="px-2 text-callout text-danger-text">
              {t("automationChat.failed")} ({error}).
            </p>
          ) : loading && runs.length === 0 ? (
            <p className="px-2 text-callout text-label-secondary">{t("automationChat.loading")}</p>
          ) : runs.length === 0 ? (
            <p className="px-2 text-callout text-label-secondary">{t("automationChat.empty")}</p>
          ) : (
            <ul className="mx-auto flex max-w-3xl flex-col">
              {runs.map((run) => (
                <AutomationRunBlock
                  key={run.id}
                  run={run}
                  now={now}
                  timezone={timezone}
                  open={open.has(run.id)}
                  onToggle={() => toggle(run.id)}
                  live={liveOf?.(run)}
                >
                  {renderRun(run)}
                </AutomationRunBlock>
              ))}
            </ul>
          )}
          {hasMore && onMore ? (
            <div className="mx-auto flex max-w-3xl px-2 pt-2">
              <Button type="button" size="sm" variant="ghost" onClick={onMore}>
                {t("automationChat.more")}
              </Button>
            </div>
          ) : null}
        </div>
      </section>
    </DisclosureProvider>
  );
}

/** What an opened run holds: its steps (the chat's rows), then what it came to. */
export function AutomationRunBody({
  run,
  steps,
  loading = false,
  now,
  onOpenTimeline,
  onOpenApprovals,
}: {
  run: AutomationRun;
  steps: readonly RunStep[];
  loading?: boolean;
  now?: number | undefined;
  onOpenTimeline?: (() => void) | undefined;
  onOpenApprovals?: (() => void) | undefined;
}): ReactElement {
  const top = useMemo(() => steps.filter((s) => s.parentStepId === undefined), [steps]);
  const waiting = top.some((s) => s.status === "waiting");
  return (
    <>
      {waiting ? (
        <div className="flex flex-wrap items-center gap-2 text-callout text-approval-text">
          <span>{t("automationChat.waiting")}</span>
          {onOpenApprovals ? (
            <Button type="button" size="sm" variant="outline" onClick={onOpenApprovals}>
              {t("automationChat.approvals")}
            </Button>
          ) : null}
        </div>
      ) : null}
      {top.length > 0 ? (
        <StepList
          runId={run.runId ?? run.id}
          steps={top}
          now={now}
          folding={false}
          label={t("chat.steps.label")}
        />
      ) : (
        <p className="text-callout text-label-secondary">
          {loading ? t("automationChat.stepsLoading") : t("automationChat.noSteps")}
        </p>
      )}
      {run.summary ? (
        <div className="flex flex-col gap-1" data-testid="run-result">
          <h3 className="text-caption text-label-secondary">{t("automationChat.result")}</h3>
          <Markdown className="text-body">{run.summary}</Markdown>
        </div>
      ) : null}
      {onOpenTimeline && run.runId != null ? (
        <div>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="-ms-2"
            onClick={onOpenTimeline}
          >
            {t("automationChat.timeline")} <span aria-hidden="true">›</span>
          </Button>
        </div>
      ) : null}
    </>
  );
}

function WiredRunBody({
  run,
  now,
  fixedNow,
  onNavigate,
}: {
  run: AutomationRun;
  now: number;
  fixedNow?: number | undefined;
  onNavigate?: ((route: string) => void) | undefined;
}): ReactElement {
  const { steps, loading } = useRun(run.runId ?? null);
  return (
    <AutomationRunBody
      run={run}
      steps={steps}
      loading={loading}
      now={fixedNow ?? (run.status === "running" ? undefined : now)}
      onOpenTimeline={
        run.runId != null && onNavigate
          ? () => onNavigate(timelineRoute(run.runId as string))
          : undefined
      }
      onOpenApprovals={onNavigate ? () => onNavigate("/agent/approvals") : undefined}
    />
  );
}

const PAGE = 20;

/** The chat, wired to the Gateway: `automations.runs` for the list, the run trace for each body. */
export function AutomationChat({
  automationId,
  title,
  focusThreadId,
  timezone = Intl.DateTimeFormat().resolvedOptions().timeZone,
  now: fixedNow,
}: {
  automationId: string;
  title: string;
  /** A run's own thread (an approval or an old link points at it): that run starts opened. */
  focusThreadId?: string | undefined;
  timezone?: string;
  now?: number;
}): ReactElement {
  const { navigate } = useSlots();
  const store = useStore();
  const now = useNow(30_000, fixedNow);
  const [limit, setLimit] = useState(PAGE);
  const q = useGatewayQuery("automations.runs", { automationId, limit });
  const runs = q.data?.runs ?? [];
  // The agent's own status of a run still going, so a parked approval reads "Needs you".
  const agentRuns = useStoreState((st) => st.runs);
  const focusRunId = focusThreadId ? runs.find((r) => r.threadId === focusThreadId)?.id : undefined;
  if (q.data === undefined && q.loading) {
    return (
      <AutomationChatView
        title={title}
        runs={[]}
        loading
        now={now}
        timezone={timezone}
        renderRun={() => null}
      />
    );
  }
  return (
    <AutomationChatView
      title={title}
      runs={runs}
      loading={q.loading}
      error={q.error}
      now={now}
      timezone={timezone}
      focusRunId={focusRunId}
      hasMore={q.data?.nextCursor != null}
      onMore={() => setLimit((l) => l + PAGE)}
      onRunNow={() => void store.call("automations.run", { automationId })}
      {...(navigate ? { onOpenScheduled: () => navigate("/scheduled") } : {})}
      liveOf={(r) => (r.runId == null ? undefined : agentRuns[r.runId]?.status)}
      renderRun={(run) => (
        <WiredRunBody run={run} now={now} fixedNow={fixedNow} onNavigate={navigate} />
      )}
    />
  );
}
