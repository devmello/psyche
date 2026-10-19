import { openDb } from "@psyche/db";
import { FakeClock } from "@psyche/testing";
import { describe, expect, it } from "vitest";
import {
  type BudgetAlert,
  InMemoryUsageRepository,
  monthRange,
  SqliteUsageRepository,
  UsageLedger,
  type UsageRepository,
} from "../src/index.ts";

const u = (costUsd: number) => ({
  input: 100,
  output: 50,
  cacheRead: 10,
  cacheWrite: 5,
  reasoning: 20,
  costUsd,
});

function ledger(repo: UsageRepository, budgetUsd?: number) {
  const clock = new FakeClock(Date.UTC(2026, 9, 19, 12));
  const alerts: BudgetAlert[] = [];
  let n = 0;
  const opts: ConstructorParameters<typeof UsageLedger>[0] = {
    repo,
    clock,
    newId: () => `usage_${String(++n).padStart(4, "0")}`,
    onBudgetAlert: (a) => alerts.push(a),
  };
  if (budgetUsd !== undefined) opts.budgetUsd = budgetUsd;
  return { l: new UsageLedger(opts), clock, alerts };
}

describe("UsageLedger", () => {
  it("summarizes the month by model with budget percentages", async () => {
    const { l } = ledger(new InMemoryUsageRepository(), 10);
    await l.record({ modelRef: "anthropic/claude-sonnet-5-5", usage: u(1.5), runId: "run_1" });
    await l.record({ modelRef: "anthropic/claude-sonnet-5-5", usage: u(0.5) });
    await l.record({ modelRef: "ollama/qwen3.8:27b", usage: u(0) });
    const s = await l.summary();
    expect(s.calls).toBe(3);
    expect(s.totals).toEqual({
      input: 300,
      output: 150,
      cacheRead: 30,
      cacheWrite: 15,
      reasoning: 60,
      costUsd: 2,
    });
    expect(s.byModel.map((m) => [m.modelRef, m.calls])).toEqual([
      ["anthropic/claude-sonnet-5-5", 2],
      ["ollama/qwen3.8:27b", 1],
    ]);
    expect(s.usedPercent).toBe(20);
    expect(s.remainingPercent).toBe(80);
  });

  it("fires each budget threshold once per month", async () => {
    const { l, alerts, clock } = ledger(new InMemoryUsageRepository(), 10);
    await l.record({ modelRef: "openai/gpt-6.1-sol", usage: u(7.9) });
    expect(alerts).toEqual([]);
    await l.record({ modelRef: "openai/gpt-6.1-sol", usage: u(0.2) });
    expect(alerts.map((a) => a.threshold)).toEqual([0.8]);
    await l.record({ modelRef: "openai/gpt-6.1-sol", usage: u(0.1) });
    expect(alerts).toHaveLength(1);
    await l.record({ modelRef: "openai/gpt-6.1-sol", usage: u(2) });
    expect(alerts.map((a) => [a.month, a.threshold])).toEqual([
      ["2026-10", 0.8],
      ["2026-10", 1],
    ]);
    clock.set(Date.UTC(2026, 10, 1, 0, 0, 1));
    await l.record({ modelRef: "openai/gpt-6.1-sol", usage: u(1) });
    expect(alerts).toHaveLength(2);
    expect((await l.summary()).totals.costUsd).toBe(1);
  });

  it("does not re-announce thresholds crossed before start-up", async () => {
    const repo = new InMemoryUsageRepository();
    const first = ledger(repo, 10);
    await first.l.record({ modelRef: "openai/gpt-6.1-sol", usage: u(9) });
    const second = ledger(repo, 10);
    await second.l.init();
    await second.l.record({ modelRef: "openai/gpt-6.1-sol", usage: u(0.1) });
    expect(second.alerts).toEqual([]);
  });

  it("flags unpriced models", async () => {
    const { l } = ledger(new InMemoryUsageRepository());
    await l.record({ modelRef: "openai/brand-new", usage: u(0), unpriced: true });
    expect((await l.summary()).unpricedModels).toEqual(["openai/brand-new"]);
  });

  it("uses UTC month boundaries", () => {
    expect(monthRange(Date.UTC(2026, 11, 31, 23, 59))).toEqual({
      from: "2026-12-01T00:00:00.000Z",
      to: "2027-01-01T00:00:00.000Z",
      month: "2026-12",
    });
  });
});

describe("SqliteUsageRepository", () => {
  it("writes rows to the usage table and aggregates them", async () => {
    const db = openDb(":memory:");
    try {
      const { l } = ledger(new SqliteUsageRepository(db.sqlite), 4);
      await l.record({ modelRef: "anthropic/claude-haiku-5-5", usage: u(0.25), job: "feed.rank" });
      await l.record({ modelRef: "anthropic/claude-haiku-5-5", usage: u(0.75) });
      const rows = db.sqlite.prepare("SELECT * FROM usage ORDER BY id").all() as Record<
        string,
        unknown
      >[];
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({
        model_ref: "anthropic/claude-haiku-5-5",
        job: "feed.rank",
        cache_read: 10,
        cost_usd: 0.25,
      });
      const s = await l.summary();
      expect(s.totals.costUsd).toBe(1);
      expect(s.usedPercent).toBe(25);
    } finally {
      db.close();
    }
  });
});
