import type { ReactElement } from "react";
import { Button } from "../components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog.tsx";
import { activeI18n, t } from "../i18n/core.ts";
import { useNow } from "../lib/use-now.ts";
import { ItemRow } from "./ItemRow.tsx";
import { groupByDomain, MAX_APPLY_ITEMS, tickable } from "./model.ts";
import { type ReviewNotice, useNightShiftReview, useNightShiftStatus } from "./use-night-shift.ts";

export interface ReviewSheetProps {
  /** `/home?review=<id>`; `latest` is the review waiting now. */
  review: string;
  onClose: () => void;
  /** Fixed clock (stories, tests). */
  now?: number;
}

function Notice({ notice }: { notice: ReviewNotice }): ReactElement {
  if (notice.kind === "error")
    return (
      <p role="alert" className="text-callout text-destructive" data-testid="night-shift-error">
        {notice.message}
      </p>
    );
  if (notice.kind === "refused")
    return (
      <div role="status" className="flex flex-col gap-1 text-callout text-label-secondary">
        <p>{t("nightShift.notice.nothing")}</p>
        {notice.refused.map((r) => (
          <p key={r.itemId}>{t("nightShift.row.refused", { reason: r.reason })}</p>
        ))}
      </div>
    );
  return (
    <div role="status" className="flex flex-col gap-1 text-callout text-label-secondary">
      <p>{t("nightShift.notice.approved")}</p>
      {/* Only what the approval itself lists: its summaries, never any other detail key. */}
      <ul className="list-disc ps-5" data-testid="night-shift-approved">
        {notice.rows.map((r) => (
          <li key={`${r.itemId}:${r.sendHash ?? ""}`}>
            {r.sendHash !== null && r.recipients.length > 0
              ? t("nightShift.send.to", { recipients: r.recipients.join(", ") })
              : (r.summary ?? r.itemId)}
          </li>
        ))}
      </ul>
      {notice.refused.length > 0 ? (
        <p>{t("nightShift.notice.refused", { n: notice.refused.length })}</p>
      ) : null}
    </div>
  );
}

/**
 * The morning review (docs/design/night-shift-2026.md §5.1): a sheet over Home with the night's
 * prepared changes grouped by kind, a box on each, and Apply selected. Applying asks the Gateway
 * for one approval and answers it only if it covers exactly what is ticked (`useNightShiftReview`).
 */
export function ReviewSheet({ review, onClose, now: fixedNow }: ReviewSheetProps): ReactElement {
  const status = useNightShiftStatus();
  const reviewId = review === "latest" ? status.readyReviewId : review;
  const r = useNightShiftReview(reviewId);
  const now = useNow(60_000, fixedNow);
  const groups = groupByDomain(r.items);
  const nTicked = r.selection.ticked.size;
  const anyTickable = r.items.some((i) => tickable(i, r.selection));
  const anyReady = r.items.some((i) => i.status === "ready");
  const expiresAt = r.night?.expiresAt ?? null;
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="flex max-h-[85vh] flex-col gap-3 sm:max-w-2xl"
        data-testid="night-shift-review"
      >
        <DialogHeader>
          <DialogTitle>{t("nightShift.review.title")}</DialogTitle>
          <DialogDescription>
            {t("nightShift.review.description")}
            {expiresAt !== null
              ? ` ${t("nightShift.review.expires", {
                  date: activeI18n().date(expiresAt, {
                    weekday: "long",
                    month: "short",
                    day: "numeric",
                  }),
                })}`
              : ""}
          </DialogDescription>
        </DialogHeader>
        <div className="-mx-1 flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-1">
          {r.error !== null && r.items.length === 0 ? (
            <p role="alert" className="text-callout text-label-secondary">
              {t("nightShift.review.loadFailed")}{" "}
              <Button type="button" size="xs" variant="plain" onClick={r.reload}>
                {t("common.tryAgain")}
              </Button>
            </p>
          ) : r.loading ? null : groups.length === 0 ? (
            <p className="text-callout text-label-secondary">{t("nightShift.review.empty")}</p>
          ) : (
            groups.map(([domain, list]) => (
              <section
                key={domain}
                aria-labelledby={`ns-${domain}`}
                className="flex flex-col gap-1"
              >
                <h3 id={`ns-${domain}`} className="px-1 text-title-3 text-label-primary">
                  {t(`nightShift.domain.${domain}`)}
                </h3>
                <ul className="flex flex-col divide-y divide-separator rounded-lg bg-surface-raised p-1 shadow-elevation-1">
                  {list.map((item) => (
                    <ItemRow
                      key={item.id}
                      item={item}
                      selection={r.selection}
                      now={now}
                      busy={r.busy}
                      onToggle={() => r.toggle(item)}
                      onToggleSend={() => r.toggleSend(item)}
                      onOpen={() => r.open(item)}
                      onUndo={() => void r.undo(item.id)}
                    />
                  ))}
                </ul>
              </section>
            ))
          )}
        </div>
        {r.notice ? <Notice notice={r.notice} /> : null}
        {r.items.some((i) => i.send !== null && i.status === "ready") ? (
          <p className="text-callout text-label-secondary">{t("nightShift.review.sendsHint")}</p>
        ) : null}
        <div className="flex flex-wrap items-center gap-2 border-t border-separator pt-3">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={!anyTickable || r.busy}
            onClick={r.selectAll}
          >
            {t("nightShift.footer.selectAll")}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={!anyReady || r.busy}
            onClick={() => void r.dismissRest()}
          >
            {t("nightShift.footer.dismissRest")}
          </Button>
          <Button
            type="button"
            className="ms-auto"
            disabled={nTicked === 0 || nTicked > MAX_APPLY_ITEMS || r.busy}
            onClick={() => void r.apply()}
          >
            {r.busy
              ? t("nightShift.footer.applying")
              : t("nightShift.footer.apply", { n: nTicked })}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
