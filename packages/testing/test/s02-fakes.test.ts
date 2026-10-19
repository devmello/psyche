import { describe, expect, it } from "vitest";
import { FakeAgentLoop, FakeMemoryStore } from "../src/index.ts";

describe("FakeMemoryStore.flush", () => {
  it("records a private copy and notes remember: lines with the turn's provenance", async () => {
    const memory = new FakeMemoryStore();
    const messages = [
      {
        role: "user" as const,
        parts: [{ type: "text" as const, text: "remember: tea, no sugar" }],
      },
      { role: "assistant" as const, parts: [{ type: "text" as const, text: "remember: ignored" }] },
    ];
    const result = await memory.flush("thr_1", messages, { taint: true });
    expect(result.appended).toBe(1);
    expect(memory.flushes).toHaveLength(1);
    expect(memory.flushes[0]?.taint).toBe(true);
    messages[0]?.parts.splice(0, 1);
    expect(memory.flushes[0]?.messages[0]?.parts).toHaveLength(1);
    const note = await memory.readFile("memory/2026-10-18.md");
    expect(note?.content).toContain("[untrusted] tea, no sugar");
  });
});

describe("FakeAgentLoop.explainContext", () => {
  it("explains recorded runs and returns undefined for unknown ones", async () => {
    const loop = new FakeAgentLoop();
    for await (const _ of loop.startTurn({
      threadId: "thr_1",
      runId: "run_1",
      input: { text: "hi" },
      mode: "attended",
      permissionMode: "balanced",
    })) {
      // drain
    }
    const explanation = await loop.explainContext("run_1");
    expect(explanation?.threadId).toBe("thr_1");
    expect(explanation?.sections[0]?.kind).toBe("base");
    expect(await loop.explainContext("run_missing")).toBeUndefined();
  });
});
