import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FakeModelProvider } from "@psyche/testing";
import { describe, expect, it } from "vitest";
import { runScenario, SCENARIOS_DIR } from "../../../packages/testing/src/scenarios/index.ts";
import { runScenarioLive } from "./driver.ts";
import { LIVE_TOOL_SPECS } from "./tool-specs.ts";

/**
 * The live driver's plumbing, checked in CI without model keys: the scenario scripts are replayed
 * through a `FakeModelProvider` standing in for the live model, over the driver's own step loop,
 * settle, approver policy, `liveSeverity` and tool-spec overlay. Every hard assertion the scripted
 * runner passes must pass here too (the known V7 failures stay known).
 */

const known = JSON.parse(
  readFileSync(join(SCENARIOS_DIR, "known-failures.json"), "utf8"),
) as Record<string, Record<string, string>>;

const hardFailures = (r: { assertions: { id: string; severity: string; status: string }[] }) =>
  r.assertions.filter((a) => a.severity === "hard" && a.status === "fail").map((a) => a.id);

describe("live driver plumbing (scripted provider through the live code path)", () => {
  it("describes every tool in the shared registry", () => {
    const tools = JSON.parse(readFileSync(join(SCENARIOS_DIR, "shared/tools.json"), "utf8"))
      .tools as { name: string }[];
    for (const t of tools) expect(LIVE_TOOL_SPECS[t.name], t.name).toBeDefined();
  });

  for (const id of ["v1-inbox-triage", "v2-calendar-planning", "v7-research-brief"]) {
    it(`${id}: reaches the scripted runner's outcome`, async () => {
      const dir = join(SCENARIOS_DIR, id);
      expect(existsSync(dir)).toBe(true);
      const scripted = await runScenario(dir);
      const fake = new FakeModelProvider({ id: "fake" });
      const r = await runScenarioLive(dir, {
        provider: fake,
        model: "fake/main",
        script: true,
        stepTimeoutMs: 60_000,
      });
      expect(r.mode).toBe("live");
      // Known failures (tests/scenarios/known-failures.json) are the only hard failures allowed,
      // minus the scripted runner's own script-divergence checks (`runner/*`), which live mode
      // has no equivalent for.
      const expected = Object.keys(known[id] ?? {}).filter((k) => !k.startsWith("runner/"));
      expect(hardFailures(r)).toEqual(expected);
      // Live mode ran at least every step the scripted runner ran minus the scripted-only ones.
      const ran = r.steps.filter((s) => s.status === "ran").length;
      const scriptedRan = scripted.steps.filter((s) => s.status === "ran").length;
      expect(ran).toBeGreaterThanOrEqual(scriptedRan - 2);
      expect(ran).toBeLessThanOrEqual(scriptedRan);
      expect(r.calls.length).toBeGreaterThan(0);
      expect(r.summary.hard.unchecked).toBe(0);
    });
  }
});
