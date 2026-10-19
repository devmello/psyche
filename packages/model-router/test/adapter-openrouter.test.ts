import type { ModelRequest } from "@psyche/protocol";
import { collect } from "@psyche/testing";
import { describeModelProviderConformance } from "@psyche/testing/conformance";
import { describe, expect, it } from "vitest";
import {
  type AiSdkAdapter,
  accumulate,
  type CallOutcome,
  isEnvelope,
  type ProviderConfig,
} from "../src/index.ts";
import { fakeKey, makeAdapter, textRequest, weatherTool } from "./helpers/adapters.ts";
import { repeatFetch } from "./helpers/repeat.ts";
import { loadFixture, replayFetch } from "./helpers/replay.ts";

const fx = (name: string) => loadFixture(`openrouter/${name}.json`);
const MODEL = "anthropic/claude-sonnet-5-5";
const REF = `openrouter/${MODEL}`;
const KEY = { secret: fakeKey("openrouter"), origin: "https://openrouter.ai" };
const CONFIG: ProviderConfig = {
  id: "openrouter",
  kind: "openrouter",
  embeddingModels: ["openai/text-embedding-3-small"],
};

function setup(...fixtures: string[]) {
  const replay = replayFetch(...fixtures.map(fx));
  const { adapter } = makeAdapter(CONFIG, replay.fetch, KEY);
  return { adapter, replay };
}

async function run(adapter: AiSdkAdapter, request: ModelRequest) {
  let outcome: CallOutcome | undefined;
  const events = await collect(
    adapter.stream(request, {
      onOutcome: (o) => {
        outcome = o;
      },
    }),
  );
  return { events, outcome };
}

type WireMessage = Record<string, unknown> & { role: string };

