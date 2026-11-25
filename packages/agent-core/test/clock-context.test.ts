import { describe, expect, it } from "vitest";
import { clockContextProvider, clockLine, parseAtInstant, scheduleTool } from "../src/index.ts";

describe("clock context", () => {
  const now = Date.parse("2026-11-25T23:42:00Z");

  it("carries the local date, time and zone", () => {
    const line = clockLine(now, "America/Los_Angeles");
    expect(line).toContain("Wednesday 2026-11-25");
    expect(line).toContain("15:42");
    expect(line).toContain("America/Los_Angeles");
    expect(line).toContain("UTC-08:00");
    expect(line).toMatch(/Never ask the owner for their time zone/);
  });

  it("follows the zone: the same instant is already tomorrow in Tokyo", () => {
    const line = clockLine(now, "Asia/Tokyo");
    expect(line).toContain("Thursday 2026-11-26");
    expect(line).toContain("08:42");
  });

  it("an unknown zone reads as UTC instead of failing", () => {
    expect(clockLine(now, "Not/AZone")).toContain("23:42");
  });

  it("is a trusted turn-context section, so it adds no taint, and is read at each turn", async () => {
    let t = now;
    const p = clockContextProvider({ now: () => t, timeZone: () => "America/Los_Angeles" });
    const first = await p.provide({} as never);
    expect(first?.trusted).toBe(true);
    expect(first?.sections[0]?.text).toContain("15:42");
    t += 60_000;
    expect((await p.provide({} as never))?.sections[0]?.text).toContain("15:43");
  });
});

describe("parseAtInstant", () => {
  it("reads a bare local time in the zone, with DST", () => {
    expect(parseAtInstant("2026-11-26T09:00", "America/Los_Angeles")).toBe(
      Date.parse("2026-11-26T17:00:00Z"),
    );
    expect(parseAtInstant("2026-07-01T09:00:00", "America/Los_Angeles")).toBe(
      Date.parse("2026-07-01T16:00:00Z"),
    );
  });
  it("keeps an explicit offset and refuses non-times", () => {
    expect(parseAtInstant("2026-11-26T09:00:00+01:00", "Asia/Tokyo")).toBe(
      Date.parse("2026-11-26T08:00:00Z"),
    );
    expect(parseAtInstant("tomorrow at 9", "UTC")).toBeUndefined();
  });
});

describe("schedule tool, one-time form", () => {
  it("`at` makes a reminder that fires once, in the owner's zone", async () => {
    const made: Record<string, unknown>[] = [];
    const tool = scheduleTool(
      {
        create: async (a: Record<string, unknown>) => {
          made.push(a);
          return { id: "a1", nextRunAt: null };
        },
      } as never,
      "America/Los_Angeles",
    );
    await tool.run?.(
      { title: "Reminder: stretch", at: "2026-11-25T15:44", prompt: "Tell the owner to stretch" },
      { threadId: "t1" } as never,
    );
    expect(made[0]).toMatchObject({
      kind: "reminder",
      schedule: "2026-11-25T23:44:00.000Z",
      timezone: "America/Los_Angeles",
    });
  });

  it("needs a time: neither `at` nor kind and schedule is refused", async () => {
    const tool = scheduleTool({ create: async () => ({}) } as never, "UTC");
    await expect(
      tool.run?.({ title: "x", prompt: "y" }, { threadId: "t1" } as never),
    ).rejects.toThrow(/at/);
  });
});
