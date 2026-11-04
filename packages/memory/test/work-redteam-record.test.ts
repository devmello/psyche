import { writeFileSync } from "node:fs";
import type { ModelEvent, ModelProvider } from "@psyche/protocol";
import { createLiveHaikuProvider } from "@psyche/testing";
import { describe, expect, it } from "vitest";
import { callWorkExtractor } from "../src/extraction/index.ts";
import { loadWorkCases, WORK_RECORDING, workItemsFor } from "./work-redteam-support.ts";

/**
 * Re-records `redteam-recordings/work-cloud.json` from real Haiku 5.5 replies to the work-lane
 * prompt. LIVE and on demand only:
 *
 *   RECORD_REDTEAM=1 pnpm --filter @psyche/memory exec vitest run --maxWorkers=1 test/work-redteam-record.test.ts
 *
 * Every lane case goes through `callWorkExtractor` with the live provider in place of the fake and
 * the deterministic screen bypassed (so the validator alone is what the replay tests). The raw
 * text of the reply is stored. The key comes from `ANTHROPIC_API_KEY` or the nearest `.env` and is
 * never written anywhere. No local model is run.
 */
describe.skipIf(process.env.RECORD_REDTEAM !== "1")("record work red-team replies (live)", () => {
  it("records every lane case", { timeout: 10 * 60_000 }, async () => {
    const live = createLiveHaikuProvider();
    const responses: Record<string, string> = {};
    const cases = loadWorkCases().filter((c) => c.kind === "lane" && c.flood === undefined);
    for (const c of cases) {
      let text = "";
      const recording: ModelProvider = {
        ...live,
        async *stream(req, opts) {
          for await (const e of live.stream(req, opts)) {
            if (e.type === "text_delta") text += e.text;
            yield e as ModelEvent;
          }
        },
      };
      await callWorkExtractor({
        provider: recording,
        model: "anthropic/claude-haiku-5-5",
        items: workItemsFor(c),
      });
      responses[c.id] = text;
    }
    expect(Object.keys(responses).length).toBe(cases.length);
    writeFileSync(
      WORK_RECORDING,
      `${JSON.stringify(
        {
          kind: "work-cloud",
          synthetic: false,
          model: "anthropic/claude-haiku-5-5",
          recordedAt: new Date().toISOString().slice(0, 10),
          note: "Raw reply of the real model to the real work-lane prompt for every lane case, with the deterministic screen bypassed, so the validator alone is tested. Re-record on demand.",
          usage: { calls: live.usage.calls, input: live.usage.input, output: live.usage.output },
          responses,
        },
        null,
        1,
      )}\n`,
    );
    process.stdout.write(
      `recorded ${cases.length} work cases, ${live.usage.calls} calls, ${live.usage.input} in / ${live.usage.output} out tokens\n`,
    );
  });
});
