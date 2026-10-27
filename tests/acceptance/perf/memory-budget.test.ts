import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs deploy script, no declarations
import { compareBudgets, parseFootprint } from "../../../deploy/scripts/memory-budget.mjs";

describe("memory-budget", () => {
  it("reads the footprint line in MiB", () => {
    const out = "====\npsyched [1]: 64-bit    Footprint: 127 MB (16384 bytes per page)\n====\n";
    expect(parseFootprint(out)).toBe(127);
    expect(parseFootprint("x [2]: 64-bit    Footprint: 2048 KB (16384 bytes per page)")).toBe(2);
    expect(parseFootprint("x [2]: 64-bit    Footprint: 1.5 GB (16384 bytes per page)")).toBe(1536);
    expect(parseFootprint("no such process")).toBeUndefined();
  });

  it("flags only the numbers over their limit", () => {
    const limits = { a: 140, b: 36, c: 6.5 };
    expect(compareBudgets({ a: 127, b: 31, c: 5.8 }, limits).over).toEqual([]);
    const bad = compareBudgets({ a: 141, b: undefined, c: 5.8 }, limits);
    expect(bad.over).toHaveLength(1);
    expect(bad.lines[1]).toContain("not measured");
    expect(() => compareBudgets({ z: 1 }, limits)).toThrow(/no "z"/);
  });
});
