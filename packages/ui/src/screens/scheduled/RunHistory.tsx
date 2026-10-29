import type { AuditChange, AutomationRun } from "@psyche/protocol";
import { type ReactElement, type ReactNode, useState } from "react";
import { Button } from "../../components/ui/button.tsx";
import { useChanges, useGatewayQuery } from "../../data/index.ts";
import { t } from "../../i18n/core.ts";
import { formatDuration, formatRelative } from "../../lib/format.ts";
import { absoluteWhen, statusLabel } from "./format.ts";

export interface RunHistoryViewProps {
  runs: readonly AutomationRun[];
  loading?: boolean;
  error?: string | null;
  now: number;
  timezone: string;
  onOpenChat?: (threadId: string) => void;
  onOpenTranscript?: (runId: string) => void;
  /** The audit records of one run (`audit.changes` by run id), below its row. */
  renderChanges?: (run: AutomationRun) => ReactNode;
}

/** Each past run: status, when, how long, a link to its chat or transcript, and its audit records. */
export function RunHistoryView({
  runs,
  loading = false,
  error = null,
  now,
  timezone,
  onOpenChat,
  onOpenTranscript,
  renderChanges,
}: RunHistoryViewProps): ReactElement {
  return (
    <section aria-label={t("scheduled.history.title")} className="flex flex-col gap-2">
      <h4 className="text-caption text-label-secondary">{t("scheduled.history.title")}</h4>
      {error ? (
        <p role="alert" className="text-callout text-destructive">
          {t("scheduled.history.failed")} ({error}).
        </p>
      ) : loading ? (
        <p className="text-callout text-label-secondary">{t("scheduled.history.loading")}</p>
      ) : runs.length === 0 ? (
        <p className="text-callout text-label-secondary">{t("scheduled.history.empty")}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-separator">
          {runs.map((run) => {
            const when = absoluteWhen(run.startedAt, timezone);
            const took =
              run.endedAt == null
                ? t("scheduled.history.running")
                : t("scheduled.history.duration", {
                    duration: formatDuration(Date.parse(run.endedAt) - Date.parse(run.startedAt)),
                  });
            const how = [
              run.trigger === "manual" ? t("scheduled.history.manual") : null,
              run.trigger === "event" ? t("scheduled.history.event") : null,
              run.coalesced > 1 ? t("scheduled.history.coalesced", { n: run.coalesced }) : null,
            ].filter((x): x is string => x !== null);
            return (
              <li key={run.id} className="flex flex-col gap-1 py-2">
                <div className="flex flex-wrap items-baseline gap-x-2 text-callout">
                  <span
                    className={
                      run.status === "failed" ? "font-medium text-destructive" : "font-medium"
                    }
                  >
                    {statusLabel(run.status)}
                  </span>
                  <span className="text-label-secondary">
                    {formatRelative(run.startedAt, now)} · {when} · {took}
                    {how.length > 0 ? ` · ${how.join(" · ")}` : ""}
                  </span>
                </div>
                {run.summary ? (
                  <p className="line-clamp-2 text-callout text-label-secondary">{run.summary}</p>
                ) : null}
                <div className="flex flex-wrap items-center gap-1">
                  {run.threadId != null && onOpenChat ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      aria-label={t("scheduled.history.openChat.aria", { when })}
                      onClick={() => onOpenChat(run.threadId as string)}
                    >
                      {t("scheduled.history.openChat")}
                    </Button>
                  ) : null}
                  {run.runId != null && onOpenTranscript ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      aria-label={t("scheduled.history.openTranscript.aria", { when })}
                      onClick={() => onOpenTranscript(run.runId as string)}
                    >
                      {t("scheduled.history.openTranscript")}
                    </Button>
                  ) : null}
                </div>
                {renderChanges?.(run)}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export interface RunChangesViewProps {
  changes: readonly AuditChange[];
  loading?: boolean;
}

/** The audit records of a run (#985): what it changed, and whether it went through. */
export function RunChangesView({ changes, loading = false }: RunChangesViewProps): ReactElement {
  if (loading) {
    return <p className="text-callout text-label-secondary">{t("scheduled.history.loading")}</p>;
  }
  if (changes.length === 0) {
    return <p className="text-callout text-label-secondary">{t("scheduled.history.noChanges")}</p>;
  }
  return (
    <ul className="flex flex-col gap-0.5 ps-3 text-callout text-label-secondary">
      {changes.map((c) => (
        <li key={c.seq}>
          {t(c.outcome === "ok" ? "scheduled.history.change" : "scheduled.history.change.failed", {
            action: c.action,
            target: c.target.path ?? c.target.object ?? c.target.connector ?? c.tool,
          })}
        </li>
      ))}
    </ul>
  );
}

/** One run's audit records, fetched when the owner opens them. */
function RunChanges({ run }: { run: AutomationRun }): ReactElement | null {
  const [open, setOpen] = useState(false);
  const runId = run.runId ?? "";
  const q = useChanges({ runId }, { enabled: open && runId !== "" });
  if (runId === "") return null;
  return (
    <div className="flex flex-col gap-1">
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="self-start"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {open && !q.loading
          ? t("scheduled.history.changes", { n: q.changes.length })
          : t("scheduled.history.showChanges")}
      </Button>
      {open ? <RunChangesView changes={q.changes} loading={q.loading} /> : null}
    </div>
  );
}

export interface RunHistoryProps {
  automationId: string;
  now: number;
  timezone: string;
  onNavigate?: (route: string) => void;
}

/** The run history of one automation, wired to the Gateway (`automations.runs`). */
export function RunHistory({
  automationId,
  now,
  timezone,
  onNavigate,
}: RunHistoryProps): ReactElement {
  const q = useGatewayQuery("automations.runs", { automationId, limit: 20 });
  return (
    <RunHistoryView
      runs={q.data?.runs ?? []}
      loading={q.loading && q.data === undefined}
      error={q.error}
      now={now}
      timezone={timezone}
      {...(onNavigate
        ? {
            onOpenChat: (threadId: string) => onNavigate(`/chat/${threadId}`),
            onOpenTranscript: (runId: string) => onNavigate(`/overview/run/${runId}`),
          }
        : {})}
      renderChanges={(run) => <RunChanges run={run} />}
    />
  );
}
