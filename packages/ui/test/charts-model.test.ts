import { describe, expect, it } from "vitest";
import {
  bucketOf,
  bucketRanges,
  computeDelta,
  type DayDatum,
  dayRange,
  layoutBars,
  moveFocus,
  niceMax,
  quantileEdges,
  rampLevel,
  sparklineEligible,
  weekColumns,
} from "../src/components/charts/model.ts";

/** The pure parts of the overview charts (agent-overview-2026 §5.4, §5.7). */

describe("heatmap bucketing", () => {
  it("takes quantile edges from the non-zero days only", () => {
    const days = [0, 0, 0, 1, 2, 2, 3, 4, 5, 6, 8, 9, 12, 20, 31];
    const edges = quantileEdges(days);
    expect(edges).toHaveLength(5);
    expect(edges.at(-1)).toBe(31);
    expect([...edges].sort((a, b) => a - b)).toEqual(edges);
  });

  it("gives a light user fewer, still distinct, buckets", () => {
    expect(quantileEdges([0, 1, 1, 1, 2])).toEqual([1, 2]);
    expect(quantileEdges([0, 0, 3])).toEqual([3]);
    expect(quantileEdges([0, 0])).toEqual([]);
  });

  it("buckets a value by the first edge that holds it, 0 for none", () => {
    const edges = [2, 4, 8, 16, 31];
    expect([0, 1, 2, 3, 8, 9, 31].map((v) => bucketOf(v, edges))).toEqual([0, 1, 1, 2, 3, 4, 5]);
    expect(bucketOf(5, [])).toBe(0);
  });

  it("spreads sparse buckets over the five-step ramp", () => {
    expect([1, 2, 3, 4, 5].map((b) => rampLevel(b, 5))).toEqual([1, 2, 3, 4, 5]);
    expect([1, 2].map((b) => rampLevel(b, 2))).toEqual([1, 5]);
    expect(rampLevel(1, 1)).toBe(5);
    expect(rampLevel(0, 5)).toBe(0);
  });

  it("prints the real ranges for the legend", () => {
    expect(bucketRanges([3, 8, 8.5].slice(0, 2))).toEqual([
      { bucket: 1, level: 1, from: 1, to: 3 },
      { bucket: 2, level: 5, from: 4, to: 8 },
    ]);
    expect(bucketRanges([1, 2])[0]).toMatchObject({ from: 1, to: 1 });
  });
});

describe("calendar layout", () => {
  it("lists every day between two dates", () => {
    expect(dayRange("2025-02-27", "2025-03-02")).toEqual([
      "2025-02-27",
      "2025-02-28",
      "2025-03-01",
      "2025-03-02",
    ]);
  });

  it("pads the first and last week and starts on the chosen weekday", () => {
    // 2025-10-14 is a Tuesday.
    const mon = weekColumns("2025-10-14", "2025-10-20", 1);
    expect(mon).toHaveLength(2);
    expect(mon[0]?.map((c) => c?.date ?? null)).toEqual([
      null,
      "2025-10-14",
      "2025-10-15",
      "2025-10-16",
      "2025-10-17",
      "2025-10-18",
      "2025-10-19",
    ]);
    expect(mon[1]?.filter(Boolean)).toHaveLength(1);
    const sun = weekColumns("2025-10-14", "2025-10-14", 0);
    expect(sun[0]?.[2]).toEqual({ date: "2025-10-14", row: 2 });
    expect(weekColumns("2025-10-14", "2025-10-13")).toEqual([]);
  });
});

describe("stacked bar layout", () => {
  it("rounds the axis to 1, 2, 5 or 10 times a power of ten", () => {
    expect([0, 1, 1.5, 3, 7, 23, 101].map(niceMax)).toEqual([1, 1, 2, 5, 10, 50, 200]);
  });

  it("scales all bars together and takes the 2 px gaps out of the plot", () => {
    const days: DayDatum[] = [
      { date: "2025-10-13", values: { a: 10, b: 10 } },
      { date: "2025-10-14", values: { a: 5, b: 0, c: 5 } },
    ];
    const { max, bars } = layoutBars(days, ["a", "b", "c"], ["a", "b", "c"], 104);
    expect(max).toBe(20);
    // 104 - 2 gaps x 2 = 100 px for 20 units.
    expect(bars[0]?.segments.map((s) => [s.id, s.height, s.gap])).toEqual([
      ["a", 50, 0],
      ["b", 50, 2],
    ]);
    expect(bars[1]?.segments.map((s) => [s.id, s.height, s.gap])).toEqual([
      ["a", 25, 0],
      ["c", 25, 2],
    ]);
  });

  it("re-scales when a series is hidden and survivors keep their order", () => {
    const days: DayDatum[] = [{ date: "2025-10-14", values: { a: 4, b: 100 } }];
    const { max, bars } = layoutBars(days, ["a", "b"], ["a"], 100);
    expect(max).toBe(5);
    expect(bars[0]?.segments.map((s) => s.id)).toEqual(["a"]);
    expect(bars[0]?.total).toBe(4);
  });

  it("lays out an all-zero period without dividing by zero", () => {
    const { max, bars } = layoutBars([{ date: "2025-10-14", values: {} }], ["a"], ["a"], 100);
    expect(max).toBe(1);
    expect(bars[0]?.segments).toEqual([]);
  });
});

