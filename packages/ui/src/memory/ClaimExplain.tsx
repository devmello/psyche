import type { MemoryChunk, MemoryClaim } from "@psyche/protocol";
import { type ReactElement, useEffect, useState } from "react";
import { Button } from "../components/ui/button.tsx";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../components/ui/dialog.tsx";
import { useCall } from "../data/index.ts";
import { t } from "../i18n/core.ts";
import { describeError } from "../i18n/errors.ts";
import { formatDate } from "../lib/format.ts";
import { confidenceBand } from "./ReviewRow.tsx";

/**
 * "Why do you believe this?" for one memory claim. Only rendered where the row carries a claim id
 * (`memory.explain` takes a claim id; graph facts in the review queue do not have one). The claim
 * text and the chunk text are the owner's or other people's words: plain text only.
 */

export interface ClaimExplainProps {
  /** Null or missing hides the action entirely. */
  claimId: string | null | undefined;
}

type ExplainState =
  | { status: "loading" }
  | { status: "error"; reason: string }
  | { status: "ready"; claim: MemoryClaim; chunks: MemoryChunk[] };

export function ClaimExplain({ claimId }: ClaimExplainProps): ReactElement | null {
  const call = useCall();
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<ExplainState>({ status: "loading" });

  useEffect(() => {
    if (!open || !claimId) return;
    let cancelled = false;
    setState({ status: "loading" });
    call("memory.explain", { claimId }).then(
      (res) => {
        if (!cancelled) setState({ status: "ready", claim: res.claim, chunks: res.chunks });
      },
      (err: unknown) => {
        if (!cancelled) setState({ status: "error", reason: describeError(err) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [open, claimId, call]);

  if (!claimId) return null;

  return (
    <>
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
        {t("memoryReview.explain.open")}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("memoryReview.explain.title")}</DialogTitle>
          </DialogHeader>
          <ExplainBody state={state} />
          <div className="flex justify-end">
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
              {t("common.close")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

function ExplainBody({ state }: { state: ExplainState }): ReactElement {
  if (state.status === "loading") {
    return (
      <p role="status" className="text-callout text-label-secondary">
        {t("memoryReview.explain.loading")}
      </p>
    );
  }
  if (state.status === "error") {
    return (
      <p role="alert" data-testid="explain-error" className="text-callout text-danger-text">
        {t("memoryReview.explain.error", { reason: state.reason })}
      </p>
    );
  }
  const { claim, chunks } = state;
  const band = confidenceBand(claim.confidence);
  return (
    <div data-testid="explain-body" className="flex flex-col gap-3 text-callout">
      <p className="text-body text-label">{claim.text}</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-label-secondary">
        <dt>{t("memoryReview.explain.confidence")}</dt>
        <dd data-testid="explain-confidence">
          {t("memoryReview.explain.confidenceValue", {
            band: t(`memoryReview.confidence.${band}`),
            percent: Math.round(claim.confidence * 100),
          })}
        </dd>
        <dt>{t("memoryReview.explain.provenance")}</dt>
        <dd>{t(`agent.provenance.${claim.provenance}`)}</dd>
        <dt>{t("memoryReview.explain.firstSeen")}</dt>
        <dd>{formatDate(claim.createdAt)}</dd>
        <dt>{t("memoryReview.explain.lastSeen")}</dt>
        <dd>{formatDate(claim.updatedAt)}</dd>
      </dl>
      <section aria-label={t("memoryReview.explain.sources")} className="flex flex-col gap-2">
        <h3 className="text-callout font-medium text-label">{t("memoryReview.explain.sources")}</h3>
        {chunks.length === 0 ? (
          <p data-testid="explain-empty" className="text-label-secondary">
            {t("memoryReview.explain.noSources")}
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {chunks.map((c) => (
              <li key={c.id} className="flex flex-col gap-0.5 border-l-2 border-separator pl-2">
                <span className="font-mono text-xs text-label-secondary">
                  {t("memoryReview.explain.source", { source: c.source, line: c.lineStart })}
                </span>
                <blockquote data-testid="explain-quote" className="text-label-secondary">
                  {c.text}
                </blockquote>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
