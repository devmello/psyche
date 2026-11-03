import { type ReactElement, useEffect, useRef } from "react";
import { t } from "../i18n/core.ts";
import { useMemoryReview } from "../memory/hooks.ts";
import { MemoryReviewPanel } from "../memory/MemoryReviewPanel.tsx";
import { SenderOffers } from "../memory/SenderOffers.tsx";
import { LoadGate } from "../screens/settings/shared.tsx";
import { usePersona } from "../slots.tsx";

export interface ReviewTabProps {
  /** Called when the number of facts waiting changes after the first load, so the chip follows. */
  onPendingChange?: () => void;
  now?: number;
}

/**
 * Memory → Review (docs/design/memory-everything-2026.md §6.4): the facts waiting for the
 * owner's OK, what was learned lately (with Undo), the quarantine and the senders Psyche offers
 * to trust. It was Settings → Memory → Review; Settings keeps the rules and links here.
 */
export function ReviewTab({ onPendingChange, now }: ReviewTabProps): ReactElement {
  const persona = usePersona();
  const review = useMemoryReview();
  const seen = useRef<number | null>(null);
  const pending = review.counts.pending;
  useEffect(() => {
    if (review.loading) return;
    if (seen.current !== null && seen.current !== pending) onPendingChange?.();
    seen.current = pending;
  }, [review.loading, pending, onPendingChange]);

  return (
    <div className="flex flex-col gap-4" data-testid="memory-review">
      <p className="text-callout text-label-secondary">
        {t("memoryReview.description", { persona: persona.name })}
      </p>
      <LoadGate
        label={t("memoryReview.loadLabel")}
        loading={review.loading}
        error={review.error}
        onRetry={review.reload}
      >
        <SenderOffers senders={review.senders} busy={review.busy} onDecide={review.decideSender} />
        <MemoryReviewPanel
          pending={review.pending}
          recent={review.recent}
          quarantine={review.quarantine}
          busy={review.busy}
          {...(now === undefined ? {} : { now })}
          onAct={review.act}
          onActGroup={review.actGroup}
          onActQuarantine={review.actQuarantine}
        />
      </LoadGate>
    </div>
  );
}
