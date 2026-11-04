import type { WorkNoteItem } from "@psyche/protocol";
import { type ReactElement, useState } from "react";
import { Button } from "../components/ui/button.tsx";
import { useCall } from "../data/index.ts";
import { t } from "../i18n/core.ts";
import { describeError, errorCode } from "../i18n/errors.ts";
import { formatDate } from "../lib/format.ts";

type Settled =
  | "confirmed"
  | "discarded"
  | "settled"
  | "undone"
  | "changed_again"
  | "already_undone";

/** What the note says changed: "Thesis draft is done", "Thesis draft, Due Nov 6", "stopped at …". */
function describe(item: WorkNoteItem): string {
  if (item.attribute === "status") {
    const label =
      item.value === "submitted"
        ? t("work.status.submitted")
        : item.value === "done"
          ? t("work.status.done")
          : item.value === "dropped"
            ? t("work.status.dropped")
            : item.value;
    return t("chat.workNote.statusChange", { name: item.name, status: label });
  }
  if (item.attribute === "deadline") {
    return t("chat.workNote.deadlineChange", {
      name: item.name,
      due: t("work.due.date", { date: formatDate(item.value) }),
    });
  }
  if (item.attribute === "stopped_at") return t("chat.workNote.stoppedAt", { value: item.value });
  if (item.attribute === "next_step") return t("chat.workNote.nextStep", { value: item.value });
  return item.value;
}

/**
 * The quiet note under a chat turn that touched the owner's work (MW7). A proposal (a status or a
 * deadline the owner said) is still only a pending fact in Review: Confirm and Discard here call
 * the same `memory.review.decide` Review does, and ignoring the note leaves it there. An update
 * (progress, stopped at, next step) was written at once: Undo calls `memory.work.undoUpdate`,
 * which refuses when the field has changed again. Only the owner's connection may write; a
 * read-only window gets the Gateway's refusal.
 */
export function WorkNote({ items }: { items: readonly WorkNoteItem[] }): ReactElement {
  const call = useCall();
  const [settled, setSettled] = useState<Readonly<Record<string, Settled>>>({});
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const run = async (item: WorkNoteItem, action: () => Promise<Settled>) => {
    setBusy((b) => new Set([...b, item.factId]));
    try {
      const next = await action();
      setSettled((s) => ({ ...s, [item.factId]: next }));
      setError(null);
    } catch (err) {
      // Already decided in Review (or on another window): say so, nothing else to do.
      if (item.kind === "proposal" && errorCode(err) === "conflict") {
        setSettled((s) => ({ ...s, [item.factId]: "settled" }));
      } else setError(describeError(err));
    } finally {
      setBusy((b) => new Set([...b].filter((id) => id !== item.factId)));
    }
  };
  const decide = (item: WorkNoteItem, decision: "confirm" | "discard") =>
    run(item, async () => {
      await call("memory.review.decide", { factIds: [item.factId], decision });
      return decision === "confirm" ? "confirmed" : "discarded";
    });
  const undo = (item: WorkNoteItem) =>
    run(item, async () => (await call("memory.work.undoUpdate", { factId: item.factId })).status);

  const after = (item: WorkNoteItem, state: Settled): string => {
    switch (state) {
      case "confirmed":
        return t("chat.workNote.confirmed", { name: item.name });
      case "discarded":
        return t("chat.workNote.discarded");
      case "settled":
        return t("chat.workNote.settled");
      case "undone":
        return t("chat.workNote.undone", { name: item.name });
      case "changed_again":
        return t("chat.workNote.changedAgain", { name: item.name });
      case "already_undone":
        return t("chat.workNote.alreadyUndone");
    }
  };

  return (
    <ul
      className="my-1 flex flex-col gap-0.5 text-callout text-label-secondary"
      data-testid="work-note"
    >
      {items.map((item) => {
        const state = settled[item.factId];
        if (state !== undefined) {
          return (
            <li key={item.factId} role="status">
              {after(item, state)}
            </li>
          );
        }
        const disabled = busy.has(item.factId);
        return (
          <li key={item.factId} className="flex flex-wrap items-baseline gap-x-2">
            <span>
              <span className="text-label-tertiary">
                {item.kind === "proposal"
                  ? t("chat.workNote.noticed")
                  : t("chat.workNote.updated", { name: item.name })}
              </span>{" "}
              <em className="text-label-primary">{describe(item)}</em>
            </span>
            {item.kind === "proposal" ? (
              <>
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={disabled}
                  aria-label={t("chat.workNote.confirmOf", { name: item.name })}
                  onClick={() => void decide(item, "confirm")}
                >
                  {t("chat.workNote.confirm")}
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={disabled}
                  aria-label={t("chat.workNote.discardOf", { name: item.name })}
                  onClick={() => void decide(item, "discard")}
                >
                  {t("chat.workNote.discard")}
                </Button>
              </>
            ) : (
              <Button
                size="xs"
                variant="ghost"
                disabled={disabled}
                aria-label={t("chat.workNote.undoOf", { name: item.name })}
                onClick={() => void undo(item)}
              >
                {t("chat.workNote.undo")}
              </Button>
            )}
          </li>
        );
      })}
      {error ? (
        <li className="text-danger-text" role="alert">
          {error}
        </li>
      ) : null}
    </ul>
  );
}
