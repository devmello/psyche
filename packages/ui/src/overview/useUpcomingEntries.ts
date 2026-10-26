import type { Automation } from "@psyche/protocol";
import { useMemo } from "react";
import { useAutomations, useUpcoming } from "../data/index.ts";
import type { UpcomingEntry } from "./upcoming-groups.ts";

export interface UpcomingEntries {
  /** Enabled, with a next run, soonest first (`automations.upcoming`, joined to the automation). */
  entries: readonly UpcomingEntry[];
  /** Automations that are switched off. */
  paused: readonly Automation[];
  automations: ReturnType<typeof useAutomations>;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

/** What Now & next and Upcoming read: the schedule joined to the automations behind it. */
export function useUpcomingEntries(): UpcomingEntries {
  const automations = useAutomations();
  const upcoming = useUpcoming();
  const list = automations.automations;
  const entries = useMemo(() => {
    const byId = new Map(list.map((a) => [a.id, a]));
    return upcoming.items
      .filter((item) => item.enabled && item.nextRunAt !== null && item.kind !== "input_request")
      .map((item) => ({ item, automation: byId.get(item.automationId ?? item.id) }));
  }, [upcoming.items, list]);
  const paused = useMemo(() => list.filter((a) => !a.enabled), [list]);
  return {
    entries,
    paused,
    automations,
    loading: upcoming.loading || automations.loading,
    error: upcoming.error ?? automations.error,
    reload: () => {
      upcoming.reload();
      automations.reload();
    },
  };
}
