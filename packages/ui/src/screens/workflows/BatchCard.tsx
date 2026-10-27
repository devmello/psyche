import type { ActionProposal, ApprovalRequest, GrantScope } from "@psyche/protocol";
import { ChevronDown, LoaderCircle, Undo2 } from "lucide-react";
import { type ReactElement, useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { ApprovalCard } from "../../blocks/ApprovalCard.tsx";
import { StatusGlyph } from "../../components/status.tsx";
import { Button } from "../../components/ui/button.tsx";
import { useApproval } from "../../data/hooks.ts";
import { useProposal } from "../../data/proposals.ts";
import { t } from "../../i18n/core.ts";
import { describeError } from "../../i18n/errors.ts";
import { toolFamily } from "../../lib/format.ts";
import { useNow } from "../../lib/use-now.ts";
import { cn } from "../../lib/utils.ts";
import { offsetLabel } from "./MeetingNotesCard.tsx";

/** How long Undo stays on the receipt row (§7.2; the Gateway's `UNDO_WINDOW_MS`). */
export const UNDO_WINDOW_MS = 30_000;

/** The mail tools whose batches can be undone by an inverse batch (mark read, move, flag). */
const REVERSIBLE = /^(mail_(mark_(un)?read|move|(un)?flag)|gmail_modify)$/;

export function isReversible(proposal: ActionProposal): boolean {
  return proposal.calls.every((c) => REVERSIBLE.test(c.tool));
}

export interface BatchCardProps {
  proposal: ActionProposal;
  /** The `batch` approval once requested; null while it is being issued. */
  approval: ApprovalRequest | null;
  /** This surface holds the approval's answer token. */
  canAnswer: boolean;
  /**
   * Answers the approval: once, or the one scope the batch offers ("always", only for prep notes,
   * security §3.4).
   */
  onAnswer?: (decision: "approve" | "deny", scope?: GrantScope) => unknown;
  onUndo?: () => void;
  /** Re-runs the calls that failed (absent until the Gateway offers it). */
  onRetryFailed?: () => void;
  now?: number;
  armDelayMs?: number;
  /** The step log opens expanded (stories). */
  defaultExpanded?: boolean;
  className?: string;
}

/**
 * The inline batch card (docs/workflows/mail-and-meetings-2026.md §7.2): while it waits, the
 * approval dock's surface itself (fixed structure: Deny first, 400 ms arming, ⌘↩ / ⌘D, the
 * binding under ⋯ → Details, once only) with every call in plain words; once it runs, the one-row
 * step log ("12 actions · mail · 0:03") that expands to a row per call, a partial failure's
 * "11 of 12 done · 1 failed: …", and Undo on the receipt row for 30 s when the batch is reversible.
 */
export function BatchCard({
  proposal,
  approval,
  canAnswer,
  onAnswer,
  onUndo,
  onRetryFailed,
  now: fixedNow,
  armDelayMs = 400,
  defaultExpanded = false,
  className,
}: BatchCardProps): ReactElement {
  const now = useNow(1000, fixedNow);
  const [expanded, setExpanded] = useState(defaultExpanded);
  const listId = useId();
  const n = proposal.calls.length;
  const status = proposal.status;

  if (status === "pending" || status === "awaiting_approval") {
    if (approval === null || approval.status !== "pending") {
      return (
        <p
          className={cn(
            "flex items-center gap-2 py-1 text-callout text-label-secondary",
            className,
          )}
          role="status"
        >
          <LoaderCircle className="size-4 animate-spin reduced:animate-none" aria-hidden="true" />
          {t("workflows.batch.preparing")}
        </p>
      );
    }
    return (
      <ApprovalCard
        approval={approval}
        canAnswer={canAnswer}
        {...(onAnswer ? { onAnswer } : {})}
        armDelayMs={armDelayMs}
        {...(fixedNow === undefined ? {} : { now: fixedNow })}
        detailsClassName="max-h-56 overflow-y-auto"
        className={cn("bg-fill-quaternary shadow-none", className)}
      />
    );
  }

  if (status === "dismissed" || status === "expired") {
    return (
      <p className={cn("py-1 text-callout text-label-secondary", className)}>
        {status === "dismissed" ? t("workflows.batch.dismissed") : t("workflows.batch.expired")}
      </p>
    );
  }

  const results = proposal.results ?? [];
  const failed = results.filter((r) => r.status === "failed");
  const ok = results.filter((r) => r.status === "ok").length;
  const firstError = failed[0]?.error ?? t("workflows.batch.unknownError");
  const family = toolFamily(proposal.calls[0]?.tool ?? "");
  const elapsed = offsetLabel(
    Math.max(0, Date.parse(proposal.updatedAt) - Date.parse(proposal.createdAt)),
  );
  const left = UNDO_WINDOW_MS - (now - Date.parse(proposal.updatedAt));
  const undoable =
    onUndo !== undefined &&
    (status === "done" || status === "partial") &&
    !proposal.undoOf &&
    isReversible(proposal) &&
    left > 0;
  const glyph =
    status === "running"
      ? "running"
      : status === "done"
        ? "done"
        : status === "partial"
          ? "partial"
          : "failed";
  const line =
    status === "running"
      ? t("workflows.batch.running", { n })
      : status === "partial"
        ? t("workflows.batch.partial", { ok, n, failed: failed.length, error: firstError })
        : status === "failed"
          ? t("workflows.batch.failed", { n, error: firstError })
          : t("workflows.batch.steps", { n, family, elapsed });

  return (
    <div className={cn("flex min-w-0 flex-col gap-1", className)} data-status={status}>
      <div className="flex min-h-8 min-w-0 items-center gap-2">
        <StatusGlyph status={glyph} morph />
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={listId}
          onClick={() => setExpanded((v) => !v)}
          className="flex min-w-0 flex-1 cursor-default items-center gap-1 rounded-xs text-start text-callout text-label-primary outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={`${line}. ${expanded ? t("workflows.batch.hideSteps") : t("workflows.batch.showSteps")}`}
        >
          <span className="min-w-0 truncate" aria-live="polite">
            {line}
          </span>
          <ChevronDown
            className={cn(
              "size-3.5 shrink-0 text-label-secondary transition-transform reduced:transition-none",
              expanded ? "rotate-180" : "",
            )}
            aria-hidden="true"
          />
        </button>
        {failed.length > 0 && onRetryFailed ? (
          <Button type="button" size="xs" variant="outline" onClick={onRetryFailed}>
            {t("workflows.batch.retry")}
          </Button>
        ) : null}
        {undoable ? (
          <Button type="button" size="xs" variant="ghost" onClick={onUndo}>
            <Undo2 aria-hidden="true" />
            {t("workflows.batch.undoIn", { seconds: Math.ceil(left / 1000) })}
          </Button>
        ) : null}
      </div>
      {expanded ? (
        <ol id={listId} aria-label={t("workflows.batch.callsLabel")} className="flex flex-col ps-6">
          {proposal.calls.map((call, index) => {
            const r = results.find((x) => x.index === index);
            const s =
              r === undefined
                ? status === "running"
                  ? "running"
                  : "pending"
                : r.status === "ok"
                  ? "done"
                  : r.status === "failed"
                    ? "failed"
                    : "skipped";
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: the approved list never reorders
              <li key={index} className="flex min-w-0 items-start gap-2 py-1">
                <StatusGlyph status={s} className="mt-0.5" />
                <span className="min-w-0 flex-1 text-callout text-label-primary">
                  {call.summary}
                  {r?.error ? (
                    <span className="block text-label-secondary">
                      {t("workflows.batch.callError", { error: r.error })}
                    </span>
                  ) : null}
                </span>
              </li>
            );
          })}
        </ol>
      ) : null}
    </div>
  );
}

