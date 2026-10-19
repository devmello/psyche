import type { ModelRequest } from "@psyche/protocol";
import { collect, FakeCredentialBroker } from "@psyche/testing";
import { describe, expect, it } from "vitest";
import { type AiSdkAdapter, accumulate, type CallOutcome, isEnvelope } from "../src/index.ts";
import { makeAdapter, textRequest, weatherTool } from "./helpers/adapters.ts";
import { loadFixture, replayFetch } from "./helpers/replay.ts";

const fx = (name: string) => loadFixture(`anthropic/${name}.json`);
const REF = "anthropic/claude-sonnet-5-5";

function setup(...fixtures: string[]) {
  const replay = replayFetch(...fixtures.map(fx));
  const { adapter, broker } = makeAdapter({ id: "anthropic", kind: "anthropic" }, replay.fetch, {
    secret: "sk-ant-fixture-key-000111222",
    origin: "https://api.anthropic.com",
  });
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

describe("anthropic adapter (recorded fixtures)", () => {
  it("streams text and an opaque, signed reasoning block", async () => {
    const { adapter, replay } = setup("text");
    const { events, outcome } = await run(adapter, textRequest(REF));
    expect(events.filter((e) => e.type === "text_delta").map((e) => e.text)).toEqual([
      "Hello",
      ", world.",
    ]);
    const deltas = events.filter((e) => e.type === "reasoning" && e.data === null);
    expect(deltas).toHaveLength(1);
    const block = events.find((e) => e.type === "reasoning" && e.data !== null);
    expect(block?.type === "reasoning" && isEnvelope(block.data)).toBe(true);
    expect(JSON.stringify(block)).toContain("EqQBCkYIBRgCKkBsig-fixture-0001");
    expect(events.at(-1)).toEqual({ type: "finish", reason: "stop" });
    expect(outcome?.error).toBeUndefined();
    // Adaptive thinking is on by default for 5.5 models; prompt caching marks the system prompt.
    const body = replay.requests[0]?.body as Record<string, unknown>;
    expect(body.thinking).toEqual({ type: "adaptive" });
    expect(JSON.stringify(body.system)).toContain("ephemeral");
  });

  it("reports usage by class with cost from the price table", async () => {
    const { adapter } = setup("text");
    const { events } = await run(adapter, textRequest(REF));
    const usage = events.find((e) => e.type === "usage");
    expect(usage?.type === "usage" && usage.usage).toMatchObject({
      input: 12,
      cacheRead: 4096,
      cacheWrite: 2048,
      output: 42,
    });
    // $2 in, $10 out, $0.10 cache read, $2.50 cache write per MTok.
    const expected = (12 * 2 + 4096 * 0.1 + 2048 * 2.5 + 42 * 10) / 1e6;
    expect(usage?.type === "usage" && usage.usage.costUsd).toBeCloseTo(expected, 9);
  });

  it("injects the vault key into the header only, for the bound origin", async () => {
    const { adapter, replay } = setup("text");
    await run(adapter, textRequest(REF));
    const sent = replay.requests[0];
    expect(sent?.headers["x-api-key"]).toBe("sk-ant-fixture-key-000111222");
    expect(sent?.url).toBe("https://api.anthropic.com/v1/messages");
    expect(JSON.stringify(sent?.body)).not.toContain("sk-ant-fixture");
  });

  it("emits parallel tool calls with parsed input", async () => {
    const { adapter, replay } = setup("parallel-tools");
    const { events } = await run(adapter, { ...textRequest(REF), tools: [weatherTool] });
    expect(events.filter((e) => e.type === "tool_call")).toEqual([
      { type: "tool_call", id: "toolu_01A", name: "weather", input: { city: "Paris" } },
      { type: "tool_call", id: "toolu_01B", name: "weather", input: { city: "Tokyo" } },
    ]);
    expect(events.at(-1)).toEqual({ type: "finish", reason: "tool_calls" });
    const tools = (replay.requests[0]?.body as { tools: { name: string }[] }).tools;
    expect(tools.map((t) => t.name)).toEqual(["weather"]);
  });

  it("round-trips reasoning verbatim and sends tool results and images back", async () => {
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
            { type: "tool_call", id: "toolu_01A", name: "weather", input: { city: "Paris" } },
          ],
        },
        {
          role: "tool",
          parts: [{ type: "tool_result", callId: "toolu_01A", output: { tempC: 18 } }],
        },
        {
          role: "user",
          parts: [{ type: "image", mime: "image/png", data: "iVBORw0KGgoAAAANSUhEUg==" }],
        },
      ],
      tools: [weatherTool],
    };
    await run(second.adapter, request);
    const body = second.replay.requests[0]?.body as {
      messages: { role: string; content: Record<string, unknown>[] }[];
    };
    const assistant = body.messages.find((m) => m.role === "assistant");
    expect(assistant?.content[0]).toMatchObject({
      type: "thinking",
      thinking: "The user wants a greeting.",
      signature: "EqQBCkYIBRgCKkBsig-fixture-0001",
    });
    const flat = JSON.stringify(body.messages);
    expect(flat).toContain('"tool_result"');
    expect(flat).toContain('"tool_use_id":"toolu_01A"');
    expect(flat).toContain('"type":"image"');
  });

  it("drops another provider's reasoning on fallback", async () => {
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
              data: { v: 1, kind: "reasoning", model: "gpt-6.1-sol", text: "x", metadata: {} },
            },
            { type: "text", text: "hello" },
          ],
        },
        { role: "user", parts: [{ type: "text", text: "again" }] },
      ],
    });
    expect(JSON.stringify(replay.requests[0]?.body)).not.toContain("gpt-6.1-sol");
    expect(JSON.stringify(replay.requests[0]?.body)).not.toContain('"type":"thinking"');
  });

  it("passes memory and computer toolsets through when enabled", async () => {
    const replay = replayFetch(fx("text"));
    const { adapter } = makeAdapter(
      { id: "anthropic", kind: "anthropic", providerTools: { memory: true, computer: true } },
      replay.fetch,
    );
    const tool = (name: string) => ({ ...weatherTool, name });
    await run(adapter, {
      ...textRequest("anthropic/claude-opus-5-5"),
      tools: [tool("memory"), tool("computer")],
    });
    const tools = (replay.requests[0]?.body as { tools: { type: string }[] }).tools;
    expect(tools.map((t) => t.type)).toEqual(["memory_20250818", "computer_toolset_20260801"]);
  });

  it.each([
    ["error-429", "rate_limited", 17],
    ["error-529", "overloaded", undefined],
    ["error-500", "server_error", undefined],
    ["error-401", "auth", undefined],
    ["error-400-context", "context_overflow", undefined],
    ["overloaded-midstream", "overloaded", undefined],
  ])("maps %s to %s", async (name, kind, retryAfter) => {
    const { adapter } = setup(name);
    const { events, outcome } = await run(adapter, textRequest(REF));
    expect(events.at(-1)).toMatchObject({ type: "finish", reason: "error" });
    const last = events.at(-1);
    expect(last?.type === "finish" && last.error?.startsWith(`${kind}:`)).toBe(true);
    expect(outcome?.error?.kind).toBe(kind);
    expect(outcome?.error?.retryAfterSec).toBe(retryAfter);
    expect(outcome?.contentStarted).toBe(false);
    expect(JSON.stringify(events)).not.toContain("sk-ant-fixture");
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

  it("times out a stalled stream and reports a timeout", async () => {
    const replay = replayFetch(fx("hang"));
    const { adapter } = makeAdapter(
      { id: "anthropic", kind: "anthropic", timeouts: { firstEventMs: 1_000, idleMs: 30 } },
      replay.fetch,
    );
    const { events, outcome } = await run(adapter, textRequest(REF));
    expect(events.at(-1)).toMatchObject({ type: "finish", reason: "error" });
    expect(outcome?.error?.kind).toBe("timeout");
  });

  it("never sends without an approval and fails with an auth-class error", async () => {
    const replay = replayFetch(fx("text"));
    const broker = new FakeCredentialBroker();
    const { adapter } = makeAdapter(
      {
        id: "anthropic",
        kind: "anthropic",
        profiles: [
          { id: "main", credential: "{{cred:anthropic-key}}", approvalId: "appr_missing" },
        ],
      },
      replay.fetch,
      undefined,
      broker,
    );
    const { outcome } = await run(adapter, textRequest(REF));
    expect(outcome?.error?.kind).toBe("auth");
    expect(replay.requests).toHaveLength(0);
  });
});
