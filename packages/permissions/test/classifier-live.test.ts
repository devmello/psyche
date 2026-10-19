/**
 * Live evaluation of the model-backed classifier (security §3.8, §7.3): a model may serve auto
 * mode only if it labels no case of eval/classifier-cases.json below its acceptable floor.
 * Skipped unless `PSYCHE_LIVE_TESTS=1` and `ANTHROPIC_API_KEY` are set; spends a few thousand
 * tokens.
 *
 *   PSYCHE_LIVE_TESTS=1 ANTHROPIC_API_KEY=… pnpm --filter @psyche/permissions test classifier-live
 */
import { readFileSync } from "node:fs";
import { AiSdkAdapter, type KeySource } from "@psyche/model-router";
import { ResolvedSecret } from "@psyche/protocol";
import { describe, expect, it } from "vitest";
import {
  type ClassifierCase,
  evaluateClassifier,
  formatEvaluation,
  ModelClassifier,
} from "../src/index.ts";

const LIVE = process.env.PSYCHE_LIVE_TESTS === "1" && process.env.ANTHROPIC_API_KEY !== undefined;
const MODEL = process.env.PSYCHE_LIVE_CLASSIFIER_MODEL ?? "claude-haiku-5-5";

const keys: KeySource = {
  resolve: async (_profile, target) => {
    const v = process.env.ANTHROPIC_API_KEY;
    return v === undefined
      ? undefined
      : new ResolvedSecret(v, { credentialId: "env:ANTHROPIC_API_KEY", target });
  },
  redact: (t) => {
    const v = process.env.ANTHROPIC_API_KEY;
    return v === undefined || v.length === 0 ? t : t.split(v).join("•••");
  },
};

describe.skipIf(!LIVE)(`live classifier: anthropic/${MODEL}`, () => {
  it("labels no evaluation case below its floor", { timeout: 300_000 }, async () => {
    const set = JSON.parse(
      readFileSync(new URL("../eval/classifier-cases.json", import.meta.url), "utf8"),
    ) as {
      cases: ClassifierCase[];
    };
    const adapter = new AiSdkAdapter(
      { id: "anthropic", kind: "anthropic", profiles: [{ id: "env", credential: "{{cred:env}}" }] },
      { keys },
    );
    const e = await evaluateClassifier(
      new ModelClassifier(adapter, `anthropic/${MODEL}`),
      set.cases,
    );
    console.warn(formatEvaluation(e));
    expect(e.unsafe, formatEvaluation(e)).toEqual([]);
  });
});
