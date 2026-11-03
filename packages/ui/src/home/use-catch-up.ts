import type { CatchUpActAction, CatchUpItem } from "@psyche/protocol";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { useCall, useGatewayQuery } from "../data/index.ts";
import { describeError } from "../i18n/errors.ts";

/** Home shows at most this many lines of "Catching up" (the Gateway's own limit for Home). */
export const CATCH_UP_LIMIT = 3;

/**
 * Home's "Catching up" from `memory.catchup.list` (docs/design/memory-everything-2026.md §5.6).
 * The Gateway ranks, limits and filters the list for the surface, so this only splits it: the
 * past-due questions ("Did you finish ...?") belong to Needs you, everything else to Catching up.
 * Work memory off, or a Gateway without the method, is an empty list: nothing is drawn.
 */
export function useCatchUp() {
  const call = useCall();
  const q = useGatewayQuery("memory.catchup.list", { surface: "home", limit: CATCH_UP_LIMIT });
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const items: readonly CatchUpItem[] = q.data?.items ?? [];
  const asks = useMemo(() => items.filter((i) => i.ask === true), [items]);
  const lines = useMemo(() => items.filter((i) => i.ask !== true), [items]);
  const { reload } = q;

  /** Answers a question or acts on a line; the list reloads from the Gateway. */
  const act = async (entityId: string, action: CatchUpActAction): Promise<void> => {
    setBusy((s) => new Set(s).add(entityId));
    try {
      await call("memory.catchup.act", { entityId, action });
      reload();
    } catch (err) {
      toast.error(describeError(err));
    } finally {
      setBusy((s) => {
        const next = new Set(s);
        next.delete(entityId);
        return next;
      });
    }
  };

  return {
    lines,
    asks,
    pendingCount: q.data?.pendingCount ?? 0,
    busy,
    act,
  };
}
