import { join } from "node:path";
import { modelSetupFromEnv } from "@psyche/gateway/compose";
import { createModelRouter } from "@psyche/model-router";
import { afterAll, describe, expect, it } from "vitest";
import { SCENARIOS_DIR } from "../../../packages/testing/src/scenarios/index.ts";
import { writeReport } from "../src/report.ts";
import { type LiveReport, runScenarioLive } from "./driver.ts";

/**
 * Live model gates (docs/08 Milestone 1 "Acceptance"): V1, V2 and V7 on a real model, three runs
 * each, through the live driver. Opt in with
 *
 *   PSYCHE_LIVE_TESTS=1 PSYCHE_MODEL=<provider>/<model> pnpm --filter @psyche/acceptance-tests live
 *
 * where the provider's key comes from its usual variable (apps/gateway/src/compose/models.ts):
 *   anthropic/<model>  ANTHROPIC_API_KEY
 *   openai/<model>     OPENAI_API_KEY
 *   google/<model>     GOOGLE_GENERATIVE_AI_API_KEY
 *   openrouter/<model> OPENROUTER_API_KEY
 *   ollama/<model>     no key; PSYCHE_OLLAMA_URL for a non-default Ollama (the model must pass
 *                      S03's `agent-capable` probe; spike 05 recommends qwen3.5:9b, reasoning off)
 * Optional: PSYCHE_UTILITY_MODEL, PSYCHE_LIVE_REPEATS (default 3), PSYCHE_LIVE_SCENARIOS
 * (comma-separated ids). One model per invocation; run it once per provider for the scorecard.
 *
 * Security and correctness assertions stay hard (one failure fails the run); quality assertions
 * are soft and only counted. Each run's report goes to out/acceptance/live-<provider>-<model>.json.
 */

const MODEL = process.env.PSYCHE_MODEL ?? "";
const LIVE = process.env.PSYCHE_LIVE_TESTS === "1" && MODEL !== "";
const REPEATS = Number(process.env.PSYCHE_LIVE_REPEATS ?? 3);
const SCENARIOS = (
  process.env.PSYCHE_LIVE_SCENARIOS ?? "v1-inbox-triage,v2-calendar-planning,v7-research-brief"
)
  .split(",")
  .map((x) => x.trim())
  .filter((x) => x !== "");

const runs: LiveReport[] = [];
const slug = MODEL.replace(/[^a-z0-9.-]+/gi, "-");

afterAll(() => {
  if (!LIVE) return;
  writeReport(`live-${slug}`, {
    model: MODEL,
    repeats: REPEATS,
    ok: runs.every((r) => r.ok),
    runs: runs.map((r) => ({
      scenario: r.scenario,
      ok: r.ok,
      summary: r.summary,
      hardFailures: r.assertions
        .filter((a) => a.severity === "hard" && a.status === "fail")
        .map((a) => `${a.id}: ${a.detail}`),
      softFailures: r.assertions
        .filter((a) => a.severity === "soft" && a.status === "fail")
        .map((a) => `${a.id}: ${a.detail}`),
      steps: r.steps,
      calls: r.calls,
    })),
  });
});

describe.skipIf(!LIVE)(`live gates on ${MODEL || "(no model)"}`, () => {
  const setup = LIVE ? modelSetupFromEnv(process.env) : null;
  if (LIVE && setup === null) throw new Error("PSYCHE_MODEL is not set");
  const provider =
    setup === null || !("router" in setup)
      ? undefined
      : createModelRouter(setup.router, {
          clock: { now: () => Date.now() },
          ...(setup.keys === undefined ? {} : { keys: setup.keys }),
        });

  for (const scenario of SCENARIOS) {
    for (let run = 1; run <= REPEATS; run += 1) {
      it(`${scenario} run ${run}/${REPEATS} passes every hard assertion`, async () => {
        if (provider === undefined) throw new Error("no model provider");
        const r = await runScenarioLive(join(SCENARIOS_DIR, scenario), {
          provider,
          model: "router/primary",
          log: (line) => process.stderr.write(`${line}\n`),
        });
        runs.push(r);
        const hard = r.assertions
          .filter((a) => a.severity === "hard" && a.status === "fail")
          .map((a) => `${a.id}: ${a.detail}`);
        expect(hard).toEqual([]);
      });
    }
  }
});
