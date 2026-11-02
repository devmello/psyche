import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelEvent, ModelProvider } from "@psyche/protocol";
import { createLiveHaikuProvider } from "@psyche/testing";
import { describe, expect, it } from "vitest";
import { callExtractor, runEverythingPass } from "../src/extraction/index.ts";
import { itemsFor, loadCases, REDTEAM_DIR } from "./redteam-support.ts";
import { docFor, makeWorld, settingsWith } from "./third-party-support.ts";

/**
 * Re-records `redteam-recordings/cloud.json` from real Haiku 5.5 replies. LIVE and on demand only:
 *
 *   RECORD_REDTEAM=1 pnpm --filter @psyche/memory exec vitest run --maxWorkers=1 test/redteam-record.test.ts
 *
 * Each non-flood case goes through the real pass (reader, admission, cleaning, screening, prompt,
 * extractor call, validator, sink) with the live provider in place of the fake. The raw text of
 * the reply is stored; a case the screen holds before any model call is stored as `null` (the
 * model never saw it). The key comes from `ANTHROPIC_API_KEY` or the nearest `.env` and is never
 * written anywhere.
 */
describe.skipIf(process.env.RECORD_REDTEAM !== "1")("record red-team replies (live)", () => {
  it("records every case", { timeout: 15 * 60_000 }, async () => {
    const live = createLiveHaikuProvider();
    const responses: Record<string, string | null> = {};
    const cases = loadCases().filter((c) => c.flood === undefined);
    for (const c of cases) {
      const w = await makeWorld();
      try {
        const d = docFor(c);
        w.doc({
          id: `mail:${c.id}`,
          title: d.title,
          body: d.body,
          provenance: d.trust,
          sender: d.trust === "owner" ? null : d.sender,
        });
        const replies: string[] = [];
        const recording: ModelProvider = {
          ...live,
          async *stream(req, opts) {
            let text = "";
            for await (const e of live.stream(req, opts)) {
              if (e.type === "text_delta") text += e.text;
              yield e as ModelEvent;
            }
            replies.push(text);
          },
        };
        await runEverythingPass(
          w.deps({
            settings: settingsWith({}),
            modelFor: () => ({ provider: recording, model: "anthropic/claude-haiku-5-5" }),
          }),
        );
        // The first reply is the one a replay feeds back (a retry would get the same text).
        responses[c.id] = replies[0] ?? null;
      } finally {
        await w.close();
      }
    }
    expect(Object.keys(responses).length).toBe(cases.length);
    const file = join(REDTEAM_DIR, "..", "redteam-recordings", "cloud.json");
    writeFileSync(
      file,
      `${JSON.stringify(
        {
          kind: "cloud",
          synthetic: false,
          model: "anthropic/claude-haiku-5-5",
          recordedAt: new Date().toISOString().slice(0, 10),
          note: "Raw first reply of the real model for each case, through the real extraction pass. null = held by the deterministic screen before any model call. Re-record on demand.",
          usage: { calls: live.usage.calls, input: live.usage.input, output: live.usage.output },
          responses,
        },
        null,
        1,
      )}\n`,
    );
    process.stdout.write(
      `recorded ${cases.length} cases, ${live.usage.calls} calls, ${live.usage.input} in / ${live.usage.output} out tokens\n`,
    );
  });

  it("records every case with the screen bypassed (what the validator alone must hold)", {
    timeout: 15 * 60_000,
  }, async () => {
    const live = createLiveHaikuProvider();
    const responses: Record<string, string> = {};
    const cases = loadCases().filter((c) => c.flood === undefined);
    for (const c of cases) {
      {
        const items = itemsFor(c);
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
        await callExtractor({
          provider: recording,
          model: "anthropic/claude-haiku-5-5",
          items,
          people: [
            { handle: "p0", name: "The Owner", isOwner: true },
            { handle: "p1", name: "Sam Lee", isOwner: false },
            { handle: "p2", name: "Priya Rao", isOwner: false },
          ],
          aboutOthers: true,
        });
        responses[c.id] = text;
      }
    }
    writeFileSync(
      join(REDTEAM_DIR, "..", "redteam-recordings", "cloud-unscreened.json"),
      `${JSON.stringify(
        {
          kind: "cloud-unscreened",
          synthetic: false,
          model: "anthropic/claude-haiku-5-5",
          recordedAt: new Date().toISOString().slice(0, 10),
          note: "Raw reply of the real model to the real third-party extractor prompt for every case, with the deterministic screen bypassed, so the validator alone is tested. about-others on. Re-record on demand.",
          usage: { calls: live.usage.calls, input: live.usage.input, output: live.usage.output },
          responses,
        },
        null,
        1,
      )}\n`,
    );
    process.stdout.write(
      `recorded ${cases.length} unscreened cases, ${live.usage.calls} calls, ${live.usage.input} in / ${live.usage.output} out tokens\n`,
    );
  });
});
