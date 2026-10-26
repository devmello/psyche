import type { AgentEvent, ModelEvent } from "@psyche/protocol";
import { describe, expect, it } from "vitest";
import { REASONING_HOLDBACK, ReasoningSteps } from "../src/index.ts";
import { harness, runTurn, say } from "./harness.ts";

const think = (textDelta: string): ModelEvent => ({
  type: "reasoning",
  provider: "fake",
  data: null,
  textDelta,
});
const envelope = (text: string): ModelEvent => ({
  type: "reasoning",
  provider: "fake",
  data: { v: 1, kind: "reasoning", model: "m", text },
});

/** A provider that thinks in two blocks around a sentence, then answers. */
const reasoningTurn: ModelEvent[] = [
  think("Let me "),
  think("check the calendar."),
  envelope("Let me check the calendar."),
  { type: "text_delta", text: "Checking. " },
  think("Tuesday is free."),
  { type: "text_delta", text: "Tuesday works." },
  { type: "finish", reason: "stop" },
];

const reasoningEvents = (events: AgentEvent[]) =>
  events.flatMap((e) => (e.type === "reasoning" ? [e] : []));

function stepsOf(events: AgentEvent[]) {
  const steps = new Map<string, { text: string; summary?: string; done: boolean }>();
  for (const e of reasoningEvents(events)) {
    const s = steps.get(e.stepId) ?? { text: "", done: false };
    s.text += e.delta ?? "";
    if (e.summary !== undefined) s.summary = e.summary;
    if (e.done === true) s.done = true;
    steps.set(e.stepId, s);
  }
  return [...steps.values()];
}

describe("reasoning steps", () => {
  it("streams one step per contiguous reasoning block, closed before the answer text", async () => {
    const h = harness({ script: [reasoningTurn] });
    const events = await runTurn(h, "when am I free?");
    expect(stepsOf(events)).toEqual([
      { text: "Let me check the calendar.", done: true },
      { text: "Tuesday is free.", done: true },
    ]);
    const firstClose = events.findIndex((e) => e.type === "reasoning" && e.done === true);
    const firstText = events.findIndex((e) => e.type === "chat.delta");
    expect(firstClose).toBeLessThan(firstText);
    expect(
      reasoningEvents(events).every(
        (e) =>
          e.messageId ===
          events.find((x) => x.type === "chat.delta" && "messageId" in x)?.messageId,
      ),
    ).toBe(true);
  });

  it("never puts reasoning text into the transcript; the opaque envelope still round-trips", async () => {
    const h = harness({ script: [reasoningTurn, say("ok")] });
    await runTurn(h, "first");
    await runTurn(h, "second");
    const state = await h.loop.threadState("thr_1");
    const assistant = state.messages[1];
    expect(assistant?.parts.filter((p) => p.type === "reasoning")).toEqual([
      {
        type: "reasoning",
        provider: "fake",
        data: { v: 1, kind: "reasoning", model: "m", text: "Let me check the calendar." },
      },
    ]);
    expect(JSON.stringify(state.messages)).not.toContain("Tuesday is free");
    expect(JSON.stringify(h.provider.requests[1]?.messages)).not.toContain("Tuesday is free");
  });

  it("a provider that emits no reasoning produces no steps", async () => {
    const h = harness({ script: [say("Hello")] });
    expect(reasoningEvents(await runTurn(h, "hi"))).toHaveLength(0);
  });

  it("a summary-only provider gives one closed step with the summary", async () => {
    const h = harness({
      script: [
        [
          { type: "reasoning", provider: "fake", data: null, summary: "Compared three flights." },
          { type: "text_delta", text: "The 7:05." },
          { type: "finish", reason: "stop" },
        ],
      ],
    });
    expect(stepsOf(await runTurn(h, "which flight?"))).toEqual([
      { text: "", summary: "Compared three flights.", done: true },
    ]);
  });

  it("agent.showReasoning off skips the work but keeps the round-trip data", async () => {
    const h = harness({ script: [reasoningTurn], loop: { showReasoning: () => false } });
    const events = await runTurn(h, "when?");
    expect(reasoningEvents(events)).toHaveLength(0);
    const state = await h.loop.threadState("thr_1");
    expect(state.messages[1]?.parts.some((p) => p.type === "reasoning")).toBe(true);
  });

  it("masks a secret split across deltas before any of it is emitted", async () => {
    const secret = "sk-live-0123456789abcdef";
    const h = harness({
      script: [
        [
          think(`The key is ${secret.slice(0, 9)}`),
          think(`${secret.slice(9)} so I will use it.`),
          { type: "text_delta", text: "Done." },
          { type: "finish", reason: "stop" },
        ],
      ],
      loop: { redact: (t) => t.replaceAll(secret, "•••") },
    });
    const events = await runTurn(h, "go");
    for (const e of reasoningEvents(events)) expect(e.delta ?? "").not.toContain("sk-live");
    expect(stepsOf(events)[0]?.text).toBe("The key is ••• so I will use it.");
  });
});

describe("ReasoningSteps", () => {
  it("streams long text as it arrives, holding back only the tail", () => {
    const out: { stepId: string; delta?: string; done?: boolean }[] = [];
    let n = 0;
    const steps = new ReasoningSteps(
      (e) => out.push(e),
      () => `s${++n}`,
    );
    steps.delta("a".repeat(REASONING_HOLDBACK + 50));
    expect(out).toEqual([{ stepId: "s1", delta: "a".repeat(50) }]);
    steps.close();
    expect(out[1]).toEqual({ stepId: "s1", delta: "a".repeat(REASONING_HOLDBACK), done: true });
    steps.close();
    expect(out).toHaveLength(2);
  });
});
