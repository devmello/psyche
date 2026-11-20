import type { ContextUsage, ModelRequest } from "@psyche/protocol";
import { describe, expect, it } from "vitest";
// The converter is pure: it shows the bytes Anthropic gets for the loop's and the summarizer's
// requests, to check the summarizer reads the loop's cached prefix.
import { convertRequest } from "../../model-router/src/convert-request.ts";
import {
  DEFAULT_COMPACT_MAX_TOKENS,
  parseCompactionReply,
  renderCompactionSummary,
  type TurnContextProvider,
} from "../src/index.ts";
import { call, harness, messagesText, recorder, runTurn, say, spec } from "./harness.ts";

/**
 * Compaction rework (research-harness-tokens PR 5): a token cap on the default threshold, one
 * summarizer call that also lists the daily-note facts, and a summarizer that is a fork of the
 * loop's own request so the provider serves the history from its cache.
 */

const SUMMARY = JSON.stringify({
  facts: ["The launch is on Nov 3."],
  decisions: [],
  openTasks: [],
  pinnedInstructions: ["Always sign updates as Avery."],
  dailyNoteLines: ["The owner signs updates as Avery."],
});

describe("the default threshold", () => {
  const compactAt = async (
    window: number,
    limits?: () => { maxTokens?: number; compactAt?: number },
    loop: object = {},
  ) => {
    const usages: ContextUsage[] = [];
    const h = harness({
      contextWindow: window,
      script: [say("hi")],
      loop: {
        onContextUsage: (u) => usages.push(u),
        ...(limits === undefined ? {} : { contextLimits: limits }),
        ...loop,
      },
    });
    await runTurn(h, "hello");
    return usages[0]?.limits;
  };

  it("is 80% of a small window and a token cap on a large one", async () => {
    expect((await compactAt(100_000))?.compactAt).toBe(0.8);
    const big = await compactAt(1_000_000);
    expect(big?.compactAt).toBeCloseTo(DEFAULT_COMPACT_MAX_TOKENS / 1_000_000, 10);
    expect((big?.maxTokens ?? 0) * (big?.compactAt ?? 0)).toBeCloseTo(
      DEFAULT_COMPACT_MAX_TOKENS,
      3,
    );
  });

  it("is overridden by the owner's compactAt, maxTokens or the loop's own ratio", async () => {
    expect((await compactAt(1_000_000, () => ({ compactAt: 0.5 })))?.compactAt).toBe(0.5);
    expect((await compactAt(1_000_000, () => ({ maxTokens: 900_000 })))?.compactAt).toBe(0.8);
    expect(
      (await compactAt(1_000_000, undefined, { compaction: { thresholdRatio: 0.6 } }))?.compactAt,
    ).toBe(0.6);
  });
});

describe("the structured reply", () => {
  it("carries the daily-note lines beside the four lists, and renders the pinned ones first", () => {
    const reply = parseCompactionReply(`Sure: ${SUMMARY}`);
    expect(reply?.dailyNoteLines).toEqual(["The owner signs updates as Avery."]);
    expect(reply?.summary.pinnedInstructions).toEqual(["Always sign updates as Avery."]);
    const text = renderCompactionSummary(reply?.summary as never);
    expect(text.startsWith("Standing instructions from the owner:")).toBe(true);
    expect(text).not.toContain("daily");
  });

  it("drops bad, long, duplicate and surplus note lines without failing the summary", () => {
    const lines = [
      "ok",
      "ok",
      7,
      "x".repeat(301),
      ...Array.from({ length: 20 }, (_, i) => `n${i}`),
    ];
    const reply = parseCompactionReply(
      JSON.stringify({
        facts: [],
        decisions: [],
        openTasks: [],
        pinnedInstructions: [],
        dailyNoteLines: lines,
      }),
    );
    expect(reply?.dailyNoteLines).toHaveLength(12);
    expect(reply?.dailyNoteLines[0]).toBe("ok");
    expect(reply?.dailyNoteLines.every((l) => l.length <= 300)).toBe(true);
    const none = parseCompactionReply(
      '{"facts":[],"decisions":[],"openTasks":[],"pinnedInstructions":[],"dailyNoteLines":"x"}',
    );
    expect(none?.dailyNoteLines).toEqual([]);
    expect(parseCompactionReply('{"facts":"no"}')).toBeUndefined();
  });
});

type Json = Record<string, unknown>;
function strip(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(strip);
  if (typeof value !== "object" || value === null) return value;
  const out: Json = {};
  for (const [k, v] of Object.entries(value)) {
    if (k === "cacheControl") continue;
    const s = strip(v);
    if (typeof s === "object" && s !== null && !Array.isArray(s) && Object.keys(s).length === 0) {
      if (k === "anthropic" || k === "providerOptions") continue;
    }
    out[k] = s;
  }
  return out;
}
const marked = (v: unknown) =>
  (v as { providerOptions?: { anthropic?: { cacheControl?: unknown } } }).providerOptions?.anthropic
    ?.cacheControl !== undefined;
const send = (r: ModelRequest) =>
  convertRequest(r, {
    config: { id: "anthropic", kind: "anthropic" },
    modelId: "claude-haiku-5-5",
  });
