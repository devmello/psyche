import { useEffect, useState } from "react";

/**
 * The replay playhead clock. It ticks every animation frame while playing, so it lives outside
 * React state: the playhead line and the scrubber thumb subscribe and write their position
 * straight to the DOM, and the view re-renders only when something discrete changes.
 */
export interface ReplayClock {
  get(): number;
  set(t: number): void;
  subscribe(fn: (t: number) => void): () => void;
}

export function createReplayClock(initial = 0): ReplayClock {
  let t = initial;
  const subs = new Set<(t: number) => void>();
  return {
    get: () => t,
    set(next) {
      if (next === t) return;
      t = next;
      for (const fn of subs) fn(t);
    },
    subscribe(fn) {
      subs.add(fn);
      return () => {
        subs.delete(fn);
      };
    },
  };
}

export function useReplayClock(initial = 0): ReplayClock {
  const [clock] = useState(() => createReplayClock(initial));
  return clock;
}

/** Calls `fn` on every clock tick (and not on mount) for as long as `clock` is set. */
export function useClockTick(clock: ReplayClock | undefined, fn: (t: number) => void): void {
  useEffect(() => {
    if (!clock) return;
    return clock.subscribe(fn);
  }, [clock, fn]);
}

/** How many of the ascending `times` are at or before `t`: changes only when a step set could. */
export function countAtOrBefore(times: readonly number[], t: number): number {
  let lo = 0;
  let hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((times[mid] as number) <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
