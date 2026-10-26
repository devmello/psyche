/**
 * Pure maths for the overview charts (agent-overview-2026 §5.4, §5.7): bucketing, layout, deltas
 * and the keyboard model. No React, no i18n; every function is unit-tested.
 */

/** One day of a chart: a `YYYY-MM-DD` calendar day and its count per series id. */
export interface DayDatum {
  date: string;
  values: Readonly<Record<string, number>>;
  /** Extra tooltip line (measured run time and the like). */
  detail?: string;
}

export interface ChartSeries {
  id: string;
  label: string;
  /** Any CSS colour; the chart tokens `var(--chart-1)` … by default. */
  color: string;
  /** The spoken value: "18 tasks". Default: "label: n". */
  describe?: (n: number) => string;
}

/** Sum of the shown series for a day. */
export function dayTotal(day: DayDatum, shown: readonly string[]): number {
  let sum = 0;
  for (const id of shown) sum += Math.max(0, day.values[id] ?? 0);
  return sum;
}

// ---------------------------------------------------------------------------------------------
// Heatmap bucketing

export const HEAT_LEVELS = 5;

/**
 * Upper bounds of the heatmap buckets: quantiles of the owner's own non-zero days (nearest
 * rank), so a light user still sees contrast. Strictly increasing and at most `buckets` long;
 * few distinct values give fewer buckets. Empty when there is no non-zero day.
 */
export function quantileEdges(values: readonly number[], buckets = HEAT_LEVELS): number[] {
  const sorted = values.filter((v) => v > 0).sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) return [];
  const edges: number[] = [];
  for (let k = 1; k <= buckets; k++) {
    const edge = sorted[Math.min(n - 1, Math.ceil((k / buckets) * n) - 1)] as number;
    if (edges.at(-1) !== edge) edges.push(edge);
  }
  return edges;
}

/** 0 for an empty day, else 1…edges.length (the first bucket whose upper bound holds the value). */
export function bucketOf(value: number, edges: readonly number[]): number {
  if (!(value > 0) || edges.length === 0) return 0;
  const i = edges.findIndex((e) => value <= e);
  return i === -1 ? edges.length : i + 1;
}

/** The ramp level (1…HEAT_LEVELS) a bucket is drawn with: spread over the ramp when sparse. */
export function rampLevel(bucket: number, bucketCount: number): number {
  if (bucket <= 0) return 0;
  if (bucketCount <= 1) return HEAT_LEVELS;
  return 1 + Math.round(((bucket - 1) * (HEAT_LEVELS - 1)) / (bucketCount - 1));
}

export interface BucketRange {
  bucket: number;
  level: number;
  from: number;
  to: number;
}

/** The legend's real ranges: "1–3, 4–8, …" (integer counts; a one-value range has from === to). */
export function bucketRanges(edges: readonly number[]): BucketRange[] {
  let prev = 0;
  return edges.map((to, i) => {
    const range = { bucket: i + 1, level: rampLevel(i + 1, edges.length), from: prev + 1, to };
    prev = to;
    return range;
  });
}

// ---------------------------------------------------------------------------------------------
// Calendar layout

export type WeekStart = 0 | 1;

export interface HeatCell {
  date: string;
  /** 0 = first row (the week's first day). */
  row: number;
}

const DAY_MS = 86_400_000;
const parseDay = (date: string): number => Date.parse(`${date}T00:00:00Z`);
const formatDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** Weekday of a `YYYY-MM-DD` day, 0 = Sunday. */
export function weekdayOf(date: string): number {
  return new Date(parseDay(date)).getUTCDay();
}

/** Every day from `first` to `last` inclusive. */
export function dayRange(first: string, last: string): string[] {
  const out: string[] = [];
  for (let t = parseDay(first); t <= parseDay(last); t += DAY_MS) out.push(formatDay(t));
  return out;
}

/**
 * Weeks × 7: the calendar columns for the days from `first` to `last`. Cells outside the range
 * (the start of the first week, the end of the last) are `null`.
 */
