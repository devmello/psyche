import type { ModelEvent, ModelRequest } from "@psyche/protocol";
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
import { makeAdapter, textRequest, weatherTool } from "./helpers/adapters.ts";
import { repeatFetchLocal } from "./helpers/repeat-local.ts";
import { loadFixture, replayFetch } from "./helpers/replay.ts";

const fx = (name: string) => loadFixture(`ollama/${name}.json`);
const REF = "ollama/qwen3.8:27b";
const CONFIG: ProviderConfig = { id: "ollama", kind: "ollama" };
const PNG = "iVBORw0KGgoAAAANSUhEUg==";

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

type OllamaMessage = Record<string, unknown> & { role: string };
const messagesOf = (body: unknown) => (body as { messages: OllamaMessage[] }).messages;

describe("ollama native adapter (/api/chat NDJSON, recorded fixtures)", () => {
  it("streams text and thinking from NDJSON split across network chunks", async () => {
    const { adapter, replay } = setup("text");
    const { events, outcome } = await run(adapter, textRequest(REF));
    expect(events.filter((e) => e.type === "text_delta").map((e) => e.text)).toEqual([
      "Hello",
      ", world.",
    ]);
    const deltas = events.filter((e) => e.type === "reasoning" && e.data === null);
    expect(deltas.map((e) => e.type === "reasoning" && e.textDelta)).toEqual([
      "The user wants ",
      "a greeting.",
    ]);
    const block = events.find((e) => e.type === "reasoning" && isEnvelope(e.data));
    expect(block?.type === "reasoning" && block.data).toMatchObject({
      v: 1,
      kind: "reasoning",
      model: "qwen3.8:27b",
      text: "The user wants a greeting.",
    });
    expect(events.at(-1)).toEqual({ type: "finish", reason: "stop" });
    expect(outcome?.error).toBeUndefined();

    const sent = replay.requests[0];
    expect(sent?.url).toBe("http://127.0.0.1:11434/api/chat");
    expect(sent?.body).toMatchObject({
      model: "qwen3.8:27b",
      stream: true,
      max_output_tokens: 256,
      messages: [
        { role: "system", content: "You are terse." },
        { role: "user", content: "Say hello." },
      ],
    });
    // Keyless local server: no auth header of any kind goes out.
    expect(Object.keys(sent?.headers ?? {})).not.toContain("authorization");
    expect(JSON.stringify(sent?.headers)).not.toContain("psyche-key-injected-at-fetch");
  });

  it("passes the think flag through providerOptions", async () => {
    const { adapter, replay } = setup("text");
    await run(adapter, { ...textRequest(REF), providerOptions: { ollama: { think: true } } });
    expect(((replay.requests[0]?.body ?? {}) as { think?: unknown }).think).toBe(true);
  });

  it("reports usage by class at zero cost", async () => {
    const { adapter } = setup("text");
    const { events, outcome } = await run(adapter, textRequest(REF));
    const usage = events.find((e) => e.type === "usage");
    expect(usage?.type === "usage" && usage.usage).toEqual({
      input: 26,
      output: 42,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
      costUsd: 0,
    });
    expect(outcome?.unpriced).toBe(false);
    expect(outcome?.providerCost).toBe(false);
  });

  it("emits parallel tool calls with parsed input", async () => {
    const { adapter, replay } = setup("parallel-tools");
    const { events, outcome } = await run(adapter, { ...textRequest(REF), tools: [weatherTool] });
    expect(events.filter((e) => e.type === "tool_call")).toEqual([
      { type: "tool_call", id: "call_paris", name: "weather", input: { city: "Paris" } },
      { type: "tool_call", id: "call_tokyo", name: "weather", input: { city: "Tokyo" } },
    ]);
    // Ollama says done_reason "stop" for tool calls; the package corrects it.
    expect(events.at(-1)).toEqual({ type: "finish", reason: "tool_calls" });
    expect(outcome?.usage).toMatchObject({ input: 180, output: 31, costUsd: 0 });
    const tools =
      ((replay.requests[0]?.body ?? {}) as { tools?: Record<string, unknown>[] }).tools ?? [];
    expect(tools).toEqual([
      {
        type: "function",
        function: {
          name: "weather",
          description: "Current weather for a city",
          parameters: weatherTool.inputSchema,
        },
      },
    ]);
  });

  it("sends thinking, tool calls, tool results and images back", async () => {
    const first = setup("text");
    const thought = await accumulate(first.adapter.stream(textRequest(REF)));
    const second = setup("text");
    const request: ModelRequest = {
      model: REF,
      messages: [
        { role: "user", parts: [{ type: "text", text: "Weather?" }] },
        {
          role: "assistant",
          parts: [
            ...thought.parts,
            { type: "tool_call", id: "call_paris", name: "weather", input: { city: "Paris" } },
          ],
        },
        {
          role: "tool",
          parts: [{ type: "tool_result", callId: "call_paris", output: { tempC: 18 } }],
        },
        {
          role: "user",
          parts: [
            { type: "text", text: "What is in this picture?" },
            { type: "image", mime: "image/png", data: PNG },
          ],
        },
      ],
      tools: [weatherTool],
    };
    await run(second.adapter, request);
    const messages = messagesOf(second.replay.requests[0]?.body);
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "user"]);
    expect(messages[1]).toEqual({
      role: "assistant",
      content: "Hello, world.",
      thinking: "The user wants a greeting.",
      tool_calls: [
        {
          id: "call_paris",
          type: "function",
          function: { name: "weather", arguments: { city: "Paris" } },
        },
      ],
    });
    expect(messages[2]).toEqual({
      role: "tool",
      tool_call_id: "call_paris",
      content: '{"tempC":18}',
    });
    expect(messages[3]).toEqual({
      role: "user",
      content: "What is in this picture?",
      images: [PNG],
    });
  });

  it("drops another model's thinking on fallback", async () => {
    const first = setup("text");
    const thought = await accumulate(first.adapter.stream(textRequest(REF)));
    const second = setup("text");
    await run(second.adapter, {
      model: "ollama/llama4.2:8b",
      messages: [
        { role: "user", parts: [{ type: "text", text: "hi" }] },
        thought.message(),
        { role: "user", parts: [{ type: "text", text: "again" }] },
      ],
    });
    const assistant = messagesOf(second.replay.requests[0]?.body).find(
      (m) => m.role === "assistant",
    );
    expect(assistant?.content).toBe("Hello, world.");
    expect(assistant).not.toHaveProperty("thinking");
  });

  it.each([
    ["error-429", "rate_limited", 3],
    ["error-500", "server_error", undefined],
    ["error-503", "server_error", undefined],
    ["error-401", "auth", undefined],
    ["error-403", "auth", undefined],
    ["error-400-context", "context_overflow", undefined],
    ["error-404", "model_not_found", undefined],
  ])("maps %s to %s", async (name, kind, retryAfter) => {
    const { adapter } = setup(name);
    const { events, outcome } = await run(adapter, textRequest(REF));
    const last = events.at(-1);
    expect(last).toMatchObject({ type: "finish", reason: "error" });
    expect(last?.type === "finish" && last.error?.startsWith(`${kind}:`)).toBe(true);
    expect(events.filter((e) => e.type === "finish")).toHaveLength(1);
    expect(outcome?.error?.kind).toBe(kind);
    expect(outcome?.error?.retryAfterSec).toBe(retryAfter);
    expect(outcome?.contentStarted).toBe(false);
  });

  it("ends with finish{cancelled} when aborted mid-stream", async () => {
    const { adapter } = setup("hang");
    const ac = new AbortController();
    let outcome: CallOutcome | undefined;
    const events: ModelEvent[] = [];
    for await (const e of adapter.stream(textRequest(REF), {
      signal: ac.signal,
      onOutcome: (o) => {
        outcome = o;
      },
    })) {
      events.push(e);
      if (e.type === "text_delta") ac.abort();
    }
    expect(events.filter((e) => e.type === "text_delta")).toEqual([
      { type: "text_delta", text: "Partial" },
    ]);
    expect(events.at(-1)).toEqual({ type: "finish", reason: "cancelled" });
    expect(outcome?.error?.kind).toBe("cancelled");
  });
});

