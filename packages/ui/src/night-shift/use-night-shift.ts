import type { ApprovalRequest, NightShiftRefused, StagedAction } from "@psyche/protocol";
import { useCallback, useMemo, useState } from "react";
import { useCall, useGatewayQuery } from "../data/index.ts";
import { t } from "../i18n/core.ts";
import { describeError } from "../i18n/errors.ts";
import {
  type ApplyPayload,
  type ApprovalRow,
  buildApply,
  checkApproval,
  markOpened,
  markRefused,
  reconcile,
  type Selection,
  seedSelection,
  selectAll,
  toggleItem,
  toggleSend,
  visibleItems,
} from "./model.ts";

/** `nightShift.status`: the latest night and the review waiting for the owner, if any. */
export function useNightShiftStatus() {
  const q = useGatewayQuery("nightShift.status", {});
  return {
    enabled: q.data?.enabled ?? false,
    latest: q.data?.latest ?? null,
    readyReviewId: q.data?.readyReviewId ?? null,
    nextWindowAt: q.data?.nextWindowAt ?? null,
    loading: q.loading && q.data === undefined,
    error: q.error,
    reload: q.reload,
  };
}

/** What a review does after an apply or an undo, for the strip under the list. */
export type ReviewNotice =
  | { kind: "approved"; rows: ApprovalRow[]; refused: NightShiftRefused[] }
  | { kind: "refused"; refused: NightShiftRefused[] }
  | { kind: "error"; message: string };

/**
 * One review (`/home?review=<id>`): the items, the owner's ticks, and the answer path.
 *
 * Applying is `nightShift.apply`, then the check, then `approvals.answer` with the token that
 * call returned (docs/design/night-shift-2026.md §3.3). The approval's `details.items` must be
 * exactly the items and sends the owner ticked; if it is not, nothing is answered, the approval
 * is left to expire and the owner sees an error. There is no other answer path here.
 */
export function useNightShiftReview(reviewId: string | null) {
  const call = useCall();
  const q = useGatewayQuery(
    "nightShift.review.get",
    { reviewId: reviewId ?? "" },
    { enabled: reviewId !== null },
  );
  const { reload } = q;
  const items: StagedAction[] = useMemo(() => visibleItems(q.data?.items ?? []), [q.data]);
  const [chosen, setChosen] = useState<Selection | null>(null);
  // Until the owner touches a box, the first selection (drafts ticked) is derived from the items.
  const selection = useMemo(
    () => reconcile(chosen ?? seedSelection(items), items),
    [chosen, items],
  );
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<ReviewNotice | null>(null);

  const edit = useCallback(
    (f: (s: Selection) => Selection) =>
      setChosen((c) => f(reconcile(c ?? seedSelection(items), items))),
    [items],
  );

  /** Answers an approval the Gateway just minted, once it is the one that was asked for. */
  const answerIfBound = useCallback(
    async (
      result: {
        approval?: ApprovalRequest | undefined;
        answerToken?: string | undefined;
        refused: NightShiftRefused[];
      },
      expected: ApplyPayload | { undo: readonly string[] },
    ): Promise<void> => {
      const { approval, answerToken, refused } = result;
      if (approval === undefined || answerToken === undefined) {
        setNotice({ kind: "refused", refused });
        return;
      }
      const check = checkApproval(approval, expected);
      if (!check.ok) {
        setNotice({ kind: "error", message: t("nightShift.review.mismatch") });
        return;
      }
      await call("approvals.answer", {
        approvalId: approval.id,
        answerToken,
        decision: "approve",
        scope: "once",
      });
      setNotice({ kind: "approved", rows: check.rows, refused });
    },
    [call],
  );

  const apply = useCallback(async (): Promise<void> => {
    if (reviewId === null || busy) return;
    const payload = buildApply(selection, items);
    if (payload.items.length === 0) return;
    setBusy(true);
    setNotice(null);
    try {
      const result = await call("nightShift.apply", { reviewId, ...payload });
      // What the Gateway refused is not part of what the approval must cover.
      const gone = new Set(result.refused.map((r) => r.itemId));
      const expected: ApplyPayload = {
        items: payload.items.filter((i) => !gone.has(i.itemId)),
        sends: payload.sends.filter((s) => !gone.has(s.itemId)),
      };
      edit((s) => markRefused(s, result.refused));
      await answerIfBound(result, expected);
    } catch (err) {
      setNotice({ kind: "error", message: describeError(err) });
    } finally {
      setBusy(false);
      reload();
    }
  }, [reviewId, busy, selection, items, call, edit, answerIfBound, reload]);

  const undo = useCallback(
    async (itemId: string): Promise<void> => {
      if (busy) return;
      setBusy(true);
      setNotice(null);
      try {
        const result = await call("nightShift.undo", { itemIds: [itemId] });
        const gone = new Set(result.refused.map((r) => r.itemId));
        await answerIfBound(result, { undo: [itemId].filter((id) => !gone.has(id)) });
      } catch (err) {
        setNotice({ kind: "error", message: describeError(err) });
      } finally {
        setBusy(false);
        reload();
      }
    },
    [busy, call, answerIfBound, reload],
  );

  /** "Dismiss the rest": the items still ready and not ticked. Runs nothing. */
  const dismissRest = useCallback(async (): Promise<void> => {
    if (reviewId === null || busy) return;
    const ids = items
      .filter((i) => i.status === "ready" && !selection.ticked.has(i.id))
      .map((i) => i.id);
    if (ids.length === 0) return;
    setBusy(true);
    try {
      await call("nightShift.dismiss", { reviewId, itemIds: ids });
    } catch (err) {
      setNotice({ kind: "error", message: describeError(err) });
    } finally {
      setBusy(false);
      reload();
    }
  }, [reviewId, busy, items, selection, call, reload]);

  return {
    night: q.data?.night ?? null,
    items,
    selection,
    loading: q.loading && q.data === undefined,
    error: q.error,
    reload,
    busy,
    notice,
    toggle: (item: StagedAction) => edit((s) => toggleItem(s, item)),
    toggleSend: (item: StagedAction) => edit((s) => toggleSend(s, item)),
    selectAll: () => edit((s) => selectAll(s, items)),
    open: (item: StagedAction) => edit((s) => markOpened(s, item)),
    apply,
    undo,
    dismissRest,
  };
}
