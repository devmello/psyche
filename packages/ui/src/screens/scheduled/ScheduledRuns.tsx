import type { ScheduledRunEntry, ScheduledRunState } from "@psyche/protocol";
import { type ReactElement, useEffect, useState } from "react";
import { Button } from "../../components/ui/button.tsx";
import { useGatewayQuery } from "../../data/index.ts";
import { t } from "../../i18n/core.ts";
import { tk } from "../../i18n/dynamic.ts";
import { formatDuration, formatRelative } from "../../lib/format.ts";
import { absoluteWhen, itemName } from "./format.ts";

export const RUN_STATES: readonly ScheduledRunState[] = [
  "running",
  "waiting",
  "succeeded",
  "failed",
  "skipped",
  "cancelled",
];

/** How often the list is re-read while a run is in progress (events do the rest). */
const LIVE_REFRESH_MS = 10_000;

export interface ScheduledRunsViewProps {
  runs: readonly ScheduledRunEntry[];
  now: number;
  timezone: string;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  /** Filter by job (automation id) and by status; "" is all. */
  job: string;
  state: ScheduledRunState | "";
  onJobChange: (job: string) => void;
  onStateChange: (state: ScheduledRunState | "") => void;
  onOpenChat?: (threadId: string) => void;
  onOpenTranscript?: (agentRunId: string) => void;
  /** Opens the approvals queue, where a waiting run's card is. */
  onOpenApprovals?: () => void;
}

const stateClass = (s: ScheduledRunState): string =>
  s === "failed"
    ? "font-medium text-destructive"
    : s === "waiting"
      ? "font-medium text-accent-11"
      : "font-medium";

/** The name a run is listed under: a built-in routine's catalogue name, else the job's title. */
function jobName(r: ScheduledRunEntry): string {
  return itemName({ title: r.title, ...(r.routine === undefined ? {} : { routine: r.routine }) });
}

