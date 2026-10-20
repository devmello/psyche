import type { ContextUsage, ModelEvent, ModelProvider, ModelRequest } from "@psyche/protocol";
import { describe, expect, it } from "vitest";
import {
  type CompactionInfo,
  createAgentLoop,
  estimateContextTokens,
  hasUnansweredToolCalls,
  parseCompactionSummary,
  STRUCTURED_SUMMARIZER_SYSTEM,
} from "../src/index.ts";
import { endOf, harness, runTurn, say } from "./harness.ts";

/**
 * Context usage per chat, owner-set limits and auto-compaction (owner priority; B7, C2): the
 * provider's exact prompt tokens per turn with a breakdown, limits from the thread or settings
 * with the model's window as the ceiling, a structured summary that keeps the plan, never folding
 * a pending call, and a hard refusal above `maxTokens`.
 */

const sumOf = (u: ContextUsage) =>
  u.breakdown.system +
  u.breakdown.tools +
  u.breakdown.context +
  u.breakdown.history +
  u.breakdown.current;

describe("context accounting", () => {
  it("reports the provider's exact prompt tokens, split by where they came from", async () => {
    const usages: ContextUsage[] = [];
    const h = harness({
      script: [say("hello", { input: 1_234, output: 5 })],
      loop: { onContextUsage: (u) => usages.push(u) },
    });
    await runTurn(h, "hi");
    expect(usages).toHaveLength(1);
    const [u] = usages as [ContextUsage];
    expect(u).toMatchObject({
      promptTokens: 1_234,
      estimated: false,
      peakTokens: 1_234,
      compactions: 0,
    });
    expect(sumOf(u)).toBe(1_234);
    expect(u.breakdown.system).toBeGreaterThan(0);
    expect(u.breakdown.current).toBeGreaterThan(0);
    expect(u.limits).toMatchObject({ compactAt: 0.8, keepRecentTurns: 4, maxTokensFrom: "model" });
  });

  it("falls back to an estimate, marked as such, when the provider reports no input tokens", async () => {
    const usages: ContextUsage[] = [];
    const h = harness({
      script: [say("hello", { input: 0, output: 5 })],
      loop: { onContextUsage: (u) => usages.push(u) },
    });
    await runTurn(h, "hi");
    expect(usages[0]?.estimated).toBe(true);
    expect(usages[0]?.promptTokens).toBeGreaterThan(0);
    expect(sumOf(usages[0] as ContextUsage)).toBe(usages[0]?.promptTokens);
  });
});

describe("owner-set limits", () => {
  it("caps maxTokens at the model's window and refuses a turn that would go over", async () => {
    const usages: ContextUsage[] = [];
    const h = harness({
      contextWindow: 100_000,
      script: [say("never")],
      loop: {
        contextLimits: () => ({ maxTokens: 1_000 }),
        onContextUsage: (u) => usages.push(u),
      },
    });
    const events = await runTurn(h, `huge ${"z".repeat(8_000)}`);
    expect(endOf(events)).toMatchObject({ outcome: "failed", error: "context_limit" });
    expect(h.provider.requests).toHaveLength(0);
    const capped = harness({
      contextWindow: 2_000,
      script: [say("ok")],
      loop: { contextLimits: () => ({ maxTokens: 50_000 }) },
    });
    const u: ContextUsage[] = [];
    const loop = createAgentLoop({
      provider: capped.provider,
      model: "fake/main",
      broker: capped.broker,
      clock: capped.clock,
      contextLimits: () => ({ maxTokens: 50_000 }),
      onContextUsage: (x) => u.push(x),
    });
    for await (const _ of loop.startTurn({
      threadId: "t",
      runId: "r",
      input: { text: "hi" },
      mode: "attended",
      permissionMode: "balanced",
    })) {
      // drain
    }
    expect(u[0]?.limits).toMatchObject({ maxTokens: 2_000, contextWindow: 2_000 });
  });
});

describe("the loop's own compaction policy", () => {
  it("still decides when no owner limits are set, and memory is flushed first", async () => {
    const h = harness({
      // Turns 2 and 3 each compact (keep 1 turn) before their main call.
      script: [
        say("one"),
        say('{"facts":["tea"],"decisions":[],"openTasks":[],"pinnedInstructions":[]}'),
        say("two"),
        say('{"facts":["tea"],"decisions":[],"openTasks":[],"pinnedInstructions":[]}'),
        say("three"),
      ],
      loop: { compaction: { thresholdRatio: 0.000_001, keepRecentTurns: 1 } },
    });
    await runTurn(h, "first");
    await runTurn(h, "second");
    await runTurn(h, "third");
    expect(h.memory.flushes).toHaveLength(2);
    expect((await h.loop.threadState("thr_1")).summary?.structured?.facts).toEqual(["tea"]);
  });
});