/**
 * The batch card wired to the Gateway: opening it requests the one `batch` approval
 * (`proposals.approve`); answering runs the calls; Undo offers the inverse batch, which shows
 * here for its own approval.
 */
export function ProposalBatchCard({
  proposalId,
  className,
}: {
  proposalId: string;
  className?: string;
}): ReactElement {
  const [shownId, setShownId] = useState(proposalId);
  const { proposal, approve, undo, error } = useProposal(shownId);
  const answer = useApproval(proposal?.approvalId ?? null);
  const asked = useRef<string | null>(null);

  // The owner tapped "Do it": ask for the approval once per proposal.
  useEffect(() => {
    if (proposal?.status !== "pending" || asked.current === proposal.id) return;
    asked.current = proposal.id;
    approve().catch((err: unknown) => toast.error(describeError(err)));
  }, [proposal, approve]);

  if (proposal === null) {
    return (
      <p className={cn("py-1 text-callout text-label-secondary", className)} role="status">
        {error ?? t("workflows.batch.preparing")}
      </p>
    );
  }
  return (
    <BatchCard
      proposal={proposal}
      approval={answer.approval}
      canAnswer={answer.canAnswer}
      onAnswer={(decision, scope) =>
        answer.answer(decision, decision === "approve" ? (scope ?? "once") : undefined)
      }
      onUndo={() => {
        undo()
          .then((inverse) => setShownId(inverse.id))
          .catch((err: unknown) => toast.error(describeError(err)));
      }}
      {...(className ? { className } : {})}
    />
  );
}
