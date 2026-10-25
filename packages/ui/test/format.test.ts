import { describe, expect, it } from "vitest";
import { formatRelative } from "../src/lib/format.ts";

const NOW = Date.parse("2026-10-19T12:00:00.000Z");
const at = (ms: number) => new Date(NOW + ms).toISOString();
const MIN = 60_000;
const H = 60 * MIN;
const D = 24 * H;

describe("formatRelative (UI design §4.12)", () => {
  it("reads minutes, then whole hours, then days, then a date", () => {
    expect(formatRelative(at(-10_000), NOW)).toBe("just now");
    expect(formatRelative(at(-41 * MIN), NOW)).toBe("41 min ago");
    expect(formatRelative(at(-(H + 5 * MIN)), NOW)).toBe("1 h 5 min ago");
    expect(formatRelative(at(-5 * H - 20 * MIN), NOW)).toBe("5 h ago");
    expect(formatRelative(at(-D), NOW)).toBe("yesterday");
    expect(formatRelative(at(-4 * D), NOW)).toBe("4 days ago");
    expect(formatRelative(at(-17 * D - 1 * H), NOW)).toBe("Oct 2");
  });

  it("reads the future the same way", () => {
    expect(formatRelative(at(41 * MIN), NOW)).toBe("in 41 min");
    expect(formatRelative(at(3 * H), NOW)).toBe("in 3 h");
    expect(formatRelative(at(D + H), NOW)).toBe("tomorrow");
    expect(formatRelative(at(13 * D + 22 * H), NOW)).toBe("on Nov 2");
  });
});

describe("cn keeps the type roles (UI design §4.2)", () => {
  it("does not read the type roles as colours", async () => {
    const { cn } = await import("../src/lib/utils.ts");
    expect(cn("text-caption text-label-secondary")).toBe("text-caption text-label-secondary");
    expect(cn("text-title-1 text-foreground")).toBe("text-title-1 text-foreground");
    expect(cn("text-small", "text-caption")).toBe("text-caption");
  });
});
