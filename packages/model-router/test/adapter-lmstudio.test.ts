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

const fx = (name: string) => loadFixture(`lmstudio/${name}.json`);
/** LM Studio model ids carry the publisher: refs are `lmstudio/qwen/qwen3.8-27b`. */
const MODEL = "qwen/qwen3.8-27b";
const REF = `lmstudio/${MODEL}`;
const CONFIG: ProviderConfig = {
  id: "lmstudio",
  kind: "lmstudio",
  embeddingModels: ["text-embedding-nomic-embed-text-v1.5"],
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

const bodyOf = (replay: ReturnType<typeof replayFetch>) =>
  replay.requests[0]?.body as Record<string, unknown> & {
    messages: (Record<string, unknown> & { role: string })[];
    tools?: { function: { name: string } }[];
  };

describe("lmstudio adapter (LM Studio, recorded fixtures)", () => {
  it("streams `reasoning` deltas, text and usage from the default endpoint", async () => {
    const { adapter, replay } = setup("text");
    const { events, outcome } = await run(adapter, textRequest(REF));
    const block = events.find(
      (e) => e.type === "reasoning" && isEnvelope(e.data) && e.data.kind === "reasoning",
    );
    expect(block?.type === "reasoning" && block.data).toMatchObject({
      model: MODEL,
      text: "Greet briefly.",
    });
    expect(events.filter((e) => e.type === "text_delta").map((e) => e.text)).toEqual([
      "Hello",
      ", world.",
    ]);
    const usage = events.find((e) => e.type === "usage");
    expect(usage?.type === "usage" && usage.usage).toEqual({
      input: 25,
      cacheRead: 0,
      cacheWrite: 0,
      output: 7,
      reasoning: 0,
      costUsd: 0,
    });
    expect(events.at(-1)).toEqual({ type: "finish", reason: "stop" });
    expect(outcome?.error).toBeUndefined();

    const sent = replay.requests[0];
    expect(sent?.url).toBe("http://127.0.0.1:1234/v1/chat/completions");
    expect(sent?.headers.authorization).toBeUndefined();
    expect(JSON.stringify(sent)).not.toContain(KEY_SENTINEL);
    expect(bodyOf(replay).model).toBe(MODEL);
  });

  it("emits parallel tool calls", async () => {
    const { adapter } = setup("parallel-tools");
    const { events } = await run(adapter, { ...textRequest(REF), tools: [weatherTool] });
    expect(events.filter((e) => e.type === "tool_call")).toEqual([
      { type: "tool_call", id: "592013376", name: "weather", input: { city: "Paris" } },
      { type: "tool_call", id: "118301147", name: "weather", input: { city: "Tokyo" } },
    ]);
    expect(events.at(-1)).toEqual({ type: "finish", reason: "tool_calls" });
    const usage = events.find((e) => e.type === "usage");
    expect(usage?.type === "usage" && usage.usage).toMatchObject({ input: 280, output: 44 });
  });

  it("sends a forced tool as tool_choice required with only that tool", async () => {
    const { adapter, replay } = setup("parallel-tools");
    await run(adapter, {
      ...textRequest(REF),
      tools: [weatherTool, { ...weatherTool, name: "files.read" }],
      toolChoice: { tool: "files.read" },
    });
    const body = bodyOf(replay);
    expect(body.tool_choice).toBe("required");
    expect(body.tools?.map((t) => t.function.name)).toEqual(["files_read"]);
  });

  it("round-trips the reasoning and a tool call", async () => {
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
            { type: "tool_call", id: "592013376", name: "weather", input: { city: "Paris" } },
          ],
        },
        { role: "tool", parts: [{ type: "tool_result", callId: "592013376", output: "18C" }] },
      ],
      tools: [weatherTool],
    });
    const assistant = bodyOf(second.replay).messages.find((m) => m.role === "assistant");
    expect(assistant).toMatchObject({
      tool_calls: [{ id: "592013376", function: { name: "weather" } }],
    });
    expect(typeof assistant?.content).toBe("string");
  });

  it.each([
    ["error-404", "model_not_found", "not found"],
    ["error-400-context", "context_overflow", "context length"],
    ["error-500", "server_error", "crashed"],
    ["error-401", "auth", "API token"],
  ])("maps %s to %s and keeps LM Studio's plain-string message", async (name, kind, text) => {
    const { adapter } = setup(name);
    const { events, outcome } = await run(adapter, textRequest(REF));
    expect(events.at(-1)).toMatchObject({ type: "finish", reason: "error" });
    expect(outcome?.error?.kind).toBe(kind);
    expect(outcome?.error?.message).toContain(text);
  });

  it("ends with finish{cancelled} when aborted mid-stream", async () => {
    const { adapter } = setup("hang");
    const ac = new AbortController();
    const events = [];
    for await (const e of adapter.stream(textRequest(REF), { signal: ac.signal })) {
      events.push(e);
      if (e.type === "text_delta") ac.abort();
    }
    expect(events.at(-1)).toEqual({ type: "finish", reason: "cancelled" });
  });

  it("embeds through /v1/embeddings", async () => {
    const { adapter, replay } = setup("embeddings");
    const vectors = await adapter.embed(["alpha", "beta"]);
    expect(vectors).toEqual([
      [0.25, 0.5, -0.75],
      [-0.25, -0.5, 0.75],
    ]);
    expect(replay.requests[0]?.url).toBe("http://127.0.0.1:1234/v1/embeddings");
  });
});

describeModelProviderConformance(
  "lmstudio (replayed LM Studio)",
  () => {
    const { fetch } = repeatFetch(fx("text"), fx("embeddings"));
    return makeAdapter(CONFIG, fetch).adapter;
  },
  { request: () => textRequest(REF) },
);

describeModelProviderConformance(
  "lmstudio tool calls (replayed LM Studio)",
  () => {
    const { fetch } = repeatFetch(fx("parallel-tools"), fx("embeddings"));
    return makeAdapter(CONFIG, fetch).adapter;
  },
  { request: () => ({ ...textRequest(REF), tools: [weatherTool] }) },
);
