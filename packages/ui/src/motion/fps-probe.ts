/**
 * Dev-only refresh-rate probe (docs/design/motion.md §5): measures requestAnimationFrame
 * intervals for two seconds and logs the median rate, to compare with the display's refresh
 * rate the desktop main logs as `[display] … Hz`. Enable with
 * `localStorage.setItem("psyche.fpsProbe", "1")` and reload.
 */
export const FPS_PROBE_KEY = "psyche.fpsProbe";

export function fpsProbeEnabled(): boolean {
  try {
    return globalThis.localStorage?.getItem(FPS_PROBE_KEY) === "1";
  } catch {
    return false;
  }
}

/** The median of frame intervals in ms, as frames per second (rounded). */
export function medianFps(intervals: readonly number[]): number {
  if (intervals.length === 0) return 0;
  const sorted = [...intervals].sort((a, b) => a - b);
  const mid = sorted[Math.floor(sorted.length / 2)] as number;
  return mid > 0 ? Math.round(1000 / mid) : 0;
}

export function startFpsProbe(durationMs = 2000, log = console.info): () => void {
  if (typeof requestAnimationFrame !== "function") return () => {};
  const intervals: number[] = [];
  let last = 0;
  let start = 0;
  let handle = 0;
  const tick = (t: number) => {
    if (start === 0) start = t;
    else intervals.push(t - last);
    last = t;
    if (t - start < durationMs) handle = requestAnimationFrame(tick);
    else log(`[fps] requestAnimationFrame ≈ ${medianFps(intervals)} Hz`);
  };
  handle = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(handle);
}