/** Every run, past and in progress, background ones included: status, when, how long, which job. */
export function ScheduledRunsView({
  runs,
  now,
  timezone,
  loading = false,
  error = null,
  onRetry,
  job,
  state,
  onJobChange,
  onStateChange,
  onOpenChat,
  onOpenTranscript,
  onOpenApprovals,
}: ScheduledRunsViewProps): ReactElement {
  // The jobs that have runs, for the filter.
  const jobs = [...new Map(runs.map((r) => [r.automationId, jobName(r)])).entries()].sort((a, b) =>
    a[1].localeCompare(b[1]),
  );
  const shown = runs.filter(
    (r) => (job === "" || r.automationId === job) && (state === "" || r.state === state),
  );
  return (
    <section aria-label={t("scheduled.runs.title")} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3 text-callout">
        <label className="flex items-center gap-2">
          <span className="text-label-secondary">{t("scheduled.runs.filter.job")}</span>
          <select
            className="rounded-md border border-separator bg-transparent px-2 py-1"
            value={job}
            onChange={(e) => onJobChange(e.target.value)}
          >
            <option value="">{t("scheduled.runs.filter.all")}</option>
            {jobs.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2">
          <span className="text-label-secondary">{t("scheduled.runs.filter.state")}</span>
          <select
            className="rounded-md border border-separator bg-transparent px-2 py-1"
            value={state}
            onChange={(e) => onStateChange(e.target.value as ScheduledRunState | "")}
          >
            <option value="">{t("scheduled.runs.filter.all")}</option>
            {RUN_STATES.map((s) => (
              <option key={s} value={s}>
                {tk(`scheduled.runs.state.${s}`)}
              </option>
            ))}
          </select>
        </label>
      </div>
      {error && runs.length === 0 ? (
        <p role="alert" className="text-callout text-destructive">
          {t("scheduled.runs.failed")} ({error}).{" "}
          {onRetry ? (
            <button type="button" className="underline" onClick={onRetry}>
              {t("scheduled.runs.retry")}
            </button>
          ) : null}
        </p>
      ) : loading && runs.length === 0 ? (
        <p className="text-callout text-label-secondary">{t("scheduled.runs.loading")}</p>
      ) : shown.length === 0 ? (
        <p className="text-callout text-label-secondary">
          {runs.length === 0 ? t("scheduled.runs.empty") : t("scheduled.runs.noMatch")}
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-separator">
          {shown.map((r) => {
            const when = absoluteWhen(r.startedAt, timezone);
            const took =
              r.durationMs == null
                ? t("scheduled.history.running")
                : t("scheduled.history.duration", { duration: formatDuration(r.durationMs) });
            const how = [
              r.trigger === "manual" ? t("scheduled.history.manual") : null,
              r.trigger === "event" ? t("scheduled.history.event") : null,
              r.group === "routine" ? t("scheduled.runs.routine") : null,
            ].filter((x): x is string => x !== null);
            return (
              <li key={r.id} className="flex flex-col gap-1 py-3">
                <div className="flex flex-wrap items-baseline gap-x-2 text-callout">
                  <span className="font-medium">{jobName(r)}</span>
                  <span className={stateClass(r.state)}>
                    {tk(`scheduled.runs.state.${r.state}`)}
                  </span>
                  <span className="text-label-secondary">
                    {formatRelative(r.startedAt, now)} · {when} · {took}
                    {how.length > 0 ? ` · ${how.join(" · ")}` : ""}
                  </span>
                </div>
                {r.state === "waiting" ? (
                  <div className="flex flex-wrap items-center gap-2 text-callout">
                    <span>{t("scheduled.runs.waiting", { n: r.pendingApprovals })}</span>
                    {onOpenApprovals ? (
                      <Button type="button" size="sm" onClick={onOpenApprovals}>
                        {t("scheduled.runs.openApprovals")}
                      </Button>
                    ) : null}
                  </div>
                ) : null}
                {r.reason && r.state !== "succeeded" ? (
                  <p
                    className={
                      r.state === "failed"
                        ? "text-callout text-destructive"
                        : "text-callout text-label-secondary"
                    }
                  >
                    {t(
                      r.state === "skipped"
                        ? "scheduled.runs.reason.skipped"
                        : "scheduled.runs.reason",
                      {
                        reason: r.reason,
                      },
                    )}
                  </p>
                ) : r.summary ? (
                  <p className="line-clamp-2 text-callout text-label-secondary">{r.summary}</p>
                ) : null}
                <div className="flex flex-wrap items-center gap-1">
                  {r.threadId != null && onOpenChat ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      aria-label={t("scheduled.history.openChat.aria", { when })}
                      onClick={() => onOpenChat(r.threadId as string)}
                    >
                      {t("scheduled.history.openChat")}
                    </Button>
                  ) : null}
                  {r.agentRunId != null && onOpenTranscript ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      aria-label={t("scheduled.history.openTranscript.aria", { when })}
                      onClick={() => onOpenTranscript(r.agentRunId as string)}
                    >
                      {t("scheduled.runs.openTimeline")}
                    </Button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** The Runs tab, wired to the Gateway (`scheduled.runs`), live while anything runs. */
export function ScheduledRuns({
  now,
  timezone,
  onNavigate,
}: {
  now: number;
  timezone: string;
  onNavigate?: (route: string) => void;
}): ReactElement {
  const q = useGatewayQuery("scheduled.runs", { limit: 200 });
  const [job, setJob] = useState("");
  const [state, setState] = useState<ScheduledRunState | "">("");
  const runs = q.data?.runs ?? [];
  const active = runs.some((r) => r.state === "running" || r.state === "waiting");
  const { reload } = q;
  useEffect(() => {
    if (!active) return;
    // Run events refresh the list; this catches what has no event (a task parking on an approval).
    const id = setInterval(reload, LIVE_REFRESH_MS);
    return () => clearInterval(id);
  }, [active, reload]);
  return (
    <ScheduledRunsView
      runs={runs}
      now={now}
      timezone={timezone}
      loading={q.loading}
      error={q.error}
      onRetry={q.reload}
      job={job}
      state={state}
      onJobChange={setJob}
      onStateChange={setState}
      {...(onNavigate
        ? {
            onOpenChat: (threadId: string) => onNavigate(`/chat/${threadId}`),
            onOpenTranscript: (runId: string) => onNavigate(`/overview/run/${runId}`),
            onOpenApprovals: () => onNavigate("/agent/approvals"),
          }
        : {})}
    />
  );
}