describe("delta", () => {
  it("is none without an earlier period, never +∞%", () => {
    expect(computeDelta(5, null)).toEqual({ kind: "none" });
    expect(computeDelta(5, undefined)).toEqual({ kind: "none" });
    expect(computeDelta(5, 0)).toEqual({ kind: "none" });
    expect(computeDelta(5, Number.NaN)).toEqual({ kind: "none" });
  });

  it("is relative to the previous period", () => {
    expect(computeDelta(15, 10)).toEqual({ kind: "up", amount: 5, fraction: 0.5 });
    expect(computeDelta(5, 10)).toEqual({ kind: "down", amount: 5, fraction: 0.5 });
    expect(computeDelta(10, 10)).toEqual({ kind: "flat" });
    expect(computeDelta(0, 10)).toEqual({ kind: "down", amount: 10, fraction: 1 });
  });

  it("draws a sparkline only from two non-zero points", () => {
    expect(sparklineEligible(undefined)).toBe(false);
    expect(sparklineEligible([0, 0, 4, 0])).toBe(false);
    expect(sparklineEligible([0, 1, 0, 4])).toBe(true);
  });
});

describe("keyboard model", () => {
  it("moves along a row by the visual arrow, flipped in RTL", () => {
    const shape = { count: 7 };
    expect(moveFocus(2, "ArrowRight", shape)).toBe(3);
    expect(moveFocus(2, "ArrowLeft", shape)).toBe(1);
    expect(moveFocus(2, "ArrowRight", { ...shape, rtl: true })).toBe(1);
    expect(moveFocus(2, "ArrowLeft", { ...shape, rtl: true })).toBe(3);
    expect(moveFocus(0, "ArrowLeft", shape)).toBeNull();
    expect(moveFocus(6, "ArrowRight", shape)).toBeNull();
    expect(moveFocus(2, "ArrowUp", shape)).toBeNull();
    expect(moveFocus(2, "Enter", shape)).toBeNull();
  });

  it("jumps with Home, End and the page keys", () => {
    const shape = { count: 30 };
    expect(moveFocus(10, "Home", shape)).toBe(0);
    expect(moveFocus(10, "End", shape)).toBe(29);
    expect(moveFocus(0, "Home", shape)).toBeNull();
    expect(moveFocus(10, "PageDown", shape)).toBe(20);
    expect(moveFocus(25, "PageDown", shape)).toBe(29);
    expect(moveFocus(5, "PageUp", shape)).toBe(0);
  });

  it("walks a 7-row grid: up/down within a week, left/right across weeks", () => {
    const shape = { count: 21, rows: 7 };
    expect(moveFocus(9, "ArrowDown", shape)).toBe(10);
    expect(moveFocus(9, "ArrowUp", shape)).toBe(8);
    expect(moveFocus(9, "ArrowRight", shape)).toBe(16);
    expect(moveFocus(9, "ArrowLeft", shape)).toBe(2);
    expect(moveFocus(9, "ArrowRight", { ...shape, rtl: true })).toBe(2);
    expect(moveFocus(16, "PageUp", shape)).toBe(0);
  });

  it("skips padding cells and stops at the last real day", () => {
    // Two weeks; slots 0 and 17..20 are padding.
    const enabled = (i: number) => i >= 1 && i <= 16;
    const shape = { count: 21, rows: 7, enabled };
    expect(moveFocus(10, "ArrowRight", shape)).toBe(16);
    expect(moveFocus(16, "ArrowDown", shape)).toBeNull();
    expect(moveFocus(7, "ArrowLeft", shape)).toBe(1);
    expect(moveFocus(7, "Home", shape)).toBe(1);
    expect(moveFocus(7, "End", shape)).toBe(16);
  });
});