describe("openrouter adapter (chat completions SSE, recorded fixtures)", () => {
  it("streams text and a signed reasoning block", async () => {
    const { adapter, replay } = setup("text");
    const { events, outcome } = await run(adapter, textRequest(REF));
    expect(events.filter((e) => e.type === "text_delta").map((e) => e.text)).toEqual([
      "Hello",
      ", world.",
    ]);
    expect(
      events
        .filter((e) => e.type === "reasoning" && e.data === null)
        .map((e) => e.type === "reasoning" && e.textDelta),
    ).toEqual(["The user wants a greeting."]);
    const block = events.find(
      (e) => e.type === "reasoning" && isEnvelope(e.data) && e.data.kind === "reasoning",
    );
    expect(block?.type === "reasoning" && block.data).toMatchObject({
      kind: "reasoning",
      model: MODEL,
      text: "The user wants a greeting.",
      metadata: {
        openrouter: {
          reasoning_details: [
            expect.objectContaining({
              type: "reasoning.text",
              text: "The user wants a greeting.",
              signature: "EqQBCkYIor-fixture-sig-0001",
            }),
          ],
        },
      },
    });
    expect(events.at(-1)).toEqual({ type: "finish", reason: "stop" });
    expect(outcome?.error).toBeUndefined();

    const sent = replay.requests[0];
    expect(sent?.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    const body = sent?.body as Record<string, unknown>;
    expect(body.model).toBe(MODEL);
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
  });

  it("reports usage by class and the provider-reported cost", async () => {
    const { adapter } = setup("text");
    const { events, outcome } = await run(adapter, textRequest(REF));
    const usage = events.find((e) => e.type === "usage");
    // prompt_tokens 5012 of which 4096 cached; completion 120 of which 40 reasoning.
    expect(usage?.type === "usage" && usage.usage).toMatchObject({
      input: 916,
      cacheRead: 4096,
      cacheWrite: 0,
      output: 120,
      reasoning: 40,
    });
    const raw = JSON.parse(
      (fx("text").response.chunks ?? []).find((c) => c.includes('"cost"'))?.slice(6) ?? "{}",
    ) as { usage: { cost: number } };
    expect(usage?.type === "usage" && usage.usage.costUsd).toBe(raw.usage.cost);
    expect(outcome?.providerCost).toBe(true);
    expect(outcome?.unpriced).toBe(false);
  });

  it("injects the vault key into the Authorization header only", async () => {
    const { adapter, replay } = setup("text");
    await run(adapter, textRequest(REF));
    const sent = replay.requests[0];
    expect(sent?.headers.authorization).toBe(`Bearer ${KEY.secret}`);
    expect(JSON.stringify(sent?.body)).not.toContain(KEY.secret);
    expect(JSON.stringify(sent?.headers)).not.toContain("psyche-key-injected-at-fetch");
  });

  it("emits parallel tool calls with parsed input", async () => {
    const { adapter, replay } = setup("parallel-tools");
    const { events } = await run(adapter, { ...textRequest(REF), tools: [weatherTool] });
    expect(events.filter((e) => e.type === "text_delta").map((e) => e.text)).toEqual([
      "Checking both cities.",
    ]);
    expect(events.filter((e) => e.type === "tool_call")).toEqual([
      { type: "tool_call", id: "toolu_or_A", name: "weather", input: { city: "Paris" } },
      { type: "tool_call", id: "toolu_or_B", name: "weather", input: { city: "Tokyo" } },
    ]);
    expect(events.at(-1)).toEqual({ type: "finish", reason: "tool_calls" });
    const usage = events.find((e) => e.type === "usage");
    expect(usage?.type === "usage" && usage.usage.costUsd).toBe(0.001515);
    const tools = ((replay.requests[0]?.body ?? {}) as { tools?: { function: { name: string } }[] })
      .tools;
    expect(tools?.map((t) => t.function.name)).toEqual(["weather"]);
  });

  it("round-trips signed reasoning_details and sends tool results and images back", async () => {
    const first = setup("text");
    const turn = await accumulate(first.adapter.stream(textRequest(REF)));
    const second = setup("text");
    const request: ModelRequest = {
      model: REF,
      messages: [
        { role: "user", parts: [{ type: "text", text: "Weather?" }] },
        {
          role: "assistant",
          parts: [
            ...turn.parts,
            { type: "tool_call", id: "toolu_or_A", name: "weather", input: { city: "Paris" } },
          ],
        },
        {
          role: "tool",
          parts: [{ type: "tool_result", callId: "toolu_or_A", output: { tempC: 18 } }],
        },
        {
          role: "user",
          parts: [
            { type: "text", text: "And this?" },
            { type: "image", mime: "image/png", data: "iVBORw0KGgoAAAANSUhEUg==" },
          ],
        },
      ],
      tools: [weatherTool],
    };
    await run(second.adapter, request);
    const body = second.replay.requests[0]?.body as { messages: WireMessage[] };
    const assistant = body.messages.find((m) => m.role === "assistant");
    expect(assistant).toMatchObject({
      content: "Hello, world.",
      reasoning: "The user wants a greeting.",
      reasoning_details: [
        expect.objectContaining({
          type: "reasoning.text",
          signature: "EqQBCkYIor-fixture-sig-0001",
        }),
      ],
      tool_calls: [
        {
          id: "toolu_or_A",
          type: "function",
          function: { name: "weather", arguments: '{"city":"Paris"}' },
        },
      ],
    });
    expect(body.messages).toContainEqual(
      expect.objectContaining({
        role: "tool",
        tool_call_id: "toolu_or_A",
        content: JSON.stringify({ tempC: 18 }),
      }),
    );
    expect(body.messages.at(-1)).toEqual({
      role: "user",
      content: [
        { type: "text", text: "And this?" },
        { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==" } },
      ],
    });
  });

  it.each([
    ["error-429", "rate_limited", 11],
    ["error-500", "server_error", undefined],
    ["error-503", "server_error", undefined],
    ["error-401", "auth", undefined],
    ["error-400-context", "context_overflow", undefined],
  ])("maps %s to %s", async (name, kind, retryAfter) => {
    const { adapter } = setup(name);
    const { events, outcome } = await run(adapter, textRequest(REF));
    const last = events.at(-1);
    expect(last).toMatchObject({ type: "finish", reason: "error" });
    expect(last?.type === "finish" && last.error?.startsWith(`${kind}:`)).toBe(true);
    expect(outcome?.error?.kind).toBe(kind);
    expect(outcome?.error?.retryAfterSec).toBe(retryAfter);
    expect(outcome?.contentStarted).toBe(false);
    expect(JSON.stringify(events)).not.toContain(KEY.secret);
  });

  it("ends a mid-stream error chunk with finish{error} before any content", async () => {
    const { adapter } = setup("error-midstream");
    const { events, outcome } = await run(adapter, textRequest(REF));
    expect(events.at(-1)).toMatchObject({ type: "finish", reason: "error" });
    expect(events.some((e) => e.type === "text_delta")).toBe(false);
    expect(outcome?.error).toBeDefined();
    expect(outcome?.contentStarted).toBe(false);
  });

  it("classifies the mid-stream error chunk as server_error", async () => {
    const { adapter } = setup("error-midstream");
    const { outcome } = await run(adapter, textRequest(REF));
    expect(outcome?.error?.kind).toBe("server_error");
  });

  it("ends with finish{cancelled} when aborted mid-stream", async () => {
    const { adapter } = setup("hang");
    const ac = new AbortController();
    const events = [];
    for await (const e of adapter.stream(textRequest(REF), { signal: ac.signal })) {
      events.push(e);
      if (e.type === "text_delta") ac.abort();
    }
    expect(events.filter((e) => e.type === "text_delta")).toEqual([
      { type: "text_delta", text: "Partial" },
    ]);
    expect(events.at(-1)).toEqual({ type: "finish", reason: "cancelled" });
  });
});

describeModelProviderConformance(
  "openrouter (replayed chat completions)",
  () => {
    const { fetch } = repeatFetch(fx("text"), fx("embeddings"));
    return makeAdapter(CONFIG, fetch, KEY).adapter;
  },
  { request: () => textRequest(REF) },
);
