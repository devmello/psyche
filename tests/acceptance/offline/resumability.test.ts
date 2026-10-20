import { describe, expect, it } from "vitest";
import {
  enumerateKillPoints,
  exploreKillPoints,
  type KillPointResult,
  runWithKill,
} from "../../../packages/testing/src/resumability/index.ts";
import { writeReport } from "../src/report.ts";
import {
  M2_SCENARIO_IDS,
  SCENARIO_IDS,
  type ScenarioScript,
  scenarioScript,
} from "../src/scenario-scripts.ts";

/**
 * Resumability against the real stack (SQLite task engine, worker pool, agent loop, Permission
 * Broker, receipts): the happy path of V1, V2, V3, V4 and V7 killed at the scenarios' `randomKills`
 * seeded random kill points (8 + 8 + 4 + 4 + 9 = 33 across V1, V2, V3, V4, V7), plus an uninterrupted baseline per
 * scenario; then the Milestone 2 scenarios V5, V6, V8 and V9 the same way (4 each, 16 more). docs/03 "Resumability": every kill resumes or ends with a correct receipt state, never
 * a duplicate side effect; docs/05 §3.7 and §3.11 for re-issued cards and `uncertain` steps.
 */

/** One seed per scenario, so the sample is the same on every machine and in CI. */
const SEEDS: Record<string, number> = {
  "v1-inbox-triage": 1,
  "v2-calendar-planning": 2,
  "v3-shopping": 3,
  "v4-travel": 4,
  "v7-research-brief": 7,
  "v5-permission-slip": 5,
  "v6-messages-voice-note": 6,
  "v8-subscription-audit": 8,
  "v9-weekly-review": 9,
};

interface ScenarioSweep {
  scenario: string;
  steps: number;
  killPoints: number;
  sampled: number;
  excluded: Record<string, string>;
  baseline: { ok: boolean; violations: string[]; effects: string[] };
  results: { killPoint: string; outcome: string; violations: string[] }[];
}

const sweeps: ScenarioSweep[] = [];
const violations = (r: { violations: { code: string; message: string }[] }) =>
  r.violations.map((v) => `${v.code}: ${v.message}`);

async function sweep(s: ScenarioScript): Promise<ScenarioSweep> {
  const options = { script: s.script, tools: s.tools, policy: s.policy };
  const baseline = await runWithKill(options);
  const results: KillPointResult[] = await exploreKillPoints({
    ...options,
    sample: s.randomKills,
    seed: SEEDS[s.id],
  });
  return {
    scenario: s.id,
    steps: s.script.steps.length,
    killPoints: enumerateKillPoints(s.script, s.tools).length,
    sampled: results.length,
    excluded: s.excluded,
    baseline: {
      ok: baseline.violations.length === 0 && baseline.task?.status === "done",
      violations: violations(baseline),
      effects: baseline.ledger.map((e) => `${e.step}=${e.providerId}`),
    },
    results: results.map((r) => ({
      killPoint: r.killPoint,
      outcome: r.outcome,
      violations: violations(r),
    })),
  };
}

const ALL_IDS = [...SCENARIO_IDS, ...M2_SCENARIO_IDS];

describe("resumability sweep over the acceptance scenarios (real stack)", () => {
  for (const id of ALL_IDS) {
    describe(id, () => {
      const s = scenarioScript(id);

      it("derives a happy-path script from the scenario", () => {
        const calls = s.script.steps.filter((st) => "tool" in st);
        expect(calls.length).toBeGreaterThan(3);
        expect(s.randomKills).toBeGreaterThan(0);
        expect(enumerateKillPoints(s.script, s.tools).length).toBeGreaterThan(s.randomKills);
      });

      it(`runs to completion once and survives ${s.randomKills} random kills`, async () => {
        const r = await sweep(s);
        sweeps.push(r);
        expect(r.baseline.violations).toEqual([]);
        expect(r.baseline.ok).toBe(true);
        expect(r.sampled).toBe(s.randomKills);
        expect(r.results.filter((x) => x.violations.length > 0)).toEqual([]);
      });
    });
  }

  it("records the sweep (33 kill points across V1, V2, V3, V4, V7; 16 across V5, V6, V8, V9)", () => {
    const m1 = new Set<string>(SCENARIO_IDS);
    const total = sweeps.reduce((n, s) => n + s.sampled, 0);
    const m1Total = sweeps.filter((s) => m1.has(s.scenario)).reduce((n, s) => n + s.sampled, 0);
    writeReport("resumability", {
      stack: [
        "@psyche/tasks SqliteTaskEngine + TaskWorkerPool",
        "@psyche/agent-core loop",
        "@psyche/permissions PsychePermissionBroker (SqlitePermissionStore)",
        "@psyche/audit receipts (SqliteReceiptStore)",
      ],
      total,
      milestone1: m1Total,
      milestone2: total - m1Total,
      ok: sweeps.every((s) => s.baseline.ok && s.results.every((r) => r.violations.length === 0)),
      scenarios: sweeps,
    });
    expect(sweeps).toHaveLength(ALL_IDS.length);
    expect(m1Total).toBe(33);
    expect(total - m1Total).toBe(16);
  });
});
