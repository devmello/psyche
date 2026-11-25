import type { ModelEvent } from "@psyche/protocol";
import { describe, expect, it } from "vitest";
import { harness, runTurn, say } from "./harness.ts";

const SUMMARY = JSON.stringify({
  facts: ["The launch is on Nov 3."],
  decisions: [],
  openTasks: [],
  pinnedInstructions: [],
  dailyNoteLines: [],
});
const overflow: ModelEvent[] = [
  { type: "finish", reason: "error", error: "context_overflow: prompt is too long" },
];

function overflowing(script: ModelEvent[][]) {
  return harness({
    script,
    loop: { utilityModel: "fake/main", compaction: { keepRecentTurns: 1 } },
  });
}

describe("context overflow recovery", () => {
  it("compacts and retries the step once, then the turn completes", async () => {
    const h = overflowing([say("one"), overflow, say(SUMMARY), say("two")]);
    await runTurn(h, "plan the launch");
    const events = await runTurn(h, "what is next?");
    expect(events.at(-1)).toMatchObject({ type: "end", outcome: "final" });
    // turn 1, the refused call, the summarizer, the retried call.
    expect(h.provider.requests).toHaveLength(4);
    expect((await h.loop.threadState("thr_1")).summary).toBeDefined();
  });

  it("fails as before when the retry overflows again, without a third attempt", async () => {
    const h = overflowing([say("one"), overflow, say(SUMMARY), overflow]);
    await runTurn(h, "plan the launch");
    const events = await runTurn(h, "what is next?");
    expect(events.at(-1)).toMatchObject({ type: "end", outcome: "failed" });
    expect(h.provider.requests).toHaveLength(4);
  });

  it("does not compact for other model errors", async () => {
    const h = overflowing([
      say("one"),
      [{ type: "finish", reason: "error", error: "bad_request: nope" }],
    ]);
    await runTurn(h, "plan the launch");
    const events = await runTurn(h, "what is next?");
    expect(events.at(-1)).toMatchObject({ type: "end", outcome: "failed" });
    expect(h.provider.requests).toHaveLength(2);
  });
});
