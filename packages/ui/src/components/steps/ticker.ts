import { useSyncExternalStore } from "react";

/**
 * One 1 Hz clock for every live duration on screen (docs/design/run-trace-2026.md §3.7): a single
 * interval runs while at least one subscriber is mounted and stops with the last one, so a page of
 * live steps costs one timer, and every elapsed time ticks on the same frame.
 */

export const TICK_MS = 1000;

type Listener = () => void;

const listeners = new Set<Listener>();
let timer: ReturnType<typeof setInterval> | undefined;
let now = Date.now();

function tick(): void {
  now = Date.now();
  for (const l of listeners) l();
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  if (timer === undefined) {
    now = Date.now();
    timer = setInterval(tick, TICK_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

const idle = () => () => {};

/**
 * The shared clock's time, re-rendering once a second while `live`. Not live, it subscribes to
 * nothing and returns the clock's last value (callers use their own end time then).
 */
export function useTicker(live: boolean): number {
  return useSyncExternalStore(
    live ? subscribe : idle,
    () => now,
    () => now,
  );
}

/** How many components the shared clock is driving (tests). */
export function tickerSubscribers(): number {
  return listeners.size;
}

/** Whether the shared clock's interval is running (tests). */
export function tickerRunning(): boolean {
  return timer !== undefined;
}