describe("structured compaction", () => {
  it("parses the summarizer's JSON and refuses anything else", () => {
    expect(
      parseCompactionSummary(
        'Sure: {"facts":["a"],"decisions":["b"],"openTasks":[],"pinnedInstructions":["c"]}',
      ),
    ).toEqual({ facts: ["a"], decisions: ["b"], openTasks: [], pinnedInstructions: ["c"] });
    expect(parseCompactionSummary("no json here")).toBeUndefined();
    expect(parseCompactionSummary('{"facts":"not a list"}')).toBeUndefined();
  });

  it("never folds a tool call whose result has not come back", () => {
    expect(
      hasUnansweredToolCalls([
        { role: "user", parts: [{ type: "text", text: "go" }] },
        {
          role: "assistant",
          parts: [{ type: "tool_call", id: "c1", name: "email.send", input: {} }],
        },
      ]),
    ).toBe(true);
    expect(
      hasUnansweredToolCalls([
        { role: "assistant", parts: [{ type: "tool_call", id: "c1", name: "x", input: {} }] },
        { role: "tool", parts: [{ type: "tool_result", callId: "c1", output: "ok" }] },
      ]),
    ).toBe(false);
  });

  it("compacts on demand, and not while the thread is running", async () => {
    const compactions: CompactionInfo[] = [];
    const h = harness({
      script: [
        say("one"),
        say("two"),
        say("three"),
        say(
          '{"facts":[],"decisions":["Launch on Nov 3"],"openTasks":["Book the venue"],"pinnedInstructions":["Answer in one line"]}',
        ),
      ],
      loop: {
        contextLimits: () => ({ keepRecentTurns: 1 }),
        onCompaction: (c) => void compactions.push(c),
      },
    });
    await runTurn(h, "Plan: launch on Nov 3. Answer in one line from now on.");
    await runTurn(h, "next");
    await runTurn(h, "and next");
    const info = await h.loop.compactThread("thr_1");
    expect(info).toMatchObject({ trigger: "manual", replacedTurns: 2, keptTurns: 1 });
    expect(compactions).toHaveLength(1);
    const state = await h.loop.threadState("thr_1");
    expect(state.summary?.structured?.pinnedInstructions).toEqual(["Answer in one line"]);
    expect(state.compactions).toBe(1);
    expect(state.messages.filter((m) => m.role === "user")).toHaveLength(1);
    // A thread with a turn in flight refuses: the model never answers until released.
    let release: () => void = () => undefined;
    const blocked = new Promise<void>((r) => {
      release = r;
    });
    const busy = createAgentLoop({
      provider: {
        id: "slow",
        capabilities: async () => ({ contextWindow: 100_000 }) as never,
        async *stream() {
          await blocked;
          yield* say("done");
        },
      },
      model: "slow/main",
      broker: h.broker,
      clock: h.clock,
    });
    const drain = (async () => {
      for await (const _ of busy.startTurn({
        threadId: "thr_busy",
        runId: "run_busy",
        input: { text: "hold on" },
        mode: "attended",
        permissionMode: "balanced",
      })) {
        // drain
      }
    })();
    // The turn is now waiting on the model.
    await new Promise((r) => setTimeout(r, 20));
    await expect(busy.compactThread("thr_busy")).rejects.toMatchObject({ code: "conflict" });
    release();
    await drain;
  });
});

/**
 * The scenario: a 40-turn thread under a 4,000-token limit. A model that answers every turn
 * with a paragraph, and a summarizer that keeps the plan, the decision and the standing
 * instruction. Every call stays under the limit, compactions happen, and the last prompt still
 * carries the plan.
 */
describe("a 40-turn thread stays under its limit with the plan intact", () => {
  it("compacts as it goes and never sends more than maxTokens", async () => {
    const MAX = 4_000;
    const sent: number[] = [];
    const usages: ContextUsage[] = [];
    const compactions: CompactionInfo[] = [];
    const reply = (text: string, input: number): ModelEvent[] => [
      { type: "text_delta", text },
      {
        type: "usage",
        usage: { input, output: 20, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0 },
      },
      { type: "finish", reason: "stop" },
    ];
    let turn = 0;
    const provider: ModelProvider = {
      id: "scripted",
      capabilities: async () =>
        ({ contextWindow: 200_000, tools: true, vision: false, reasoning: false }) as never,
      async *stream(req: ModelRequest) {
        const input = estimateContextTokens(req.system ?? "", req.messages, req.tools ?? []);
        if (req.system === STRUCTURED_SUMMARIZER_SYSTEM) {
          yield* reply(
            JSON.stringify({
              facts: ["The owner is planning the Q4 launch"],
              decisions: ["Plan: launch on Nov 3 with Maya; press release on Nov 4"],
              openTasks: [`Keep the weekly updates going (through turn ${turn})`],
              pinnedInstructions: ["Always sign updates as Avery"],
            }),
            input,
          );
          return;
        }
        sent.push(input);
        turn += 1;
        yield* reply(`Update ${turn}: ${"progress on the launch checklist. ".repeat(12)}`, input);
      },
    };
    const h = harness();
    const loop = createAgentLoop({
      provider,
      model: "scripted/main",
      utilityModel: "scripted/utility",
      broker: h.broker,
      clock: h.clock,
      contextLimits: () => ({ maxTokens: MAX, compactAt: 0.7, keepRecentTurns: 3 }),
      onContextUsage: (u) => usages.push(u),
      onCompaction: (c) => void compactions.push(c),
    });
    for (let i = 1; i <= 40; i++) {
      const text =
        i === 1
          ? "Plan: launch on Nov 3 with Maya; press release on Nov 4. Always sign updates as Avery."
          : `Turn ${i}: here is today's status. ${"Details about vendors, venues and copy. ".repeat(10)}`;
      for await (const e of loop.startTurn({
        threadId: "thr_long",
        runId: `run_${i}`,
        input: { text },
        mode: "attended",
        permissionMode: "balanced",
      })) {
        if (e.type === "end") expect(e.outcome, `turn ${i}`).toBe("final");
      }
    }
    expect(usages).toHaveLength(40);
    expect(Math.max(...sent)).toBeLessThanOrEqual(MAX);
    expect(Math.max(...usages.map((u) => u.peakTokens))).toBeLessThanOrEqual(MAX);
    expect(compactions.length).toBeGreaterThan(2);
    expect(compactions.every((c) => c.tokensAfter < c.tokensBefore)).toBe(true);
    const state = await loop.threadState("thr_long");
    expect(state.summary?.text).toContain("Plan: launch on Nov 3 with Maya");
    expect(state.summary?.text).toContain("Always sign updates as Avery");
    expect(usages.at(-1)?.compactions).toBe(compactions.length);
  });
});
