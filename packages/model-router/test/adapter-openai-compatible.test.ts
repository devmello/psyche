import type { ModelRequest } from "@psyche/protocol";
import { collect } from "@psyche/testing";
import { describeModelProviderConformance } from "@psyche/testing/conformance";
import { describe, expect, it } from "vitest";
import {
  type AiSdkAdapter,
  accumulate,
  type CallOutcome,
  isEnvelope,
  KEY_SENTINEL,
  type ProviderConfig,
} from "../src/index.ts";
import { makeAdapter, textRequest, weatherTool } from "./helpers/adapters.ts";
import { repeatFetch } from "./helpers/repeat.ts";
import { loadFixture, replayFetch } from "./helpers/replay.ts";

const fx = (name: string) => loadFixture(`openai-compatible/${name}.json`);
const MODEL = "qwen3-8b";
const REF = `llamacpp/${MODEL}`;
const CONFIG: ProviderConfig = {
  id: "llamacpp",
  kind: "openai-compatible",
  baseURL: "http://127.0.0.1:8080/v1",
  embeddingModels: ["nomic-embed-text-v1.5"],
};

function setup(...fixtures: string[]) {
  const replay = replayFetch(...fixtures.map(fx));
  const { adapter } = makeAdapter(CONFIG, replay.fetch);
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

describe("openai-compatible adapter (llama.cpp, recorded fixtures)", () => {
  it("streams reasoning_content deltas, a reasoning block and text", async () => {
    const { adapter, replay } = setup("text");
    const { events, outcome } = await run(adapter, textRequest(REF));
    expect(
      events
        .filter((e) => e.type === "reasoning" && e.data === null)
        .map((e) => e.type === "reasoning" && e.textDelta),
    ).toEqual(["The user", " wants a greeting."]);
    const block = events.find(
      (e) => e.type === "reasoning" && isEnvelope(e.data) && e.data.kind === "reasoning",
    );
    expect(block?.type === "reasoning" && block.data).toMatchObject({
      v: 1,
      kind: "reasoning",
      model: MODEL,
      text: "The user wants a greeting.",
    });
    expect(events.filter((e) => e.type === "text_delta").map((e) => e.text)).toEqual([
      "Hello",
      ", world.",
    ]);
    // The reasoning block closes before the text starts.
    const blockIdx = events.indexOf(block as (typeof events)[number]);
    const textIdx = events.findIndex((e) => e.type === "text_delta");
    expect(blockIdx).toBeLessThan(textIdx);
    expect(events.at(-1)).toEqual({ type: "finish", reason: "stop" });
    expect(outcome?.error).toBeUndefined();

    const sent = replay.requests[0];
    expect(sent?.url).toBe("http://127.0.0.1:8080/v1/chat/completions");
    const body = sent?.body as Record<string, unknown>;
    expect(body.model).toBe(MODEL);
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(body.max_tokens).toBe(256);
  });

  it("sends no key to a keyless local server", async () => {
    const { adapter, replay } = setup("text");
    await run(adapter, textRequest(REF));
    const sent = replay.requests[0];
    expect(sent?.headers.authorization).toBeUndefined();
    expect(JSON.stringify(sent?.headers)).not.toContain(KEY_SENTINEL);
    expect(JSON.stringify(sent?.body)).not.toContain(KEY_SENTINEL);
  });

  it("reports usage by class at zero cost (local kind)", async () => {
    const { adapter } = setup("text");
    const { events, outcome } = await run(adapter, textRequest(REF));
    const usage = events.find((e) => e.type === "usage");
    // prompt_tokens 30 of which 16 from llama.cpp's prompt cache; no reasoning count reported.
    expect(usage?.type === "usage" && usage.usage).toEqual({
      input: 14,
      cacheRead: 16,
      cacheWrite: 0,
      output: 42,
      reasoning: 0,
      costUsd: 0,
    });
    expect(outcome?.unpriced).toBe(false);
    expect(outcome?.providerCost).toBe(false);
  });

  it("emits parallel tool calls with parsed input", async () => {
    const { adapter, replay } = setup("parallel-tools");
    const { events } = await run(adapter, { ...textRequest(REF), tools: [weatherTool] });
    expect(events.filter((e) => e.type === "tool_call")).toEqual([
      { type: "tool_call", id: "call_lc_A", name: "weather", input: { city: "Paris" } },
      { type: "tool_call", id: "call_lc_B", name: "weather", input: { city: "Tokyo" } },
    ]);
    expect(events.at(-1)).toEqual({ type: "finish", reason: "tool_calls" });
    const usage = events.find((e) => e.type === "usage");
    expect(usage?.type === "usage" && usage.usage).toMatchObject({
      input: 300,
      output: 61,
      costUsd: 0,
    });
    const tools = ((replay.requests[0]?.body ?? {}) as { tools?: { function: { name: string } }[] })
      .tools;
    expect(tools?.map((t) => t.function.name)).toEqual(["weather"]);
  });

  it("sends reasoning back as reasoning_content, plus tool results and images", async () => {
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
            { type: "tool_call", id: "call_lc_A", name: "weather", input: { city: "Paris" } },
          ],
        },
        {
          role: "tool",
          parts: [
            { type: "tool_result", callId: "call_lc_A", output: { tempC: 18 } },
            {
              type: "tool_result",
              callId: "call_lc_shot",
              name: "screenshot",
              output: [
                { type: "text", text: "the page" },
                { type: "image", mime: "image/png", data: "iVBORw0KGgoAAAANSUhEUg==" },
              ],
            },
          ],
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
      reasoning_content: "The user wants a greeting.",
      tool_calls: [
        {
          id: "call_lc_A",
          type: "function",
          function: { name: "weather", arguments: '{"city":"Paris"}' },
        },
      ],
    });
    expect(body.messages).toContainEqual({
      role: "tool",
      tool_call_id: "call_lc_A",
      content: JSON.stringify({ tempC: 18 }),
    });
    // The package does not send multi-part tool content by default: the parts are serialized
    // as a JSON string (the image goes along as base64 inside that string).
    const shot = body.messages.find((m) => m.role === "tool" && m.tool_call_id === "call_lc_shot");
    expect(typeof shot?.content).toBe("string");
    expect(shot?.content).toContain("iVBORw0KGgoAAAANSUhEUg==");
    expect(body.messages.at(-1)).toEqual({
      role: "user",
      content: [
        { type: "text", text: "And this?" },
        { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==" } },
      ],
    });
  });

  it.each([
    ["error-429", "rate_limited", 3],
    ["error-500", "server_error", undefined],
    ["error-503", "server_error", undefined],
    ["error-401", "auth", undefined],
    ["error-400-context", "context_overflow", undefined],
    ["error-midstream", "server_error", undefined],
  ])("maps %s to %s", async (name, kind, retryAfter) => {
    const { adapter } = setup(name);
    const { events, outcome } = await run(adapter, textRequest(REF));
    const last = events.at(-1);
    expect(last).toMatchObject({ type: "finish", reason: "error" });
    expect(last?.type === "finish" && last.error?.startsWith(`${kind}:`)).toBe(true);
    expect(outcome?.error?.kind).toBe(kind);
    expect(outcome?.error?.retryAfterSec).toBe(retryAfter);
    expect(outcome?.contentStarted).toBe(false);
    expect(events.some((e) => e.type === "text_delta")).toBe(false);
  });

  it("maps llama.cpp's native context-size 400 to context_overflow", async () => {
    const { adapter } = setup("error-400-context-llamacpp");
    const { outcome } = await run(adapter, textRequest(REF));
    expect(outcome?.error?.kind).toBe("context_overflow");
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
  "openai-compatible (replayed llama.cpp)",
  () => {
    const { fetch } = repeatFetch(fx("text"), fx("embeddings"));
    return makeAdapter(CONFIG, fetch).adapter;
  },
  { request: () => textRequest(REF) },
);
