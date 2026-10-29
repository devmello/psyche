import type { QuarantineAction, QuarantineItem, ReviewItem } from "@psyche/protocol";
import { useState } from "react";
import { toast } from "sonner";
import { useCall, useGatewayQuery } from "../data/hooks.ts";
import { t } from "../i18n/core.ts";
import { describeError } from "../i18n/errors.ts";
import type { ReviewAction } from "./ReviewRow.tsx";

/** Auto-accepted facts can be undone for this long (docs/design/everything-memory-2026.md §7.2). */
export const UNDO_DAYS = 7;
const DAY_MS = 86_400_000;

/** When an auto-accepted fact can no longer be undone, or undefined once that has passed. */
export function undoDeadline(item: ReviewItem, now: number): string | undefined {
  const start = Date.parse(item.fact.lastSeenAt ?? item.fact.recordedAt);
  const until = start + UNDO_DAYS * DAY_MS;
  return until > now ? new Date(until).toISOString() : undefined;
}

export interface MemoryReviewState {
  pending: ReviewItem[];
  recent: ReviewItem[];
  quarantine: QuarantineItem[];
  counts: { pending: number; autoAccepted: number; quarantined: number };
  loading: boolean;
  error: string | null;
  reload: () => void;
  busy: boolean;
  act: (item: ReviewItem, action: ReviewAction) => void;
  actGroup: (items: readonly ReviewItem[], decision: "confirm" | "discard") => void;
  actQuarantine: (item: QuarantineItem, action: QuarantineAction) => void;
}

/** The review queue, the recently auto-accepted facts and the quarantine, with the owner's writes. */
export function useMemoryReview(): MemoryReviewState {
  const call = useCall();
  const pending = useGatewayQuery("memory.review.list", { state: ["pending"], limit: 200 });
  const recent = useGatewayQuery("memory.review.list", { state: ["auto_accepted"], limit: 100 });
  const held = useGatewayQuery("memory.quarantine.list", { limit: 100 });
  const [busy, setBusy] = useState(false);
  const reload = () => {
    pending.reload();
    recent.reload();
    held.reload();
  };
  const write = (work: () => Promise<unknown>) => {
    setBusy(true);
    work()
      .then(reload)
      .catch((err: unknown) =>
        toast.error(t("memoryReview.failed", { reason: describeError(err) })),
      )
      .finally(() => setBusy(false));
  };
  return {
    pending: pending.data?.items ?? [],
    recent: recent.data?.items ?? [],
    quarantine: held.data?.items ?? [],
    counts: pending.data?.counts ?? { pending: 0, autoAccepted: 0, quarantined: 0 },
    loading: pending.loading && pending.data === undefined,
    error: pending.error ?? recent.error ?? held.error,
    reload,
    busy,
    act: (item, action) =>
      write(() => {
        const id = item.fact.id;
        if (action.kind === "undo") return call("memory.review.undo", { factId: id });
        if (action.kind === "confirm")
          return call("memory.review.decide", { factIds: [id], decision: "confirm" });
        if (action.kind === "edit")
          return call("memory.review.decide", {
            factIds: [id],
            decision: "edit",
            value: action.value,
          });
        return call("memory.review.decide", {
          factIds: [id],
          decision: "discard",
          ...(action.never === undefined ? {} : { never: action.never }),
        });
      }),
    actGroup: (items, decision) =>
      write(() =>
        call("memory.review.decide", {
          factIds: items.map((i) => i.fact.id).slice(0, 200),
          decision,
        }),
      ),
    actQuarantine: (item, action) =>
      write(() => call("memory.quarantine.decide", { id: item.id, action })),
  };
}
