import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SCENARIOS_DIR } from "../../../packages/testing/src/scenarios/index.ts";
import type { StackOverrides } from "../../../packages/testing/src/scenarios/stack.ts";
import type { Scenario } from "../../../packages/testing/src/scenarios/types.ts";
import { m2Overrides } from "../src/m2-world.ts";
import { M3_SCENARIO_IDS, M3_SCENARIOS_DIR, v10World } from "../src/m3-world.ts";
import { M2_SCENARIO_IDS, M2_SCENARIOS_DIR } from "../src/scenario-scripts.ts";

/** Every scenario the live gates run, in order: tests/scenarios, then Milestone 2, then 3. */
export const LIVE_SCENARIO_IDS = [
  "v1-inbox-triage",
  "v2-calendar-planning",
  "v3-shopping",
  "v4-travel",
  "v7-research-brief",
  ...M2_SCENARIO_IDS,
  ...M3_SCENARIO_IDS,
] as const;

/** One scenario's directory, fakes and extra checks for a run (scripted replay or live). */
export interface ScenarioSetup {
  dir: string;
  overrides?: StackOverrides;
  mutate?: (sc: Scenario) => void;
  /** Hard checks the scenario file cannot express (V10: what was pushed), as failure lines. */
  check?: () => Promise<string[]>;
  /** The scenario's known hard failures (by assertion id), as in its known-failures.json. */
  known: string[];
  dispose: () => void;
}

const knownOf = (dir: string, id: string): string[] =>
  Object.keys(
    (
      JSON.parse(readFileSync(join(dir, "known-failures.json"), "utf8")) as Record<
        string,
        Record<string, string>
      >
    )[id] ?? {},
  );

/** Harness workarounds for open product defects, by issue number (`PSYCHE_LIVE_WORKAROUNDS`). */
export const WORKAROUNDS: Record<string, { scenarios: string[]; what: string }> = {
  "414": { scenarios: ["v10-coding-helper"], what: "code.git's schema flattened to one object" },
};

export async function scenarioSetup(
  id: string,
  options: { live?: boolean; workarounds?: readonly string[] } = {},
): Promise<ScenarioSetup> {
  if ((M3_SCENARIO_IDS as readonly string[]).includes(id)) {
    const w = await v10World({
      live: options.live === true,
      ...(options.workarounds === undefined ? {} : { workarounds: options.workarounds }),
    });
    return {
      dir: join(M3_SCENARIOS_DIR, id),
      overrides: w.overrides,
      mutate: w.mutate,
      check: w.check,
      known: knownOf(M3_SCENARIOS_DIR, id),
      dispose: w.dispose,
    };
  }
  if ((M2_SCENARIO_IDS as readonly string[]).includes(id))
    return {
      dir: join(M2_SCENARIOS_DIR, id),
      overrides: m2Overrides(id).overrides,
      known: knownOf(M2_SCENARIOS_DIR, id),
      dispose: () => {},
    };
  return { dir: join(SCENARIOS_DIR, id), known: knownOf(SCENARIOS_DIR, id), dispose: () => {} };
}
