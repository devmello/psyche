import { APICallError } from "@ai-sdk/provider";
import { PsycheError } from "@psyche/protocol";
import { FakeClock } from "@psyche/testing";
import { describe, expect, it } from "vitest";
import {
  Cooldowns,
  classifyError,
  convertRequest,
  normalizeUsage,
  parseModelRef,
  roleOf,
  TurnAccumulator,
} from "../src/index.ts";

describe("model refs", () => {
  it("splits at the first slash and validates roles", () => {
    expect(parseModelRef("openrouter/anthropic/claude-sonnet-5-5")).toEqual({
      provider: "openrouter",
      model: "anthropic/claude-sonnet-5-5",
    });
    expect(parseModelRef("ollama/qwen3.8:27b").model).toBe("qwen3.8:27b");
    expect(() => parseModelRef("no-slash")).toThrow(PsycheError);
    expect(roleOf("router/primary")).toBe("primary");
    expect(roleOf("anthropic/claude-opus-5-5")).toBeUndefined();
    expect(() => roleOf("router/nonsense")).toThrow(/unknown model role/);
  });
});

describe("usage normalization", () => {
  it("keeps classes disjoint", () => {
    expect(
      normalizeUsage({
        inputTokens: { total: 1000, noCache: 100, cacheRead: 800, cacheWrite: 100 },
        outputTokens: { total: 50, text: 30, reasoning: 20 },
      }),
    ).toEqual({
      input: 100,
      output: 50,
      cacheRead: 800,
      cacheWrite: 100,
      reasoning: 20,
      costUsd: 0,
    });
  });

  it("derives uncached input when the provider omits it", () => {
    const u = normalizeUsage({
      inputTokens: { total: 1000, noCache: undefined, cacheRead: 600, cacheWrite: undefined },
      outputTokens: { total: undefined, text: 10, reasoning: 5 },
    });
    expect(u).toMatchObject({ input: 400, cacheRead: 600, output: 15, reasoning: 5 });
  });
});

describe("error classification", () => {
  const api = (statusCode: number, body: string, headers?: Record<string, string>) =>
    new APICallError({
      message: "call failed",
      url: "https://api.example/v1",
      requestBodyValues: { secret: "never echoed" },
      statusCode,
      responseBody: body,
      ...(headers === undefined ? {} : { responseHeaders: headers }),
    });

  it.each([
    [429, "", "rate_limited"],
    [429, "insufficient_quota", "billing"],
    [402, "", "billing"],
    [401, "", "auth"],
    [403, "", "auth"],
    [404, "", "model_not_found"],
    [413, "", "context_overflow"],
    [400, "maximum context length is 128000 tokens", "context_overflow"],
    [400, "bad schema", "bad_request"],
    [500, "", "server_error"],
    [503, "", "server_error"],
    [529, "", "overloaded"],
  ])("HTTP %i %s → %s", (status, body, kind) => {
    expect(classifyError(api(status, body)).kind).toBe(kind);
  });

  it("reads retry-after and keeps request bodies out of the message", () => {
    const e = classifyError(api(429, "", { "retry-after": "12" }));
    expect(e.retryAfterSec).toBe(12);
    expect(e.message).not.toContain("never echoed");
  });

  it("maps timeouts, network failures and vault refusals", () => {
    expect(classifyError(new DOMException("t", "TimeoutError")).kind).toBe("timeout");
    expect(classifyError(new TypeError("fetch failed: ECONNREFUSED")).kind).toBe("network");
    expect(classifyError(new PsycheError("approval_required", "no grant")).kind).toBe("auth");
  });

  it("redacts known secrets", () => {
    const e = classifyError(new Error("bad key sk-live-123456"), (t) =>
      t.replace("sk-live-123456", "•••"),
    );
    expect(e.message).toBe("bad key •••");
  });
});

describe("cooldowns", () => {
  it("follow 30 s → 1 m → 5 m, honour retry-after, and reset on success", () => {
    const clock = new FakeClock();
    const c = new Cooldowns(clock);
    expect(c.fail("k", "server_error").until - clock.now()).toBe(30_000);
    expect(c.fail("k", "server_error").until - clock.now()).toBe(60_000);
    expect(c.fail("k", "server_error").until - clock.now()).toBe(300_000);
    expect(c.fail("k", "server_error").until - clock.now()).toBe(300_000);
    c.succeed("k");
    expect(c.isCooling("k")).toBe(false);
    expect(c.fail("k", "rate_limited", 90).until - clock.now()).toBe(90_000);
    expect(c.fail("b", "billing").until - clock.now()).toBe(600_000);
    clock.advance(600_001);
    expect(c.snapshot()).toEqual([]);
  });
});

describe("TurnAccumulator", () => {
  it("builds the assistant message in arrival order", () => {
    const acc = new TurnAccumulator();
    const env = { v: 1, kind: "reasoning", model: "m", text: "think" };
    acc.push({ type: "reasoning", provider: "anthropic", data: null, textDelta: "think" });
    acc.push({ type: "reasoning", provider: "anthropic", data: env });
    acc.push({ type: "text_delta", text: "Hel" });
    acc.push({ type: "text_delta", text: "lo" });
    acc.push({ type: "tool_call", id: "c1", name: "t", input: {} });
    acc.push({ type: "finish", reason: "tool_calls" });
    expect(acc.message().parts).toEqual([
      { type: "reasoning", provider: "anthropic", data: env },
      { type: "text", text: "Hello" },
      { type: "tool_call", id: "c1", name: "t", input: {} },
    ]);
    expect(acc.finish?.reason).toBe("tool_calls");
  });
});

describe("request conversion", () => {
  const ctx = { config: { id: "openai", kind: "openai" as const }, modelId: "gpt-6.1-sol" };

  it("names tool results from the matching call and moves them to a tool message", () => {
    const call = convertRequest(
      {
        model: "openai/gpt-6.1-sol",
        messages: [
          {
            role: "assistant",
            parts: [{ type: "tool_call", id: "c1", name: "weather", input: { city: "Oslo" } }],
          },
          {
            role: "user",
            parts: [
              { type: "tool_result", callId: "c1", output: "7C", provenance: "untrusted" },
              { type: "text", text: "and tomorrow?" },
            ],
          },
        ],
      },
      ctx,
    );
    expect(call.prompt.map((m) => m.role)).toEqual(["assistant", "tool", "user"]);
    expect(call.prompt[1]).toMatchObject({
      content: [{ toolName: "weather", output: { type: "text", value: "7C" } }],
    });
  });

  it("merges provider options by package key and adapter id over the privacy defaults", () => {
    const call = convertRequest(
      {
        model: "openai/gpt-6.1-sol",
        messages: [{ role: "user", parts: [{ type: "text", text: "hi" }] }],
        providerOptions: { openai: { reasoningEffort: "high" } },
      },
      ctx,
    );
    expect(call.providerOptions).toEqual({ openai: { store: false, reasoningEffort: "high" } });
  });
});