function positions(r: ModelRequest): { bytes: string; breakpoint: boolean }[] {
  const out: { bytes: string; breakpoint: boolean }[] = [];
  for (const m of send(r).prompt) {
    const content = typeof m.content === "string" ? [m.content] : (m.content as unknown[]);
    content.forEach((part, j) => {
      out.push({
        bytes: JSON.stringify({ role: m.role, part: strip(part) }),
        breakpoint: marked(part) || (marked(m) && j === content.length - 1),
      });
    });
  }
  return out;
}
const toolsOf = (r: ModelRequest) => JSON.stringify(strip(send(r).tools ?? []));

const recall: TurnContextProvider = {
  name: "other-chats",
  async provide(input) {
    return {
      sections: [{ title: "From your other chats", text: `Asked about "${input.text}" before.` }],
      source: { sourceKind: "other_chats", origin: "thr_other" },
    };
  },
};

function compacting(extra: Record<string, unknown> = {}, script = [] as ReturnType<typeof say>[]) {
  const h = harness({
    // The summarizer runs on the run's own model: the fork shape.
    script: [call("c1", "noop", {}), say("one"), say(SUMMARY), say("two"), ...script],
    loop: {
      utilityModel: "fake/main",
      compaction: { thresholdRatio: 0.000_001, keepRecentTurns: 1 },
      ...extra,
    },
  });
  h.loop.registry.register({ spec: spec("noop", "none"), execute: recorder().execute });
  return h;
}

describe("the summarizer as a fork of the loop's request", () => {
  it("is a byte prefix extension of the last loop request, up to its last breakpoint", async () => {
    const h = compacting();
    await runTurn(h, "plan the launch");
    await runTurn(h, "what is next?");
    const [, last, fork, main] = h.provider.requests as [
      ModelRequest,
      ModelRequest,
      ModelRequest,
      ModelRequest,
    ];
    expect(fork.model).toBe(last.model);
    expect(fork.system).toBe(last.system);
    expect(fork.systemStableLength).toBe(last.systemStableLength);
    expect(toolsOf(fork)).toBe(toolsOf(last));
    const a = positions(last);
    const b = positions(fork);
    const end = a.map((p) => p.breakpoint).lastIndexOf(true);
    expect(end).toBeGreaterThan(1);
    for (let i = 0; i <= end; i += 1) expect(b[i]?.bytes, `position ${i}`).toBe(a[i]?.bytes);
    // The task is the one added message; tool choice is left alone (it would drop the cache).
    expect(fork.toolChoice).toBeUndefined();
    const tail = fork.messages.at(-1);
    expect(tail?.role).toBe("user");
    expect(messagesText({ ...fork, messages: [tail as never] })).toContain('"dailyNoteLines"');
    expect(messagesText({ ...fork, messages: [tail as never] })).toContain(
      'starts: "what is next?"',
    );
    // One summarizer call, then the owner's turn goes on from the summary.
    expect(main.system).toBe(last.system);
    expect(h.provider.requests).toHaveLength(4);
  });

  it("keeps keepRecentTurns and pinned instructions, and appends the notes once", async () => {
    const h = compacting();
    await runTurn(h, "plan the launch");
    await runTurn(h, "what is next?");
    const state = await h.loop.threadState("thr_1");
    expect(state.summary?.structured?.pinnedInstructions).toEqual([
      "Always sign updates as Avery.",
    ]);
    expect(state.summary?.text.startsWith("Standing instructions from the owner:")).toBe(true);
    // Only the latest turn stays verbatim.
    expect(state.messages.filter((m) => m.role === "user")).toHaveLength(1);
    expect(h.memory.flushes).toHaveLength(0);
    expect(h.memory.flushedLines).toEqual([
      { threadId: "thr_1", lines: ["The owner signs updates as Avery."], taint: false },
    ]);
  });

  it("never gives the summarizer this run's recall, or marks the summary untrusted for it", async () => {
    const h = compacting({ contextProviders: [recall] });
    await runTurn(h, "plan the launch");
    await runTurn(h, "what is next?");
    const fork = h.provider.requests[2] as ModelRequest;
    expect(messagesText(fork)).not.toContain("Asked about");
    expect((await h.loop.threadState("thr_1")).summary?.untrusted).toBe(false);
  });

  it("uses the standalone request when the utility model is another one", async () => {
    const h = compacting({ utilityModel: "fake/utility" });
    await runTurn(h, "plan the launch");
    await runTurn(h, "what is next?");
    const summarizer = h.provider.requests[2] as ModelRequest;
    expect(summarizer.model).toBe("fake/utility");
    expect(summarizer.tools).toBeUndefined();
    expect(summarizer.messages).toHaveLength(1);
  });
});

describe("the context meter after a compaction", () => {
  it("still adds up to the provider's total, with the summary counted as history", async () => {
    const usages: ContextUsage[] = [];
    const h = compacting({ onContextUsage: (u: ContextUsage) => usages.push(u) });
    await runTurn(h, "plan the launch");
    await runTurn(h, "what is next?");
    const u = usages.at(-1) as ContextUsage;
    const b = u.breakdown;
    expect(b.system + b.tools + b.context + b.history + b.current).toBe(u.promptTokens);
    expect(b.history).toBeGreaterThan(0);
    expect(u.compactions).toBe(1);
  });
});
