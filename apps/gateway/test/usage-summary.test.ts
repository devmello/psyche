import { createRun, createThread, openDb, type PsycheDb, setSetting, updateRun } from "@psyche/db";
import type { ProviderConfig } from "@psyche/model-router";
import { EMPTY_USAGE, type MethodResult } from "@psyche/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BUDGET_KEY, runTokens, usageSummaryHandlers } from "../src/compose/usage-summary.ts";

const NOW = new Date("2026-10-25T18:00:00.000Z");
const providers = [
  { id: "anthropic", kind: "anthropic" },
  { id: "claude-code", kind: "claude-code" },
] as unknown as ProviderConfig[];

let db: PsycheDb;
let threadId: string;

beforeEach(() => {
  db = openDb(":memory:");
  threadId = createThread(db, { kind: "main", sessionKey: "owner:main" }).id;
});
afterEach(() => db.close());

function run(modelRef: string, startedAt: string, input: number, output: number, costUsd: number) {
  const r = createRun(db, { threadId, modelRef, startedAt });
  updateRun(db, r.id, { usage: { ...EMPTY_USAGE, input, output, cacheRead: 999, costUsd } });
}

function summary(params: { days?: number; timeZone?: string } = {}) {
  const h = usageSummaryHandlers({
    db,
    providers,
    primary: () => "anthropic/claude-sonnet-5-5",
    now: () => NOW,
  });
  return h["usage.summary"]?.run({} as never, params as never) as MethodResult<"usage.summary">;
}

describe("usage.summary (#599)", () => {
  it("counts today, the window by day and model, and the month, in the owner's time zone", () => {
    run("anthropic/claude-sonnet-5-5", "2026-10-25T09:00:00.000Z", 1000, 500, 0.12);
    run("anthropic/claude-sonnet-5-5", "2026-10-25T17:00:00.000Z", 2000, 1000, 0.3);
    run("claude-code/sonnet", "2026-10-25T10:00:00.000Z", 4000, 1000, 0);
    run("anthropic/claude-sonnet-5-5", "2026-10-22T12:00:00.000Z", 100, 100, 0.01);
    run("anthropic/claude-sonnet-5-5", "2026-10-02T12:00:00.000Z", 100, 100, 0.5); // month only
    run("anthropic/claude-sonnet-5-5", "2026-09-30T12:00:00.000Z", 100, 100, 9); // outside both
    const s = summary({ timeZone: "America/Los_Angeles" });
    expect(s.days).toHaveLength(7);
    expect(s.days.at(-1)?.date).toBe("2026-10-25");
    expect(s.days[0]?.date).toBe("2026-10-19");
    expect(s.today).toMatchObject({ turns: 3, tokens: 12_497, costUsd: 0.42 });
    // Cache reads count, as in the chat's own usage (each run here carries 999 cached tokens).
    expect(s.today.byModel.map((m) => [m.modelRef, m.subscription, m.tokens])).toEqual([
      ["anthropic/claude-sonnet-5-5", false, 6498],
      ["claude-code/sonnet", true, 5999],
    ]);
    expect(s.days.find((d) => d.date === "2026-10-22")).toMatchObject({ turns: 1, tokens: 1199 });
    expect(s.byModel.find((m) => m.modelRef === "anthropic/claude-sonnet-5-5")?.turns).toBe(3);
    expect(s.month).toMatchObject({ turns: 5, costUsd: 0.93 });
    expect(s.budgetUsd).toBeNull();
    expect(s.planWindow).toBeNull();
    expect(s.primary).toBe("anthropic/claude-sonnet-5-5");
  });

  it("days follow the time zone: 01:00 UTC is yesterday in Los Angeles", () => {
    run("anthropic/claude-sonnet-5-5", "2026-10-25T01:00:00.000Z", 10, 10, 0.01);
    expect(summary({ timeZone: "UTC" }).today.turns).toBe(1);
    expect(summary({ timeZone: "America/Los_Angeles" }).today.turns).toBe(0);
  });

  it("reads the monthly budget setting and refuses an unknown time zone", () => {
    setSetting(db, BUDGET_KEY, 50);
    expect(summary({ days: 1 }).budgetUsd).toBe(50);
    expect(summary({ days: 1 }).days).toHaveLength(1);
    expect(() => summary({ timeZone: "Mars/Olympus" })).toThrow(/time zone/);
  });
});

describe("runTokens", () => {
  it("sums every field the chat's own usage sums, cache included", () => {
    expect(
      runTokens({
        input: 1,
        output: 2,
        cacheRead: 4,
        cacheWrite: 8,
        reasoning: 16,
        costUsd: 0.5,
      }),
    ).toBe(31);
    expect(runTokens(EMPTY_USAGE)).toBe(0);
  });

  it("a day's chip equals the sum of its runs, counted in the owner's local day", () => {
    // 23:30 on the 24th in Los Angeles is already the 25th UTC: it belongs to the 24th locally.
    run("anthropic/claude-sonnet-5-5", "2026-10-25T06:30:00.000Z", 10, 5, 0.01);
    run("anthropic/claude-sonnet-5-5", "2026-10-25T18:00:00.000Z", 100, 50, 0.1);
    const la = summary({ timeZone: "America/Los_Angeles" });
    expect(la.today).toMatchObject({ turns: 1, tokens: 100 + 50 + 999, costUsd: 0.1 });
    const utc = summary({ timeZone: "UTC" });
    expect(utc.today).toMatchObject({ turns: 2, costUsd: 0.11 });
  });
});
