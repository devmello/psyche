import type { NightShiftSummary } from "@psyche/protocol";
import type { ReactElement } from "react";
import { Button } from "../components/ui/button.tsx";
import { useGatewayQuery } from "../data/index.ts";
import { t } from "../i18n/core.ts";
import { ScreenSection } from "../screens/feed/ScreenToolbar.tsx";
import { DOMAIN_ORDER } from "./model.ts";
import { useNightShiftStatus } from "./use-night-shift.ts";

/** How many one-liners the card shows before "+N more". */
export const NIGHT_SHIFT_PREVIEW_LINES = 3;

/** "3 reply drafts · 2 calendar fixes · 1 filed document": only the kinds that have any. */
export function countsLine(counts: NightShiftSummary["counts"]): string {
  return DOMAIN_ORDER.filter((d) => counts[d] > 0)
    .map((d) => t(`nightShift.count.${d}`, { n: counts[d] }))
    .join(" · ");
}

/**
 * Home's "Prepared overnight" (docs/design/night-shift-2026.md §5.1): counts per kind, the first
 * three one-liners and a Review button, right after Needs you. Drawn only while a review waits;
 * a Gateway without Night shift, a failed read or a quiet night draw nothing.
 */
export function NightShiftSection({
  onNavigate,
  accent = true,
}: {
  onNavigate: (to: string) => void;
  /** No other control on the page holds the accent. */
  accent?: boolean;
}): ReactElement | null {
  const status = useNightShiftStatus();
  const reviewId = status.readyReviewId;
  const review = useGatewayQuery(
    "nightShift.review.get",
    { reviewId: reviewId ?? "" },
    { enabled: reviewId !== null },
  );
  if (reviewId === null || status.latest === null) return null;
  const ready = (review.data?.items ?? []).filter((i) => i.status === "ready");
  const lines = ready.slice(0, NIGHT_SHIFT_PREVIEW_LINES);
  const counts = countsLine(status.latest.counts);
  return (
    <ScreenSection
      id="night-shift"
      title={t("nightShift.section.title")}
      large
      {...(counts ? { meta: counts } : {})}
      actions={
        <Button
          type="button"
          size="sm"
          variant={accent ? "default" : "outline"}
          onClick={() => onNavigate(`/home?review=${encodeURIComponent(reviewId)}`)}
        >
          {t("nightShift.section.review")}
        </Button>
      }
    >
      {lines.length > 0 ? (
        <ul
          aria-label={t("nightShift.section.title")}
          className="flex flex-col rounded-lg bg-surface-raised p-1 shadow-elevation-1"
        >
          {lines.map((item) => (
            <li key={item.id} className="min-h-11 px-2.5 py-2.5 text-body text-label-primary">
              {item.summary}
            </li>
          ))}
          {ready.length > lines.length ? (
            <li className="px-2.5 pb-2 text-callout text-label-secondary">
              {t("nightShift.section.more", { n: ready.length - lines.length })}
            </li>
          ) : null}
        </ul>
      ) : null}
    </ScreenSection>
  );
}