describe("ollama embeddings (/api/embed)", () => {
  it("prefixes nomic documents with search_document: and returns the vectors", async () => {
    const replay = replayFetch(fx("embed"));
    const { adapter } = makeAdapter(CONFIG, replay.fetch);
    const vectors = await adapter.embed(["a", "b"], { model: "ollama/nomic-embed-text" });
    expect(vectors).toEqual([
      [0.011, -0.022, 0.033, 0.044],
      [0.055, 0.066, -0.077, 0.088],
    ]);
    const sent = replay.requests[0];
    expect(sent?.url).toBe("http://127.0.0.1:11434/api/embed");
    expect(sent?.body).toEqual({
      model: "nomic-embed-text",
      input: ["search_document: a", "search_document: b"],
    });
    // The measured dimension wins over the known-models table, with no probe call.
    expect(await adapter.embeddingDimensions("nomic-embed-text")).toBe(4);
    expect(replay.remaining()).toBe(0);
    expect(replay.requests).toHaveLength(1);
  });

  it("prefixes queries with search_query:", async () => {
    const replay = replayFetch(fx("embed"));
    const { adapter } = makeAdapter(CONFIG, replay.fetch);
    await adapter.embed(["a", "b"], { model: "ollama/nomic-embed-text", task: "query" });
    expect(((replay.requests[0]?.body ?? {}) as { input: string[] }).input).toEqual([
      "search_query: a",
      "search_query: b",
    ]);
  });

  it("sends other embedding models unprefixed", async () => {
    const replay = replayFetch(fx("embed"));
    const { adapter } = makeAdapter(CONFIG, replay.fetch);
    await adapter.embed(["a", "b"], { model: "ollama/qwen3-embedding:0.6b" });
    expect(((replay.requests[0]?.body ?? {}) as { input: string[] }).input).toEqual(["a", "b"]);
  });

  it("maps a missing embedding model to an unavailable PsycheError", async () => {
    // The chat 404 body, served from /api/embed.
    const replay = replayFetch({
      ...fx("error-404"),
      request: { method: "POST", pathEndsWith: "/api/embed" },
    });
    const { adapter } = makeAdapter(CONFIG, replay.fetch);
    await expect(adapter.embed(["a"], { model: "ollama/nomic-embed-text" })).rejects.toMatchObject({
      code: "unavailable",
      retryable: true,
    });
  });
});

describeModelProviderConformance(
  "ollama (replayed /api/chat)",
  () => {
    const repeat = repeatFetchLocal(fx("text"), fx("embed"));
    return makeAdapter({ ...CONFIG, embeddingModels: ["nomic-embed-text"] }, repeat.fetch).adapter;
  },
  { request: () => textRequest(REF) },
);
