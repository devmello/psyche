import type { ModelEvent, ModelProvider, ModelRequest } from "@psyche/protocol";
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
import { repeatFetchLocal } from "./helpers/repeat-local.ts";
import { loadFixture, replayFetch } from "./helpers/replay.ts";

const fx = (name: string) => loadFixture(`ollama-anthropic/${name}.json`);
const REF = "ollama-anthropic/gpt-oss:20b";
const CONFIG: ProviderConfig = {
  id: "ollama-anthropic",
  kind: "anthropic-compatible",
  baseURL: "http://127.0.0.1:11434/v1",
};
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

type AnthropicMessage = { role: string; content: Record<string, unknown>[] };
const messagesOf = (body: unknown) => (body as { messages: AnthropicMessage[] }).messages;

describe("anthropic-compatible adapter (Ollama /v1/messages, recorded fixtures)", () => {
  it("streams text and thinking from the local server", async () => {
    const { adapter, replay } = setup("text");
    const { events, outcome } = await run(adapter, textRequest(REF));
    expect(events.filter((e) => e.type === "text_delta").map((e) => e.text)).toEqual([
      "Hello",
      ", world.",
    ]);
    const block = events.find((e) => e.type === "reasoning" && isEnvelope(e.data));
    expect(block?.type === "reasoning" && block.data).toMatchObject({
      kind: "reasoning",
      model: "gpt-oss:20b",
      text: "The user wants a greeting.",
      metadata: { anthropic: { signature: "ollama-fixture-sig-0001" } },
    });
    expect(block?.type === "reasoning" && block.provider).toBe("ollama-anthropic");
    expect(events.at(-1)).toEqual({ type: "finish", reason: "stop" });
    expect(outcome?.error).toBeUndefined();
    expect(replay.requests[0]?.url).toBe("http://127.0.0.1:11434/v1/messages");
  });

  it("sends no key header for a keyless local server", async () => {
    const { adapter, replay } = setup("text");
    await run(adapter, textRequest(REF));
    const headers = replay.requests[0]?.headers ?? {};
    expect(headers["x-api-key"]).toBeUndefined();
    expect(headers.authorization).toBeUndefined();
    expect(JSON.stringify(headers)).not.toContain(KEY_SENTINEL);
    expect(JSON.stringify(replay.requests[0]?.body)).not.toContain(KEY_SENTINEL);
  });

  it("does not force adaptive thinking or prompt caching on a compatible server", async () => {
    // Even with a Claude-looking model id, only the real `anthropic` kind gets the defaults.
    const { adapter, replay } = setup("text", "text");
    await run(adapter, textRequest(REF));
    await run(adapter, textRequest("ollama-anthropic/claude-sonnet-5-5"));
    for (const sent of replay.requests) {
      const body = sent.body as Record<string, unknown>;
      expect(body.thinking).toBeUndefined();
      expect(JSON.stringify(body)).not.toContain("cache_control");
      expect(JSON.stringify(body)).not.toContain("adaptive");
    }
    expect(((replay.requests[1]?.body ?? {}) as { model?: string }).model).toBe(
      "claude-sonnet-5-5",
    );
  });

  it("passes explicit thinking options through", async () => {
    const { adapter, replay } = setup("text");
    await run(adapter, {
      ...textRequest(REF),
      maxOutputTokens: 4096,
      providerOptions: {
        "ollama-anthropic": { thinking: { type: "enabled", budgetTokens: 1024 } },
      },
    });
    expect(((replay.requests[0]?.body ?? {}) as { thinking?: unknown }).thinking).toEqual({
      type: "enabled",
      budget_tokens: 1024,
    });
  });

  it("reports usage by class at zero cost", async () => {
    const { adapter } = setup("text");
    const { events, outcome } = await run(adapter, textRequest(REF));
    const usage = events.find((e) => e.type === "usage");
    expect(usage?.type === "usage" && usage.usage).toEqual({
      input: 21,
      output: 42,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
      costUsd: 0,
    });
    expect(outcome?.unpriced).toBe(false);
  });

  it("is zero cost even for a model id the price table knows", async () => {
    const { adapter } = setup("text");
    const { outcome } = await run(adapter, textRequest("ollama-anthropic/claude-sonnet-5-5"));
    expect(outcome?.usage?.costUsd).toBe(0);
    expect(outcome?.unpriced).toBe(false);
  });

  it("emits parallel tool calls with parsed input", async () => {
    const { adapter, replay } = setup("parallel-tools");
    const { events } = await run(adapter, { ...textRequest(REF), tools: [weatherTool] });
    expect(events.filter((e) => e.type === "tool_call")).toEqual([
      { type: "tool_call", id: "toolu_ollama_A", name: "weather", input: { city: "Paris" } },
      { type: "tool_call", id: "toolu_ollama_B", name: "weather", input: { city: "Tokyo" } },
    ]);
    expect(events.at(-1)).toEqual({ type: "finish", reason: "tool_calls" });
    const tools = ((replay.requests[0]?.body ?? {}) as { tools?: { name: string }[] }).tools ?? [];
    expect(tools.map((t) => t.name)).toEqual(["weather"]);
  });

  it("round-trips thinking and sends tool results and images back", async () => {
    const first = setup("text");
    const turn = await accumulate(first.adapter.stream(textRequest(REF)));
    const second = setup("text");
    await run(second.adapter, {
      model: REF,
      messages: [
        { role: "user", parts: [{ type: "text", text: "Weather?" }] },
        {
          role: "assistant",
          parts: [
            ...turn.parts,
            { type: "tool_call", id: "toolu_ollama_A", name: "weather", input: { city: "Paris" } },
          ],
        },
        {
          role: "tool",
          parts: [{ type: "tool_result", callId: "toolu_ollama_A", output: { tempC: 18 } }],
        },
        {
          role: "user",
          parts: [{ type: "image", mime: "image/png", data: PNG }],
        },
      ],
      tools: [weatherTool],
    });
    const messages = messagesOf(second.replay.requests[0]?.body);
    const assistant = messages.find((m) => m.role === "assistant");
    expect(assistant?.content[0]).toEqual({
      type: "thinking",
      thinking: "The user wants a greeting.",
      signature: "ollama-fixture-sig-0001",
    });
    expect(assistant?.content.at(-1)).toMatchObject({
      type: "tool_use",
      id: "toolu_ollama_A",
      name: "weather",
      input: { city: "Paris" },
    });
    const user = messages.at(-1);
    expect(user?.role).toBe("user");
    expect(user?.content).toEqual([
      expect.objectContaining({
        type: "tool_result",
        tool_use_id: "toolu_ollama_A",
        content: '{"tempC":18}',
      }),
      expect.objectContaining({
        type: "image",
        source: { type: "base64", media_type: "image/png", data: PNG },
      }),
    ]);
  });

  it.each([
    ["error-429", "rate_limited", 2],
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
    const events: ModelEvent[] = [];
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
  "anthropic-compatible (replayed Ollama /v1/messages)",
  () => {
    const repeat = repeatFetchLocal(fx("text"));
    const adapter = makeAdapter(CONFIG, repeat.fetch).adapter;
    // `AiSdkAdapter.embed` exists on every kind, but this kind has no embeddings: expose the
    // provider without it so the suite's "when embed is offered" check applies.
    const provider: ModelProvider = {
      id: adapter.id,
      stream: (request, options) => adapter.stream(request, options),
      capabilities: (model) => adapter.capabilities(model),
    };
    return provider;
  },
  { request: () => textRequest(REF) },
);
