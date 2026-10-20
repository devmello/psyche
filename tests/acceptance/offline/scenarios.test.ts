import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runAllScenarios, SCENARIOS_DIR } from "../../../packages/testing/src/scenarios/index.ts";
import { writeReport } from "../src/report.ts";

/**
 * V1 inbox triage, V2 calendar planning and V7 research brief in scripted mode (S18's runner:
 * real agent loop, Permission Broker, audit chain and receipts; scripted model, fixture Gmail,
 * Calendar, search and sites, frozen clock). Hard assertions gate; the ones listed in
 * tests/scenarios/known-failures.json are tracked by issue and must keep failing until fixed.
 */

type Known = Record<string, Record<string, string>>;

const knownPath = join(SCENARIOS_DIR, "known-failures.json");
const known: Known = existsSync(knownPath) ? JSON.parse(readFileSync(knownPath, "utf8")) : {};

describe("acceptance scenarios, scripted mode", () => {
  it("V1, V2, V3 and V7 pass every hard assertion that is not a tracked known failure", async () => {
    const report = await runAllScenarios();
    const rows = report.scenarios.map((s) => {
      const tracked = known[s.scenario] ?? {};
      const hardFails = s.assertions.filter((a) => a.severity === "hard" && a.status === "fail");
      const softFails = s.assertions.filter((a) => a.severity === "soft" && a.status === "fail");
      return {
        scenario: s.scenario,
        hard: s.summary.hard,
        soft: s.summary.soft,
        unexpected: hardFails
          .filter((a) => tracked[a.id] === undefined)
          .map((a) => `${a.id}: ${a.detail}`),
        known: hardFails
          .filter((a) => tracked[a.id] !== undefined)
          .map((a) => ({ id: a.id, detail: a.detail, issue: tracked[a.id] })),
        stale: Object.keys(tracked).filter(
          (id) => s.assertions.find((a) => a.id === id)?.status !== "fail",
        ),
        softFailures: softFails.map((a) => `${a.id}: ${a.detail}`),
      };
    });
    writeReport("scenarios", {
      mode: "scripted",
      stack: report.scenarios[0]?.stack,
      ok: rows.every((r) => r.unexpected.length === 0 && r.stale.length === 0),
      scenarios: rows,
    });
    expect(rows.map((r) => r.scenario)).toEqual([
      "v1-inbox-triage",
      "v2-calendar-planning",
      "v3-shopping",
      "v7-research-brief",
    ]);
    for (const r of rows) {
      expect(r.unexpected, `${r.scenario}: hard failures without a tracked issue`).toEqual([]);
      expect(r.stale, `${r.scenario}: known failures that no longer fail`).toEqual([]);
      expect(r.hard.unchecked, `${r.scenario}: hard assertions never evaluated`).toBe(0);
    }
  });
});
