import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { modelSetupFromEnv } from "@psyche/gateway/compose";
import { createModelRouter } from "@psyche/model-router";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OUT_DIR, writeReport } from "../src/report.ts";
import { type LiveReport, runScenarioLive } from "./driver.ts";
import { LIVE_SCENARIO_IDS, scenarioSetup } from "./setup.ts";

/**
 * Live model gates (docs/08 Milestones 1 to 3 "Acceptance"): V1 to V10 on a real model, three
 * runs each, through the live driver. Opt in with
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
const SCENARIOS = (process.env.PSYCHE_LIVE_SCENARIOS ?? LIVE_SCENARIO_IDS.join(","))
  .split(",")
  .map((x) => x.trim())
  .filter((x) => x !== "");

const runs: LiveReport[] = [];

/** Error text from a provider may echo a credential; never print anything key-shaped. */
const redact = (text: string) =>
  text.replace(/\b(sk|xai|gsk|AIza)[-_A-Za-z0-9]{8,}/g, "[redacted]");
const slug = MODEL.replace(/[^a-z0-9.-]+/gi, "-");

interface RunRow {
  scenario: string;
  ok: boolean;
  summary: LiveReport["summary"];
  hardFailures: string[];
  softFailures: string[];
  steps: LiveReport["steps"];
  calls: LiveReport["calls"];
  cards: LiveReport["cards"];
  questions: LiveReport["questions"];
  answers: LiveReport["answers"];
  texts: LiveReport["texts"];
  runInfo: LiveReport["runs"];
  followUps: LiveReport["followUps"];
}

/**
 * One report per model. A run of some scenarios (`PSYCHE_LIVE_SCENARIOS`) replaces those
 * scenarios' rows in the existing report and keeps the others, so the scorecard can be filled
 * scenario by scenario.
 */
afterAll(() => {
  // Nothing ran (the provider check failed): keep the last report as it is.
  if (!LIVE || runs.length === 0) return;
  const path = join(OUT_DIR, `live-${slug}.json`);
  const previous: RunRow[] = existsSync(path)
    ? ((JSON.parse(readFileSync(path, "utf8")) as { runs?: RunRow[] }).runs ?? [])
    : [];
  const kept = previous.filter((r) => !SCENARIOS.includes(r.scenario));
  const fresh: RunRow[] = runs.map((r) => ({
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
    cards: r.cards,
    questions: r.questions,
    answers: r.answers,
    texts: r.texts,
    runInfo: r.runs,
    followUps: r.followUps,
  }));
  const all = [...kept, ...fresh].sort((a, b) => a.scenario.localeCompare(b.scenario));
  writeReport(`live-${slug}`, {
    model: MODEL,
    repeats: REPEATS,
    ok: all.every((r) => r.ok),
    runs: all,
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

  // One tiny request first: a refused key or an unreachable model fails here with the provider's
  // reason, instead of as a page of assertions about calls that never happened.
  beforeAll(async () => {
    if (provider === undefined) throw new Error("no model provider");
    let error: string | undefined;
    for await (const ev of provider.stream({
      model: "router/primary",
      messages: [{ role: "user", parts: [{ type: "text", text: "Reply with OK." }] }],
      maxOutputTokens: 8,
    }))
      if (ev.type === "finish" && ev.reason === "error") error = String(ev.error ?? "error");
    if (error !== undefined) {
      const reason = redact(error);
      // Record the refusal next to the earlier runs, so the scorecard says why nothing ran.
      const path = join(OUT_DIR, `live-${slug}.json`);
      const previous = existsSync(path)
        ? (JSON.parse(readFileSync(path, "utf8")) as { runs?: unknown[] }).runs
        : undefined;
      writeReport(`live-${slug}`, {
        model: MODEL,
        repeats: REPEATS,
        blocked: { at: new Date().toISOString().slice(0, 10), reason },
        ok: false,
        runs: previous ?? [],
      });
      throw new Error(`${MODEL} refused a one-line request: ${reason}`);
    }
  }, 60_000);

  for (const scenario of SCENARIOS) {
    for (let run = 1; run <= REPEATS; run += 1) {
      it(`${scenario} run ${run}/${REPEATS} passes every hard assertion`, async () => {
        if (provider === undefined) throw new Error("no model provider");
        const world = await scenarioSetup(scenario, { live: true });
        try {
          const r = await runScenarioLive(world.dir, {
            ...(world.overrides === undefined ? {} : { overrides: world.overrides }),
            ...(world.mutate === undefined ? {} : { mutate: world.mutate }),
            provider,
            model: "router/primary",
            log: (line) => process.stderr.write(`${line}\n`),
          });
          // What the scenario file cannot check live (V10: the pushed commit is the approved one).
          for (const [i, detail] of ((await world.check?.()) ?? []).entries()) {
            r.assertions.push({
              id: `extra/${i}`,
              type: "extra",
              severity: "hard",
              status: "fail",
              detail,
            });
            r.summary.hard.fail += 1;
            r.ok = false;
          }
          runs.push(r);
          const hard = r.assertions
            .filter((a) => a.severity === "hard" && a.status === "fail")
            .map((a) => `${a.id}: ${a.detail}`);
          expect(hard).toEqual([]);
        } finally {
          world.dispose();
        }
      });
    }
  }
});