export function weekColumns(
  first: string,
  last: string,
  weekStart: WeekStart = 1,
): (HeatCell | null)[][] {
  const days = dayRange(first, last);
  if (days.length === 0) return [];
  const lead = (weekdayOf(first) - weekStart + 7) % 7;
  const cells: (HeatCell | null)[] = [
    ...Array.from({ length: lead }, () => null),
    ...days.map((date, i) => ({ date, row: (lead + i) % 7 })),
  ];
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks: (HeatCell | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

// ---------------------------------------------------------------------------------------------
// Stacked bars layout

/** A round axis maximum: 1, 2, 5 or 10 × a power of ten, never below 1. */
export function niceMax(value: number): number {
  if (!(value > 1)) return 1;
  const pow = 10 ** Math.floor(Math.log10(value));
  const f = value / pow;
  const step = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
  return step * pow;
}

export interface BarSegment {
  id: string;
  value: number;
  /** Pixel height of the fill. */
  height: number;
  /** Gap above the segment (0 for the bottom one). */
  gap: number;
}

export interface BarLayout {
  date: string;
  total: number;
  segments: BarSegment[];
}

export const SEGMENT_GAP = 2;

/**
 * Pixel heights for each day's stack. All bars share one scale (`niceMax` of the tallest shown
 * total); the 2 px gaps between fills are taken out of the plot height so a full bar fits.
 */
export function layoutBars(
  days: readonly DayDatum[],
  order: readonly string[],
  shown: readonly string[],
  plotHeight: number,
): { max: number; bars: BarLayout[] } {
  const visible = order.filter((id) => shown.includes(id));
  const max = niceMax(Math.max(0, ...days.map((d) => dayTotal(d, visible))));
  const gapRoom = SEGMENT_GAP * Math.max(0, visible.length - 1);
  const scale = Math.max(0, plotHeight - gapRoom) / max;
  const bars = days.map((day) => {
    let drawn = 0;
    const segments: BarSegment[] = [];
    for (const id of visible) {
      const value = Math.max(0, day.values[id] ?? 0);
      if (value === 0) continue;
      segments.push({ id, value, height: value * scale, gap: drawn > 0 ? SEGMENT_GAP : 0 });
      drawn++;
    }
    return { date: day.date, total: dayTotal(day, visible), segments };
  });
  return { max, bars };
}

// ---------------------------------------------------------------------------------------------
// Deltas and sparklines

export type Delta =
  | { kind: "none" }
  | { kind: "flat" }
  | { kind: "up" | "down"; amount: number; fraction: number };

/**
 * Change against the previous period. No previous value, or a previous of 0, has no honest
 * ratio, so it is `none` (shown as "—"), never "+∞%".
 */
export function computeDelta(current: number, previous: number | null | undefined): Delta {
  if (previous == null || !Number.isFinite(previous) || previous <= 0) return { kind: "none" };
  const diff = current - previous;
  if (diff === 0) return { kind: "flat" };
  return {
    kind: diff > 0 ? "up" : "down",
    amount: Math.abs(diff),
    fraction: Math.abs(diff) / previous,
  };
}

/** A sparkline needs at least two non-zero points to say anything. */
export function sparklineEligible(values: readonly number[] | undefined): boolean {
  return values !== undefined && values.filter((v) => v > 0).length >= 2;
}

// ---------------------------------------------------------------------------------------------
// Keyboard model (roving tabindex)

export const NAV_KEYS: readonly string[] = [
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
  "PageUp",
  "PageDown",
];

export interface NavShape {
  /** Total slots, padding included. */
  count: number;
  /** Slots that take focus; defaults to all. */
  enabled?: (index: number) => boolean;
  /** Slots per column for a grid (the calendar's 7); omit for a single row of bars. */
  rows?: number;
  /** Right-to-left: the right arrow goes back in time. */
  rtl?: boolean;
}

/**
 * The slot to focus after `key`, or `null` when the key is not a navigation key or nothing
 * changes. Arrow keys are visual: in a row, → is later in LTR and earlier in RTL; in a grid ↑/↓
 * move within a week, ←/→ across weeks (±rows). Home/End jump to the first/last enabled slot,
 * PageUp/PageDown move four columns (or ten bars). A move past the end or onto padding settles
 * on the nearest enabled slot on the way back, or stays.
 */
export function moveFocus(from: number, key: string, shape: NavShape): number | null {
  const { count, rows, rtl = false } = shape;
  const enabled = shape.enabled ?? (() => true);
  const horizontal = rows ?? 1;
  const dir = rtl ? -1 : 1;
  let step: number;
  switch (key) {
    case "ArrowRight":
      step = dir * horizontal;
      break;
    case "ArrowLeft":
      step = -dir * horizontal;
      break;
    case "ArrowDown":
      if (rows === undefined) return null;
      step = 1;
      break;
    case "ArrowUp":
      if (rows === undefined) return null;
      step = -1;
      break;
    case "PageDown":
      step = dir * horizontal * (rows === undefined ? 10 : 4);
      break;
    case "PageUp":
      step = -dir * horizontal * (rows === undefined ? 10 : 4);
      break;
    case "Home":
    case "End": {
      const order = Array.from({ length: count }, (_, i) => i).filter(enabled);
      const target = key === "Home" ? order[0] : order.at(-1);
      return target === undefined || target === from ? null : target;
    }
    default:
      return null;
  }
  const goal = Math.max(0, Math.min(count - 1, from + step));
  const unit = Math.sign(goal - from);
  for (let i = goal; unit !== 0 && i !== from; i -= unit) {
    if (enabled(i)) return i;
  }
  return null;
}
