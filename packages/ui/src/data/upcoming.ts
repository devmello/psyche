import type { UpcomingItem } from "@psyche/protocol";
import { useMemo } from "react";
import { type LoadState, useGatewayQuery } from "./hooks.ts";

const NO_ITEMS: readonly UpcomingItem[] = [];

/**
 * Everything scheduled with its next run time, soonest first (`automations.upcoming`): the
 * Overview's Now & next and Upcoming sections. `horizonHours` defaults to the gateway's.
 */
export function useUpcoming(
  options: { horizonHours?: number; limit?: number } = {},
): LoadState & { items: readonly UpcomingItem[] } {
  const params = useMemo(
    () => ({
      ...(options.horizonHours === undefined ? {} : { horizonHours: options.horizonHours }),
      ...(options.limit === undefined ? {} : { limit: options.limit }),
    }),
    [options.horizonHours, options.limit],
  );
  const q = useGatewayQuery("automations.upcoming", params);
  return { loading: q.loading, error: q.error, reload: q.reload, items: q.data?.items ?? NO_ITEMS };
}
