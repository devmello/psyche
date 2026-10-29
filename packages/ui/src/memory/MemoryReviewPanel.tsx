import type { QuarantineAction, QuarantineItem, ReviewItem } from "@psyche/protocol";
import { type ReactElement, type ReactNode, useState } from "react";
import { t } from "../i18n/core.ts";
import { cn } from "../lib/utils.ts";
import { undoDeadline } from "./hooks.ts";
import { QuarantineList } from "./QuarantineList.tsx";
import { ReviewList } from "./ReviewList.tsx";
import type { ReviewAction } from "./ReviewRow.tsx";

type Tab = "review" | "recent" | "quarantine";

export interface MemoryReviewPanelProps {
  pending: readonly ReviewItem[];
  recent: readonly ReviewItem[];
  quarantine: readonly QuarantineItem[];
  busy?: boolean;
  now?: number;
  onAct: (item: ReviewItem, action: ReviewAction) => void;
  onActGroup: (items: readonly ReviewItem[], decision: "confirm" | "discard") => void;
  onActQuarantine: (item: QuarantineItem, action: QuarantineAction) => void;
  initialTab?: Tab;
  footer?: ReactNode;
}

/** Memory → Review: To review, Learned lately (with Undo), Quarantine. */
export function MemoryReviewPanel({
  pending,
  recent,
  quarantine,
  busy = false,
  now = Date.now(),
  onAct,
  onActGroup,
  onActQuarantine,
  initialTab = "review",
  footer,
}: MemoryReviewPanelProps): ReactElement {
  const [tab, setTab] = useState<Tab>(initialTab);
  const tabs: { id: Tab; label: string }[] = [
    { id: "review", label: t("memoryReview.tab.review", { n: pending.length }) },
    { id: "recent", label: t("memoryReview.tab.recent", { n: recent.length }) },
    { id: "quarantine", label: t("memoryReview.tab.quarantine", { n: quarantine.length }) },
  ];
  return (
    <div className="flex flex-col gap-3">
      <div role="tablist" className="flex gap-1">
        {tabs.map((x) => (
          <button
            key={x.id}
            type="button"
            role="tab"
            aria-selected={tab === x.id}
            onClick={() => setTab(x.id)}
            className={cn(
              "rounded-md px-3 py-1 text-callout",
              tab === x.id ? "bg-fill-tertiary text-label" : "text-label-secondary",
            )}
          >
            {x.label}
          </button>
        ))}
      </div>
      <div role="tabpanel">
        {tab === "review" ? (
          <ReviewList
            items={pending}
            busy={busy}
            onAct={onAct}
            onActGroup={onActGroup}
            emptyText={t("memoryReview.empty.review")}
          />
        ) : tab === "recent" ? (
          <ReviewList
            items={recent.filter((i) => undoDeadline(i, now) !== undefined)}
            busy={busy}
            onAct={onAct}
            undoUntil={(i) => undoDeadline(i, now)}
            emptyText={t("memoryReview.empty.recent")}
          />
        ) : (
          <QuarantineList
            items={quarantine}
            busy={busy}
            onAct={onActQuarantine}
            emptyText={t("memoryReview.empty.quarantine")}
          />
        )}
      </div>
      {footer}
    </div>
  );
}
