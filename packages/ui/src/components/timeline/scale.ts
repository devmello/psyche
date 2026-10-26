/**
 * The Timeline's time scale (docs/design/run-trace-2026.md §3.3): epoch ms → x px across a track,
 * with idle gaps longer than `minGapMs` collapsed to a fixed-width break, so a two-hour wait for
 * an approval doesn't flatten every other step. Pure: the waterfall, the axis, the playhead and
 * the scrubber share one scale.
 */

export interface Interval {
  start: number;
  /** Absent while running: the interval reaches `end` of the scale. */
  end?: number | undefined;
}

export interface Gap {
  from: number;
  to: number;
}

/** Spans of time where no interval is active, longer than `minGapMs`. */
export function idleGaps(intervals: readonly Interval[], end: number, minGapMs = 10_000): Gap[] {
  const sorted = [...intervals]
    .map((i) => ({ start: i.start, end: i.end ?? end }))
    .sort((a, b) => a.start - b.start);
  const gaps: Gap[] = [];
  let reach = sorted[0]?.start ?? end;
  for (const i of sorted) {
    if (i.start - reach > minGapMs) gaps.push({ from: reach, to: i.start });
    reach = Math.max(reach, i.end);
  }
  return gaps;
}

export interface TimeScale {
  start: number;
  end: number;
  width: number;
  gaps: readonly Gap[];
  /** Epoch ms → x px (0…width). Times inside a gap land on the break. */
  x(at: number): number;
  /** x px → epoch ms (a point on a break maps to the gap's start). */
  at(x: number): number;
  /** Visible milliseconds per pixel (outside the breaks). */
  msPerPx: number;
}

export function timeScale(o: {
  start: number;
  end: number;
  width: number;
  gaps?: readonly Gap[];
  /** Width of each collapsed gap. */
  gapPx?: number;
}): TimeScale {
  const gapPx = o.gapPx ?? 16;
  const gaps = (o.gaps ?? []).filter((g) => g.to > g.from).sort((a, b) => a.from - b.from);
  const hidden = gaps.reduce((sum, g) => sum + (g.to - g.from), 0);
  const visibleMs = Math.max(1, o.end - o.start - hidden);
  const span = Math.max(1, o.width - gaps.length * gapPx);
  const msPerPx = visibleMs / span;
  const x = (at: number): number => {
    let px = 0;
    let cursor = o.start;
    for (const g of gaps) {
      if (at <= g.from) break;
      px += (g.from - cursor) / msPerPx;
      if (at < g.to) return px + ((at - g.from) / (g.to - g.from)) * gapPx;
      px += gapPx;
      cursor = g.to;
    }
    return Math.min(o.width, Math.max(0, px + (at - cursor) / msPerPx));
  };
  const at = (px: number): number => {
    let used = 0;
    let cursor = o.start;
    for (const g of gaps) {
      const before = (g.from - cursor) / msPerPx;
      if (px <= used + before) return cursor + (px - used) * msPerPx;
      used += before;
      if (px <= used + gapPx) return g.from;
      used += gapPx;
      cursor = g.to;
    }
    return Math.min(o.end, cursor + (px - used) * msPerPx);
  };
  return { start: o.start, end: o.end, width: o.width, gaps, x, at, msPerPx };
}

const STEPS_MS = [
  1_000, 2_000, 5_000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000, 900_000,
  1_800_000, 3_600_000,
];

/** Axis ticks (ms from the start) at a round interval, about every `minPx` pixels. */
export function axisTicks(scale: TimeScale, minPx = 72): number[] {
  const want = scale.msPerPx * minPx;
  const step = STEPS_MS.find((s) => s >= want) ?? STEPS_MS.at(-1) ?? 60_000;
  const out: number[] = [];
  let lastX = Number.NEGATIVE_INFINITY;
  for (let t = 0; scale.start + t <= scale.end; t += step) {
    const at = scale.start + t;
    if (scale.gaps.some((g) => at > g.from && at < g.to)) continue;
    // After a collapsed gap the next round tick can land right beside the last one: skip it.
    const x = scale.x(at);
    if (x - lastX < minPx * 0.75) continue;
    out.push(t);
    lastX = x;
  }
  return out;
}
