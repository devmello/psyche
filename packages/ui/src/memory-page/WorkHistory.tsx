import type { WorkHistoryEntry } from "@psyche/protocol";
import { type ReactElement, useState } from "react";
import { Button } from "../components/ui/button.tsx";
import { useCall, useGatewayQuery } from "../data/hooks.ts";
import { t } from "../i18n/core.ts";
import { describeError } from "../i18n/errors.ts";
import { formatDate, formatRelative } from "../lib/format.ts";
import { workStatusLabel } from "./WorkRow.tsx";
import { WORK_STATUSES } from "./work.ts";

type Settled = "undone" | "changed_again" | "already_undone" | "removed";

/** What changed, as a short line: "Stopped at section 3", "Due Nov 6", "Marked done". */
export function historyText(entry: WorkHistoryEntry): string {
  const value = entry.value;
  switch (entry.attribute) {
    case "status":
      return t("work.history.status", {
        value: (WORK_STATUSES as readonly string[]).includes(value)
          ? workStatusLabel(value as (typeof WORK_STATUSES)[number])
          : value,
      });
    case "deadline":
      return t("work.history.deadline", {
        date: Number.isNaN(Date.parse(value)) ? value : formatDate(value),
      });
    case "stopped_at":
      return t("work.history.stoppedAt", { value });
    case "next_step":
      return t("work.history.nextStep", { value });
    case "progress":
      return t("work.history.progress", { value });
  }
}

function chipLabel(entry: WorkHistoryEntry): string | null {
  const chip = entry.chip;
  if (!chip) return null;
  const source = t(`work.source.${chip.source}`);
  const label = chip.label.trim();
  if (label === "") {
    // The origin already says "Mail"; the chip only adds a source the origin does not name.
    return entry.origin === "mail" ? null : source;
  }
  return label.toLowerCase() === source.toLowerCase()
    ? source
    : t("work.chip.label", { source, label });
}

export interface WorkHistoryProps {
  /** The item's name, for the Undo buttons and their results. */
  name: string;
  entries: readonly WorkHistoryEntry[];
  now: number;
  /** Calls `memory.work.undoUpdate`; absent, nothing offers Undo. */
  onUndo?: (entry: WorkHistoryEntry) => Promise<Settled>;
}

/**
 * The item's History (a compact list of recent changes to its status, progress, where you
 * stopped, next step and due date): when, where each change came from and its source chip.
 * Only a direct update from chat that is still in the undo window carries Undo (the same rules
 * as the chat note); every other line is corrected with Review or by marking it wrong.
 */
export function WorkHistory({ name, entries, now, onUndo }: WorkHistoryProps): ReactElement {
  const [settled, setSettled] = useState<Readonly<Record<string, Settled>>>({});
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const undo = async (entry: WorkHistoryEntry) => {
    if (!onUndo) return;
    setBusy((b) => new Set([...b, entry.factId]));
    try {
      const status = await onUndo(entry);
      setSettled((s) => ({ ...s, [entry.factId]: status }));
      setError(null);
    } catch (err) {
      // A read-only window gets the Gateway's refusal here; there is nothing else to do.
      setError(describeError(err));
    } finally {
      setBusy((b) => new Set([...b].filter((id) => id !== entry.factId)));
    }
  };

  if (entries.length === 0)
    return <p className="px-3 py-2 text-body text-label-secondary">{t("work.history.empty")}</p>;
  const after = (state: Settled): string =>
    state === "undone"
      ? t("chat.workNote.undone", { name })
      : state === "changed_again"
        ? t("chat.workNote.changedAgain", { name })
        : state === "already_undone"
          ? t("chat.workNote.alreadyUndone")
          : t("chat.workNote.removed");
  return (
    <>
      {entries.map((entry) => {
        const chip = chipLabel(entry);
        const state = settled[entry.factId];
        return (
          <div
            key={entry.factId}
            data-testid="history-row"
            className="relative flex min-h-9 items-start gap-3 px-3 py-2 before:absolute before:inset-x-3 before:top-0 before:h-px before:bg-separator first:before:hidden"
          >
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="text-body text-label-primary">
                {historyText(entry)}
                {entry.from == null ? null : (
                  <span className="text-label-tertiary">
                    {" "}
                    {t("work.history.was", { value: entry.from })}
                  </span>
                )}
              </span>
              <span className="flex flex-wrap items-center gap-x-1 text-callout text-label-secondary">
                <span data-testid="history-origin">{t(`work.history.origin.${entry.origin}`)}</span>
                {chip ? <span aria-hidden="true">·</span> : null}
                {chip ? <span data-testid="history-chip">{chip}</span> : null}
                <span aria-hidden="true">·</span>
                <span>{formatRelative(entry.at, now)}</span>
              </span>
              {state ? (
                <span role="status" className="text-callout text-label-secondary">
                  {after(state)}
                </span>
              ) : null}
            </div>
            {entry.undoable && onUndo && !state ? (
              <Button
                type="button"
                size="xs"
                variant="ghost"
                className="shrink-0"
                disabled={busy.has(entry.factId)}
                aria-label={t("work.history.undoOf", { what: historyText(entry) })}
                onClick={() => void undo(entry)}
              >
                {t("chat.workNote.undo")}
              </Button>
            ) : null}
          </div>
        );
      })}
      {error ? (
        <p className="px-3 pb-2 text-callout text-danger-text" role="alert">
          {error}
        </p>
      ) : null}
    </>
  );
}

/** The History of one work item from `memory.work.history`. */
export function ConnectedWorkHistory({
  entityId,
  name,
  now,
}: {
  entityId: string;
  name: string;
  now: number;
}): ReactElement {
  const call = useCall();
  const history = useGatewayQuery("memory.work.history", { entityId, limit: 20 });
  if (history.error && !history.data)
    return (
      <p className="px-3 py-2 text-body text-label-secondary">
        {t("work.history.failed", { reason: history.error })}
      </p>
    );
  return (
    <WorkHistory
      name={name}
      entries={history.data?.entries ?? []}
      now={now}
      onUndo={async (entry) => {
        // The row stays with the result beside it; the list is read again on the next visit.
        return (await call("memory.work.undoUpdate", { factId: entry.factId })).status;
      }}
    />
  );
}
