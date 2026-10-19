import type { ModelRequest } from "@psyche/protocol";
import { collect } from "@psyche/testing";
import { describeModelProviderConformance } from "@psyche/testing/conformance";
import { describe, expect, it } from "vitest";
import prices from "../src/data/prices.json" with { type: "json" };
import {
  type AiSdkAdapter,
  accumulate,
  type CallOutcome,
  isEnvelope,
  type ProviderConfig,
} from "../src/index.ts";
import { makeAdapter, textRequest, weatherTool } from "./helpers/adapters.ts";
import { repeatFetch } from "./helpers/repeat.ts";
import { loadFixture, replayFetch } from "./helpers/replay.ts";

const fx = (name: string) => loadFixture(`openai/${name}.json`);
const MODEL = "gpt-6.1-sol";
const REF = `openai/${MODEL}`;
const KEY = { secret: "sk-fx-openai-000111222", origin: "https://api.openai.com" };
const CONFIG: ProviderConfig = {
  id: "openai",
  kind: "openai",
  embeddingModels: ["text-embedding-3-small"],
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

type InputItem = Record<string, unknown>;

describe("openai adapter (Responses API, recorded fixtures)", () => {
  it("streams text and a reasoning envelope with the item id and encrypted content", async () => {
    const { adapter, replay } = setup("text");
    const { events, outcome } = await run(adapter, textRequest(REF));
    expect(events.filter((e) => e.type === "text_delta").map((e) => e.text)).toEqual([
      "Hello",
      ", world.",
    ]);
    const deltas = events.filter((e) => e.type === "reasoning" && e.data === null);
    expect(deltas).toEqual([
      {
        type: "reasoning",
        provider: "openai",
        data: null,
        textDelta: "The user wants a greeting.",
      },
    ]);
    const block = events.find(
      (e) => e.type === "reasoning" && isEnvelope(e.data) && e.data.kind === "reasoning",
    );
    expect(block?.type === "reasoning" && block.data).toMatchObject({
      v: 1,
      kind: "reasoning",
      model: MODEL,
      text: "The user wants a greeting.",
      metadata: {
        openai: {
          itemId: "rs_fx_0001",
          reasoningEncryptedContent: "gAAAAABofixture-encrypted-reasoning-0001",
        },
      },
    });
    expect(events.at(-1)).toEqual({ type: "finish", reason: "stop" });
    expect(outcome?.error).toBeUndefined();
    expect(outcome?.contentStarted).toBe(true);

    const sent = replay.requests[0];
    expect(sent?.url).toBe("https://api.openai.com/v1/responses");
    const body = sent?.body as Record<string, unknown>;
    expect(body.model).toBe(MODEL);
    expect(body.stream).toBe(true);
    // Privacy default: nothing stored provider-side, encrypted reasoning requested back.
    expect(body.store).toBe(false);
    expect(body.include).toContain("reasoning.encrypted_content");
  });

  it("reports usage by class with cost from the price table entry", async () => {
    const { adapter } = setup("text");
    const { events, outcome } = await run(adapter, textRequest(REF));
    const usage = events.find((e) => e.type === "usage");
    // input_tokens 5000 of which 4096 cached; output 120 of which 64 reasoning.
    expect(usage?.type === "usage" && usage.usage).toMatchObject({
      input: 904,
      cacheRead: 4096,
      cacheWrite: 0,
      output: 120,
      reasoning: 64,
    });
    const p = prices.models[REF];
    const expected = (904 * p.input + 4096 * p.cacheRead + 120 * p.output) / 1e6;
    expect(usage?.type === "usage" && usage.usage.costUsd).toBeCloseTo(expected, 9);
    expect(outcome?.providerCost).toBe(false);
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
    expect(events.filter((e) => e.type === "tool_call")).toEqual([
      { type: "tool_call", id: "call_fx_A", name: "weather", input: { city: "Paris" } },
      { type: "tool_call", id: "call_fx_B", name: "weather", input: { city: "Tokyo" } },
    ]);
    // The function_call item ids travel as part metadata for the next turn.
    const meta = events.filter(
      (e) => e.type === "reasoning" && isEnvelope(e.data) && e.data.kind === "part-metadata",
    );
    expect(meta.map((e) => e.type === "reasoning" && e.data)).toEqual([
      expect.objectContaining({ part: "tool_call", toolCallId: "call_fx_A" }),
      expect.objectContaining({ part: "tool_call", toolCallId: "call_fx_B" }),
    ]);
    expect(events.at(-1)).toEqual({ type: "finish", reason: "tool_calls" });
    const tools = ((replay.requests[0]?.body ?? {}) as { tools?: { type: string; name: string }[] })
      .tools;
    expect(tools?.map((t) => [t.type, t.name])).toEqual([["function", "weather"]]);
  });

  it("round-trips encrypted reasoning and sends tool results and images back", async () => {
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
            { type: "tool_call", id: "call_fx_A", name: "weather", input: { city: "Paris" } },
          ],
        },
        {
          role: "tool",
          parts: [
            { type: "tool_result", callId: "call_fx_A", output: { tempC: 18 } },
            {
              type: "tool_result",
              callId: "call_fx_shot",
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
          parts: [{ type: "image", mime: "image/png", data: "iVBORw0KGgoAAAANSUhEUg==" }],
        },
      ],
      tools: [weatherTool],
    };
    await run(second.adapter, request);
    const body = second.replay.requests[0]?.body as { input: InputItem[]; store: unknown };
    expect(body.store).toBe(false);
    const reasoning = body.input.filter((i) => i.type === "reasoning");
    expect(reasoning).toEqual([
      {
        type: "reasoning",
        id: "rs_fx_0001",
        encrypted_content: "gAAAAABofixture-encrypted-reasoning-0001",
        summary: [{ type: "summary_text", text: "The user wants a greeting." }],
      },
    ]);
    // Reasoning precedes the assistant text it belongs to.
    const rIdx = body.input.findIndex((i) => i.type === "reasoning");
    const aIdx = body.input.findIndex((i) => i.role === "assistant");
    expect(rIdx).toBeGreaterThanOrEqual(0);
    expect(rIdx).toBeLessThan(aIdx);
    expect(body.input).toContainEqual(
      expect.objectContaining({ type: "function_call", call_id: "call_fx_A", name: "weather" }),
    );
    expect(body.input).toContainEqual({
      type: "function_call_output",
      call_id: "call_fx_A",
      output: JSON.stringify({ tempC: 18 }),
    });
    const shot = body.input.find(
      (i) => i.type === "function_call_output" && i.call_id === "call_fx_shot",
    );
    expect(shot?.output).toEqual([
      { type: "input_text", text: "the page" },
      expect.objectContaining({
        type: "input_image",
        image_url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==",
      }),
    ]);
    const lastUser = body.input.at(-1) as { role: string; content: InputItem[] };
    expect(lastUser.role).toBe("user");
    expect(lastUser.content).toEqual([
      expect.objectContaining({
        type: "input_image",
        image_url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==",
      }),
    ]);
  });

  it("drops reasoning from another model on fallback", async () => {
    const { adapter, replay } = setup("text");
    await run(adapter, {
      model: REF,
      messages: [
        { role: "user", parts: [{ type: "text", text: "hi" }] },
        {
          role: "assistant",
          parts: [
            {
              type: "reasoning",
              provider: "openai",
              data: {
                v: 1,
                kind: "reasoning",
                model: "gpt-6-luna",
                text: "x",
                metadata: {
                  openai: { itemId: "rs_other", reasoningEncryptedContent: "enc_other" },
                },
              },
            },
            { type: "text", text: "hello" },
          ],
        },
        { role: "user", parts: [{ type: "text", text: "again" }] },
      ],
    });
    const flat = JSON.stringify(replay.requests[0]?.body);
    expect(flat).not.toContain("rs_other");
    expect(flat).not.toContain("enc_other");
  });

  it.each([
    ["error-429", "rate_limited", 7],
    ["error-500", "server_error", undefined],
    ["error-503", "server_error", undefined],
    ["error-401", "auth", undefined],
    ["error-400-context", "context_overflow", undefined],
    ["failed-stream", "server_error", undefined],
    ["error-event", "rate_limited", undefined],
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
    expect(JSON.stringify(events)).not.toContain(KEY.secret);
  });

  it("ends with finish{cancelled} when aborted mid-stream", async () => {
    const { adapter } = setup("hang");
    const ac = new AbortController();
    const events = [];
    let outcome: CallOutcome | undefined;
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
  "openai (replayed Responses API)",
  () => {
    const { fetch } = repeatFetch(fx("text"), fx("embeddings"));
    return makeAdapter(CONFIG, fetch, KEY).adapter;
  },
  { request: () => textRequest(REF) },
);
