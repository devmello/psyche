import type { ModelEvent, ModelRequest } from "@psyche/protocol";
import { collect } from "@psyche/testing";
import { describeModelProviderConformance } from "@psyche/testing/conformance";
import { describe, expect, it } from "vitest";
import {
  type AiSdkAdapter,
  accumulate,
  BUNDLED_PRICES,
  type CallOutcome,
  isEnvelope,
  type ProviderConfig,
} from "../src/index.ts";
import { fakeKey, makeAdapter, textRequest, weatherTool } from "./helpers/adapters.ts";
import { repeatFetchLocal } from "./helpers/repeat-local.ts";
import { loadFixture, replayFetch } from "./helpers/replay.ts";

const fx = (name: string) => loadFixture(`google/${name}.json`);
const REF = "google/gemini-4-argon";
const SECRET = fakeKey("google");
const ORIGIN = "https://generativelanguage.googleapis.com";
const CONFIG: ProviderConfig = { id: "google", kind: "google" };
const PNG = "iVBORw0KGgoAAAANSUhEUg==";

function setup(...fixtures: string[]) {
  const replay = replayFetch(...fixtures.map(fx));
  const { adapter, broker } = makeAdapter(CONFIG, replay.fetch, { secret: SECRET, origin: ORIGIN });
  return { adapter, broker, replay };
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

type Step = Record<string, unknown> & { type: string };
const stepsOf = (body: unknown) => (body as { input: Step[] }).input;

describe("google adapter (Gemini Interactions API, recorded fixtures)", () => {
  it("streams text and a signed thought, with privacy defaults in the body", async () => {
    const { adapter, replay } = setup("text");
    const { events, outcome } = await run(adapter, textRequest(REF));
    expect(events.filter((e) => e.type === "text_delta").map((e) => e.text)).toEqual([
      "Hello",
      ", world.",
    ]);
    const deltas = events.filter((e) => e.type === "reasoning" && e.data === null);
    expect(deltas.map((e) => e.type === "reasoning" && e.textDelta)).toEqual([
      "The user wants a greeting.",
    ]);
    const block = events.find(
      (e) => e.type === "reasoning" && isEnvelope(e.data) && e.data.kind === "reasoning",
    );
    expect(block?.type === "reasoning" && block.data).toMatchObject({
      v: 1,
      kind: "reasoning",
      model: "gemini-4-argon",
      text: "The user wants a greeting.",
      metadata: { google: { signature: "CtYBAVSoXO-fixture-thought-sig-0001" } },
    });
    expect(events.at(-1)).toEqual({ type: "finish", reason: "stop" });
    expect(outcome?.error).toBeUndefined();

    const sent = replay.requests[0];
    expect(sent?.method).toBe("POST");
    expect(sent?.url).toBe(`${ORIGIN}/v1beta/interactions`);
    const body = sent?.body as Record<string, unknown>;
    expect(body).toMatchObject({
      model: "gemini-4-argon",
      stream: true,
      store: false,
      system_instruction: "You are terse.",
      generation_config: { max_output_tokens: 256 },
    });
    expect(stepsOf(body)).toEqual([
      { type: "user_input", content: [{ type: "text", text: "Say hello." }] },
    ]);
  });

  it("injects the vault key into x-goog-api-key only, never the URL or body", async () => {
    const { adapter, replay } = setup("text");
    await run(adapter, textRequest(REF));
    const sent = replay.requests[0];
    expect(sent?.headers["x-goog-api-key"]).toBe(SECRET);
    expect(sent?.url).not.toContain(SECRET);
    expect(sent?.url).not.toContain("key=");
    expect(JSON.stringify(sent?.body)).not.toContain(SECRET);
    expect(JSON.stringify(sent?.headers)).not.toContain("psyche-key-injected-at-fetch");
  });

  it("reports usage by class with cost from the price table", async () => {
    const { adapter } = setup("text");
    let outcome: CallOutcome | undefined;
    const events = await collect(
      adapter.stream(textRequest(REF), {
        onOutcome: (o) => {
          outcome = o;
        },
      }),
    );
    const usage = events.find((e) => e.type === "usage");
    // 1200 prompt tokens of which 800 cached; 42 text + 30 thought tokens, billed as output.
    expect(usage?.type === "usage" && usage.usage).toMatchObject({
      input: 400,
      cacheRead: 800,
      cacheWrite: 0,
      output: 72,
      reasoning: 30,
    });
    const price = BUNDLED_PRICES.models[REF];
    expect(price).toBeDefined();
    const p = price ?? { input: Number.NaN, output: Number.NaN };
    const readRate = price?.cacheRead ?? p.input;
    const expected = (400 * p.input + 800 * readRate + 72 * p.output) / 1e6;
    expect(usage?.type === "usage" && usage.usage.costUsd).toBeCloseTo(expected, 9);
    expect(outcome?.unpriced).toBe(false);
    expect(outcome?.providerCost).toBe(false);
    expect(outcome?.usage).toEqual(usage?.type === "usage" ? usage.usage : undefined);
  });

  it("emits parallel function calls with parsed input and signature envelopes", async () => {
    const { adapter, replay } = setup("parallel-tools");
    const { events } = await run(adapter, { ...textRequest(REF), tools: [weatherTool] });
    expect(events.filter((e) => e.type === "tool_call")).toEqual([
      { type: "tool_call", id: "fc_paris", name: "weather", input: { city: "Paris" } },
      { type: "tool_call", id: "fc_tokyo", name: "weather", input: { city: "Tokyo" } },
    ]);
    const meta = events.filter(
      (e) => e.type === "reasoning" && isEnvelope(e.data) && e.data.kind === "part-metadata",
    );
    expect(meta[0]).toMatchObject({
      type: "reasoning",
      provider: "google",
      data: {
        kind: "part-metadata",
        part: "tool_call",
        toolCallId: "fc_paris",
        metadata: { google: { signature: "CiQBfixture-fc-sig-0001" } },
      },
    });
    expect(events.at(-1)).toEqual({ type: "finish", reason: "tool_calls" });
    const tools =
      ((replay.requests[0]?.body ?? {}) as { tools?: Record<string, unknown>[] }).tools ?? [];
    expect(tools).toEqual([expect.objectContaining({ type: "function", name: "weather" })]);
  });

  it("sends function-call signatures back on the same call, with tool results and images", async () => {
    const first = setup("parallel-tools");
    const turn = await accumulate(
      first.adapter.stream({ ...textRequest(REF), tools: [weatherTool] }),
    );
    expect(turn.toolCalls().map((c) => c.id)).toEqual(["fc_paris", "fc_tokyo"]);

    const second = setup("text");
    const request: ModelRequest = {
      model: REF,
      messages: [
        { role: "user", parts: [{ type: "text", text: "Weather in Paris and Tokyo?" }] },
        turn.message(),
        {
          role: "tool",
          parts: [
            { type: "tool_result", callId: "fc_paris", output: { tempC: 18 } },
            {
              type: "tool_result",
              callId: "fc_tokyo",
              output: [
                { type: "text", text: "radar" },
                { type: "image", mime: "image/png", data: PNG },
              ],
            },
          ],
        },
        {
          role: "user",
          parts: [
            { type: "text", text: "And this map?" },
            { type: "image", mime: "image/png", data: PNG },
          ],
        },
      ],
      tools: [weatherTool],
    };
    await run(second.adapter, request);
    const steps = stepsOf(second.replay.requests[0]?.body);
    const calls = steps.filter((s) => s.type === "function_call");
    expect(calls).toEqual([
      {
        type: "function_call",
        id: "fc_paris",
        name: "weather",
        arguments: { city: "Paris" },
        signature: "CiQBfixture-fc-sig-0001",
      },
      { type: "function_call", id: "fc_tokyo", name: "weather", arguments: { city: "Tokyo" } },
    ]);
    const results = steps.find(
      (s) =>
        s.type === "user_input" && JSON.stringify(s.content).includes('"type":"function_result"'),
    );
    expect(results?.content).toEqual([
      { type: "function_result", call_id: "fc_paris", name: "weather", result: '{"tempC":18}' },
      {
        type: "function_result",
        call_id: "fc_tokyo",
        name: "weather",
        result: [
          { type: "text", text: "radar" },
          { type: "image", data: PNG, mime_type: "image/png" },
        ],
      },
    ]);
    expect(steps.at(-1)).toEqual({
      type: "user_input",
      content: [
        { type: "text", text: "And this map?" },
        { type: "image", data: PNG, mime_type: "image/png" },
      ],
    });
  });

  it("round-trips the thought signature verbatim on the next request", async () => {
    const first = setup("text");
    const turn = await accumulate(first.adapter.stream(textRequest(REF)));
    const second = setup("text");
    await run(second.adapter, {
      model: REF,
      messages: [
        { role: "user", parts: [{ type: "text", text: "Say hello." }] },
        turn.message(),
        { role: "user", parts: [{ type: "text", text: "Again." }] },
      ],
    });
    const steps = stepsOf(second.replay.requests[0]?.body);
    expect(steps.map((s) => s.type)).toEqual([
      "user_input",
      "thought",
      "model_output",
      "user_input",
    ]);
    expect(steps[1]).toEqual({
      type: "thought",
      signature: "CtYBAVSoXO-fixture-thought-sig-0001",
      summary: [{ type: "text", text: "The user wants a greeting." }],
    });
    expect(steps[2]).toEqual({
      type: "model_output",
      content: [{ type: "text", text: "Hello, world." }],
    });
  });

  it("drops signatures from another model on fallback", async () => {
    const first = setup("parallel-tools");
    const turn = await accumulate(
      first.adapter.stream({ ...textRequest(REF), tools: [weatherTool] }),
    );
    const second = setup("text");
    await run(second.adapter, {
      model: "google/gemini-4-flash",
      messages: [
        { role: "user", parts: [{ type: "text", text: "Weather?" }] },
        turn.message(),
        {
          role: "tool",
          parts: [
            { type: "tool_result", callId: "fc_paris", output: "18C" },
            { type: "tool_result", callId: "fc_tokyo", output: "22C" },
          ],
        },
      ],
      tools: [weatherTool],
    });
    const flat = JSON.stringify(second.replay.requests[0]?.body);
    expect(flat).toContain('"id":"fc_paris"');
    expect(flat).not.toContain("CiQBfixture-fc-sig-0001");
  });

  it.each([
    ["error-429", "rate_limited", 7],
    ["error-500", "server_error", undefined],
    ["error-503", "server_error", undefined],
    ["error-503-overloaded", "overloaded", undefined],
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
    expect(JSON.stringify(events)).not.toContain(SECRET);
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
    expect(outcome?.contentStarted).toBe(true);
  });
});

describeModelProviderConformance(
  "google (replayed Interactions API)",
  () => {
    const repeat = repeatFetchLocal(fx("text"), fx("embed"));
    return makeAdapter({ ...CONFIG, embeddingModels: ["gemini-embedding-001"] }, repeat.fetch, {
      secret: SECRET,
      origin: ORIGIN,
    }).adapter;
  },
  { request: () => textRequest(REF) },
);
