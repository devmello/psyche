import type { ModelRequest } from "@psyche/protocol";
import { collect } from "@psyche/testing";
import { describeModelProviderConformance } from "@psyche/testing/conformance";
import { describe, expect, it } from "vitest";
import {
  type AiSdkAdapter,
  accumulate,
  BUNDLED_PRICES,
  type CallOutcome,
  KEY_SENTINEL,
  type ProviderConfig,
} from "../src/index.ts";
import { fakeKey, makeAdapter, textRequest, weatherTool } from "./helpers/adapters.ts";
import { repeatFetchLocal } from "./helpers/repeat-local.ts";
import { loadFixture, replayFetch } from "./helpers/replay.ts";

const fx = (name: string) => loadFixture(`google-gc/${name}.json`);
const MODEL = "gemini-3.8-flash";
const REF = `google/${MODEL}`;
const SECRET = fakeKey("google-gc");
const ORIGIN = "https://generativelanguage.googleapis.com";
const CONFIG: ProviderConfig = {
  id: "google",
  kind: "google",
  googleApi: "generate-content",
  embeddingModels: ["gemini-embedding-001"],
};

function setup(...fixtures: string[]) {
  const replay = replayFetch(...fixtures.map(fx));
  const { adapter } = makeAdapter(CONFIG, replay.fetch, { secret: SECRET, origin: ORIGIN });
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

type Content = { role: string; parts: Record<string, unknown>[] };
const bodyOf = (replay: ReturnType<typeof replayFetch>) =>
  replay.requests[0]?.body as {
    contents: Content[];
    tools?: { functionDeclarations: { name: string }[] }[];
    systemInstruction?: unknown;
  };

describe("google adapter (Gemini API streamGenerateContent, recorded fixtures)", () => {
  it("streams thoughts and text, with the key only in the vault-resolved header", async () => {
    const { adapter, replay } = setup("text");
    const { events, outcome } = await run(adapter, textRequest(REF));
    expect(events.filter((e) => e.type === "text_delta").map((e) => e.text)).toEqual([
      "Hello",
      ", world.",
    ]);
    const thoughts = events.filter((e) => e.type === "reasoning" && e.data === null);
    expect(thoughts.map((e) => e.type === "reasoning" && e.textDelta)).toEqual(["Greet briefly."]);
    expect(events.at(-1)).toEqual({ type: "finish", reason: "stop" });
    expect(outcome?.error).toBeUndefined();

    const sent = replay.requests[0];
    expect(sent?.url).toBe(`${ORIGIN}/v1beta/models/${MODEL}:streamGenerateContent?alt=sse`);
    expect(sent?.headers["x-goog-api-key"]).toBe(SECRET);
    expect(JSON.stringify(sent?.body)).not.toContain(SECRET);
    expect(JSON.stringify(sent)).not.toContain(KEY_SENTINEL);
    expect(bodyOf(replay).systemInstruction).toBeDefined();
  });

  it("reports usage by class and prices it from the table", async () => {
    const { adapter } = setup("text");
    const { events, outcome } = await run(adapter, textRequest(REF));
    const usage = events.find((e) => e.type === "usage");
    const u = usage?.type === "usage" ? usage.usage : undefined;
    // Output counts thoughts too; reasoning is the thought share of it.
    expect(u).toMatchObject({ input: 30, cacheRead: 10, output: 26, reasoning: 20 });
    const price = BUNDLED_PRICES.models[REF];
    expect(price).toBeDefined();
    expect(u?.costUsd).toBeGreaterThan(0);
    expect(outcome?.unpriced).toBe(false);
  });

  it("emits parallel function calls and sends the signature back", async () => {
    const first = setup("parallel-tools");
    const { events } = await run(first.adapter, { ...textRequest(REF), tools: [weatherTool] });
    const calls = events.filter((e) => e.type === "tool_call");
    expect(calls.map((c) => c.type === "tool_call" && [c.name, c.input])).toEqual([
      ["weather", { city: "Paris" }],
      ["weather", { city: "Tokyo" }],
    ]);
    expect(events.at(-1)).toEqual({ type: "finish", reason: "tool_calls" });

    const turn = await accumulate(
      setup("parallel-tools").adapter.stream({ ...textRequest(REF), tools: [weatherTool] }),
    );
    const second = setup("text");
    const ids = turn.parts.flatMap((p) => (p.type === "tool_call" ? [p.id] : []));
    await run(second.adapter, {
      model: REF,
      messages: [
        { role: "user", parts: [{ type: "text", text: "Weather in Paris and Tokyo?" }] },
        { role: "assistant", parts: turn.parts },
        {
          role: "tool",
          parts: ids.map((id, i) => ({
            type: "tool_result" as const,
            callId: id,
            name: "weather",
            output: { tempC: 18 + i },
          })),
        },
      ],
      tools: [weatherTool],
    });
    const contents = bodyOf(second.replay).contents;
    const model = contents.find((c) => c.role === "model");
    expect(model?.parts[0]).toMatchObject({
      functionCall: { name: "weather", args: { city: "Paris" } },
      thoughtSignature: "CiQBfixture-gc-fc-sig",
    });
    const responses = contents.flatMap((c) => c.parts.filter((p) => "functionResponse" in p));
    expect(responses).toHaveLength(2);
  });

  it("names tools the way Gemini accepts: at most 64 characters, letter or _ first", async () => {
    const { adapter, replay } = setup("parallel-tools");
    const odd = { ...weatherTool, name: `1password.${"x".repeat(90)}` };
    const { events } = await run(adapter, { ...textRequest(REF), tools: [weatherTool, odd] });
    const names = bodyOf(replay).tools?.[0]?.functionDeclarations.map((f) => f.name) ?? [];
    expect(names[0]).toBe("weather");
    expect(names[1]).toMatch(/^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/);
    expect(
      events
        .filter((e) => e.type === "tool_call")
        .every((e) => e.type === "tool_call" && e.name === "weather"),
    ).toBe(true);
  });

  it.each([
    ["error-429", "rate_limited", 7],
    ["error-400-context", "context_overflow", undefined],
    ["error-403", "auth", undefined],
    ["error-404", "model_not_found", undefined],
    ["error-500", "server_error", undefined],
    ["error-503-overloaded", "overloaded", undefined],
  ])("maps %s to %s", async (name, kind, retryAfter) => {
    const { adapter } = setup(name);
    const { events, outcome } = await run(adapter, textRequest(REF));
    expect(events.at(-1)).toMatchObject({ type: "finish", reason: "error" });
    expect(outcome?.error?.kind).toBe(kind);
    expect(outcome?.error?.retryAfterSec).toBe(retryAfter);
    expect(JSON.stringify(events)).not.toContain(SECRET);
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

  it("reports catalog capabilities: vision, tools, context window", async () => {
    const { adapter } = setup();
    expect(await adapter.capabilities(REF)).toMatchObject({
      toolCalling: true,
      vision: true,
      contextWindow: BUNDLED_PRICES.models[REF]?.contextWindow,
    });
  });
});

describeModelProviderConformance(
  "google generate-content (replayed Gemini API)",
  () => {
    const { fetch } = repeatFetchLocal(fx("text"), loadFixture("google/embed.json"));
    return makeAdapter(CONFIG, fetch, { secret: SECRET, origin: ORIGIN }).adapter;
  },
  { request: () => textRequest(REF) },
);
