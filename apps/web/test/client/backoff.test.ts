import { describe, expect, it } from "vitest";
import { backoffDelay } from "../../src/client/backoff.ts";

describe("backoffDelay", () => {
  it("doubles from the base and caps at max", () => {
    const fixed = { jitter: 0, baseMs: 500, maxMs: 30_000 };
    expect([0, 1, 2, 3].map((a) => backoffDelay(a, fixed))).toEqual([500, 1000, 2000, 4000]);
    expect(backoffDelay(20, fixed)).toBe(30_000);
    expect(backoffDelay(10_000, fixed)).toBe(30_000);
  });

  it("keeps jittered delays within [exp*(1-j), exp]", () => {
    expect(backoffDelay(2, { jitter: 0.5, random: () => 0 })).toBe(1000);
    expect(backoffDelay(2, { jitter: 0.5, random: () => 1 })).toBe(2000);
  });
});
