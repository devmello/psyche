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
import { fakeKey, makeAdapter, textRequest, weatherTool } from "./helpers/adapters.ts";
import { repeatFetch } from "./helpers/repeat.ts";
import { loadFixture, replayFetch } from "./helpers/replay.ts";

const fx = (name: string) => loadFixture(`llamacpp/${name}.json`);
const MODEL = "qwen3.8-27b";
const REF = `llamacpp/${MODEL}`;
/** No baseURL: the kind defaults to llama-server's `http://127.0.0.1:8080/v1`. */
const CONFIG: ProviderConfig = {
  id: "llamacpp",
  kind: "llamacpp",
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
const bodyOf = (replay: ReturnType<typeof replayFetch>) =>
  replay.requests[0]?.body as Record<string, unknown> & {
    messages: WireMessage[];
    tools?: { function: { name: string } }[];
  };

describe("llamacpp adapter (llama-server, recorded fixtures)", () => {
  it("streams reasoning, text and usage from the default local endpoint", async () => {
    const { adapter, replay } = setup("text");
    const { events, outcome } = await run(adapter, textRequest(REF));
    const block = events.find(
      (e) => e.type === "reasoning" && isEnvelope(e.data) && e.data.kind === "reasoning",
    );
    expect(block?.type === "reasoning" && block.data).toMatchObject({ text: "Greet briefly." });
    expect(events.filter((e) => e.type === "text_delta").map((e) => e.text)).toEqual([
      "Hello",
      ", world.",
    ]);
    const usage = events.find((e) => e.type === "usage");
    expect(usage?.type === "usage" && usage.usage).toEqual({
      input: 18,
      cacheRead: 20,
      cacheWrite: 0,
      output: 9,
      reasoning: 0,
      costUsd: 0,
    });
    expect(events.at(-1)).toEqual({ type: "finish", reason: "stop" });
    expect(outcome?.error).toBeUndefined();
    expect(outcome?.unpriced).toBe(false);

    const sent = replay.requests[0];
    expect(sent?.url).toBe("http://127.0.0.1:8080/v1/chat/completions");
    expect(sent?.headers.authorization).toBeUndefined();
    expect(JSON.stringify(sent)).not.toContain(KEY_SENTINEL);
    const body = bodyOf(replay);
    expect(body.model).toBe(MODEL);
    expect(body.stream_options).toEqual({ include_usage: true });
  });

  it("builds usage from llama.cpp timings when an older build sends no usage", async () => {
    const { adapter } = setup("timings-only");
    const { events } = await run(adapter, textRequest(REF));
    const usage = events.find((e) => e.type === "usage");
    expect(usage?.type === "usage" && usage.usage).toMatchObject({
      input: 18,
      cacheRead: 20,
      output: 9,
    });
    expect(events.at(-1)).toEqual({ type: "finish", reason: "stop" });
  });

  it("emits parallel tool calls with parsed input", async () => {
    const { adapter, replay } = setup("parallel-tools");
    const { events } = await run(adapter, { ...textRequest(REF), tools: [weatherTool] });
    expect(events.filter((e) => e.type === "tool_call")).toEqual([
      { type: "tool_call", id: "call_lcA", name: "weather", input: { city: "Paris" } },
      { type: "tool_call", id: "call_lcB", name: "weather", input: { city: "Tokyo" } },
    ]);
    expect(events.at(-1)).toEqual({ type: "finish", reason: "tool_calls" });
    expect(bodyOf(replay).tools?.map((t) => t.function.name)).toEqual(["weather"]);
  });

  it("repairs llama-server tool-call quirks: shared index, empty id, object arguments, finish stop", async () => {
    const { adapter } = setup("parallel-tools-quirks");
    const { events } = await run(adapter, { ...textRequest(REF), tools: [weatherTool] });
    expect(events.filter((e) => e.type === "tool_call")).toEqual([
      { type: "tool_call", id: "call_qA", name: "weather", input: { city: "Paris" } },
      { type: "tool_call", id: "call_qB", name: "weather", input: { city: "Tokyo" } },
    ]);
    expect(events.at(-1)).toEqual({ type: "finish", reason: "tool_calls" });
  });

  it("maps provider-unsafe tool names and back", async () => {
    const { adapter, replay } = setup("parallel-tools");
    const dotted = { ...weatherTool, name: "weather" };
    const long = { ...weatherTool, name: `mcp__${"x".repeat(80)}.lookup` };
    await run(adapter, { ...textRequest(REF), tools: [dotted, long] });
    const names = bodyOf(replay).tools?.map((t) => t.function.name) ?? [];
    expect(names[0]).toBe("weather");
    expect(names[1]).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
  });

  it("sends a forced tool as tool_choice required with only that tool", async () => {
    const { adapter, replay } = setup("parallel-tools");
    const other = { ...weatherTool, name: "gmail.search" };
    await run(adapter, {
      ...textRequest(REF),
      tools: [weatherTool, other],
      toolChoice: { tool: "weather" },
    });
    const body = bodyOf(replay);
    expect(body.tool_choice).toBe("required");
    expect(body.tools?.map((t) => t.function.name)).toEqual(["weather"]);
  });

  it("round-trips reasoning, tool calls, tool results and images", async () => {
    const turn = await accumulate(setup("text").adapter.stream(textRequest(REF)));
    const second = setup("text");
    await run(second.adapter, {
      model: REF,
      messages: [
        { role: "user", parts: [{ type: "text", text: "Weather?" }] },
        {
          role: "assistant",
          parts: [
            ...turn.parts,
            { type: "tool_call", id: "call_lcA", name: "weather", input: { city: "Paris" } },
          ],
        },
        {
          role: "tool",
          parts: [{ type: "tool_result", callId: "call_lcA", output: { tempC: 18 } }],
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
    });
    const body = bodyOf(second.replay);
    expect(body.messages.find((m) => m.role === "assistant")).toMatchObject({
      reasoning_content: "Greet briefly.",
      tool_calls: [{ id: "call_lcA", function: { name: "weather" } }],
    });
    expect(body.messages).toContainEqual({
      role: "tool",
      tool_call_id: "call_lcA",
      content: JSON.stringify({ tempC: 18 }),
    });
    expect(JSON.stringify(body.messages.at(-1))).toContain("data:image/png;base64,");
  });

  it("sends the key as a bearer token to a server started with --api-key", async () => {
    const replay = replayFetch(fx("text"));
    const secret = fakeKey("llamacpp");
    const { adapter } = makeAdapter(CONFIG, replay.fetch, {
      secret,
      origin: "http://127.0.0.1:8080",
    });
    await run(adapter, textRequest(REF));
    expect(replay.requests[0]?.headers.authorization).toBe(`Bearer ${secret}`);
  });

  it.each([
    ["error-500", "server_error"],
    ["error-503", "server_error"],
    ["error-401", "auth"],
    ["error-400-context", "context_overflow"],
    ["error-midstream", "server_error"],
    ["error-jinja", "bad_request"],
  ])("maps %s to %s", async (name, kind) => {
    const { adapter } = setup(name);
    const { events, outcome } = await run(adapter, { ...textRequest(REF), tools: [weatherTool] });
    const last = events.at(-1);
    expect(last).toMatchObject({ type: "finish", reason: "error" });
    expect(last?.type === "finish" && last.error?.startsWith(`${kind}:`)).toBe(true);
    expect(outcome?.error?.kind).toBe(kind);
    expect(outcome?.contentStarted).toBe(false);
  });

  it("says why tools fail on a server started without --jinja", async () => {
    const { adapter } = setup("error-jinja");
    const { outcome } = await run(adapter, { ...textRequest(REF), tools: [weatherTool] });
    expect(outcome?.error?.message).toContain("--jinja");
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

  it("reports local capabilities: zero cost, no prompt caching, name guesses, learned facts", async () => {
    const { adapter } = setup();
    expect(await adapter.capabilities(REF)).toMatchObject({
      toolCalling: true,
      reasoning: true,
      vision: false,
      promptCaching: false,
    });
    adapter.learn([{ id: MODEL, capabilities: { contextWindow: 32768, toolCalling: false } }]);
    expect(await adapter.capabilities(REF)).toMatchObject({
      contextWindow: 32768,
      toolCalling: false,
    });
  });
});

describeModelProviderConformance(
  "llamacpp (replayed llama-server)",
  () => {
    const { fetch } = repeatFetch(fx("text"), fx("embeddings"));
    return makeAdapter(CONFIG, fetch).adapter;
  },
  { request: () => textRequest(REF) },
);

describeModelProviderConformance(
  "llamacpp tool calls (replayed llama-server)",
  () => {
    const { fetch } = repeatFetch(fx("parallel-tools-quirks"), fx("embeddings"));
    return makeAdapter(CONFIG, fetch).adapter;
  },
  { request: () => ({ ...textRequest(REF), tools: [weatherTool] }) },
);
