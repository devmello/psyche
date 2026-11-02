import type { SenderTrust, SenderTrustDecision } from "@psyche/protocol";
import type { ReactElement } from "react";
import { Button } from "../components/ui/button.tsx";
import { t } from "../i18n/core.ts";

/**
 * Per-sender auto-accept (docs/design/everything-memory-2026.md §7.3, decision 6): the offer
 * after enough confirmed facts from one contact, and the contacts already trusted. Names come
 * from mail headers, so they are shown as plain text only.
 */
export function SenderOffers({
  senders,
  busy = false,
  onDecide,
}: {
  senders: readonly SenderTrust[];
  busy?: boolean;
  onDecide: (sender: SenderTrust, decision: SenderTrustDecision) => void;
}): ReactElement | null {
  if (senders.length === 0) return null;
  return (
    <section aria-label={t("memoryReview.senders.title")} className="flex flex-col gap-2">
      {senders.map((s) =>
        s.state === "offered" ? (
          <div
            key={s.entityId}
            data-testid="sender-offer"
            className="flex flex-col gap-2 rounded-lg bg-fill-quaternary px-3 py-2"
          >
            <p className="text-body">
              {t("memoryReview.senders.offer", { n: s.confirmed, name: s.name })}
            </p>
            <p className="text-callout text-label-secondary">
              {t("memoryReview.senders.offerHint")}
            </p>
            <div className="flex gap-1">
              <Button size="sm" disabled={busy} onClick={() => onDecide(s, "trust")}>
                {t("memoryReview.senders.trust")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => onDecide(s, "decline")}
              >
                {t("memoryReview.senders.decline")}
              </Button>
            </div>
          </div>
        ) : (
          <div
            key={s.entityId}
            data-testid="sender-trusted"
            className="flex items-center justify-between gap-2 px-3 text-callout text-label-secondary"
          >
            <span>{t("memoryReview.senders.trusted", { name: s.name })}</span>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => onDecide(s, "revoke")}>
              {t("memoryReview.senders.revoke")}
            </Button>
          </div>
        ),
      )}
    </section>
  );
}
