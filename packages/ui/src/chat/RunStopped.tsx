import type { Message, Run } from "@psyche/protocol";
import type { ReactElement } from "react";
import { t } from "../i18n/core.ts";
import { messageText } from "./MessageView.tsx";
import { failureAnchors } from "./RunFailure.tsx";
import { useHasTrace } from "./steps/RunTrace.tsx";

export interface StoppedTurn {
  run: Run;
  /** The owner's message that started the turn, when Retry may resend it; else null. */
  retryText: string | null;
}

/**
 * Which message each stopped run's "Stopped" line follows (same anchoring as a failure), and
 * the text Retry resends. Only the newest turn can be retried: when a later owner message
 * exists, the owner has already moved on.
 */
export function stoppedAnchors(
  messages: readonly Message[],
  runs: readonly Run[],
): Map<string, StoppedTurn[]> {
  const out = new Map<string, StoppedTurn[]>();
  const lastUser = messages.findLast((m) => m.role === "user");
  for (const [anchorId, found] of failureAnchors(messages, runs, "cancelled")) {
    const at = messages.findIndex((m) => m.id === anchorId);
    const starter = messages.slice(0, at + 1).findLast((m) => m.role === "user");
    out.set(
      anchorId,
      found.map((run) => ({
        run,
        retryText:
          starter !== undefined && starter.id === lastUser?.id && starter.via !== "widget"
            ? messageText(starter) || null
            : null,
      })),
    );
  }
  return out;
}

/**
 * A turn the owner stopped, said under it: a quiet "Stopped" and one plain Retry that sends the
 * same message again in this chat. A run with its own trace already says "Stopped by you" in
 * its summary row, so the line is not repeated then.
 */
export function RunStopped({
  run,
  retryText,
  busy,
  onRetry,
}: {
  run: Run;
  retryText: string | null;
  busy: boolean;
  onRetry: (text: string) => void;
}): ReactElement | null {
  const traced = useHasTrace(run.id);
  const canRetry = retryText !== null && !busy;
  if (traced && !canRetry) return null;
  return (
    <div
      className="mt-2 ms-7 flex items-center gap-2 text-callout text-label-secondary"
      data-testid="run-stopped"
    >
      {traced ? null : <span>{t("chat.stopped.label")}</span>}
      {canRetry ? (
        <button
          type="button"
          onClick={() => onRetry(retryText)}
          className="h-6 cursor-default rounded-sm px-1.5 text-accent-11 outline-none transition-colors duration-(--duration-micro) ease-(--ease-standard) hover:bg-fill-tertiary focus-visible:ring-2 focus-visible:ring-ring"
        >
          {t("chat.thread.retrySend")}
        </button>
      ) : null}
    </div>
  );
}
