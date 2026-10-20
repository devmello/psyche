import { collect } from "@psyche/testing";
import { describe, expect, it } from "vitest";
import {
  ANTHROPIC_TOOL_NAMES,
  CompatStreamFixer,
  GOOGLE_TOOL_NAMES,
  guessFromName,
  isLocalKind,
  mergeFacts,
  OPENAI_TOOL_NAMES,
  PROVIDER_KINDS,
  parseModelRef,
  rewriteSse,
  sanitizeToolName,
  ToolNameMap,
  toolNameRuleFor,
  transformCompatRequest,
} from "../src/index.ts";
import { fakeKey, makeAdapter, textRequest } from "./helpers/adapters.ts";
import { loadFixture, replayFetch } from "./helpers/replay.ts";

describe("model ids: <provider>/<model>", () => {
  it("keeps every slash after the provider in the model id (OpenRouter, LM Studio)", () => {
    expect(parseModelRef("openrouter/meta-llama/llama-3.1-8b-instruct:free")).toEqual({
      provider: "openrouter",
      model: "meta-llama/llama-3.1-8b-instruct:free",
    });
    expect(parseModelRef("lmstudio/qwen/qwen3.8-27b")).toEqual({
      provider: "lmstudio",
      model: "qwen/qwen3.8-27b",
    });
  });

  it("has llamacpp and lmstudio as local kinds", () => {
    expect(PROVIDER_KINDS).toContain("llamacpp");
    expect(PROVIDER_KINDS).toContain("lmstudio");
    expect(isLocalKind("llamacpp")).toBe(true);
    expect(isLocalKind("lmstudio")).toBe(true);
    expect(isLocalKind("openrouter")).toBe(false);
  });
});

describe("OpenRouter app attribution", () => {
  const KEY = { secret: fakeKey("openrouter-attr"), origin: "https://openrouter.ai" };

  it("sends no attribution headers unless configured", async () => {
    const replay = replayFetch(loadFixture("openrouter/text.json"));
    const { adapter } = makeAdapter({ id: "openrouter", kind: "openrouter" }, replay.fetch, KEY);
    await collect(adapter.stream(textRequest("openrouter/anthropic/claude-sonnet-5-5")));
    const h = replay.requests[0]?.headers ?? {};
    expect(h["http-referer"]).toBeUndefined();
    expect(h["x-title"]).toBeUndefined();
    expect(h["x-openrouter-title"]).toBeUndefined();
  });

  it("sends HTTP-Referer and X-OpenRouter-Title when the owner sets them", async () => {
    const replay = replayFetch(loadFixture("openrouter/text.json"));
    const { adapter } = makeAdapter(
      {
        id: "openrouter",
        kind: "openrouter",
        attribution: { url: "https://psyche.example", title: "Psyche" },
      },
      replay.fetch,
      KEY,
    );
    await collect(adapter.stream(textRequest("openrouter/anthropic/claude-sonnet-5-5")));
    const sent = replay.requests[0];
    expect(sent?.headers["http-referer"]).toBe("https://psyche.example");
    expect(sent?.headers["x-openrouter-title"]).toBe("Psyche");
    expect((sent?.body as { model?: string } | undefined)?.model).toBe("anthropic/claude-sonnet-5-5");
  });
});

describe("tool-name rules per provider", () => {
  it("picks the rule by kind", () => {
    expect(toolNameRuleFor("anthropic")).toBe(ANTHROPIC_TOOL_NAMES);
    expect(toolNameRuleFor("google")).toBe(GOOGLE_TOOL_NAMES);
    for (const k of ["openai", "openrouter", "llamacpp", "lmstudio", "ollama"] as const)
      expect(toolNameRuleFor(k)).toBe(OPENAI_TOOL_NAMES);
  });

  it("caps at 64 for OpenAI-style providers and 128 for Anthropic", () => {
    const long = `mcp__${"a".repeat(100)}`;
    expect(new ToolNameMap(OPENAI_TOOL_NAMES).toProvider(long)).toHaveLength(64);
    expect(new ToolNameMap(ANTHROPIC_TOOL_NAMES).toProvider(long)).toBe(long);
  });

  it("starts Gemini names with a letter or underscore", () => {
    expect(sanitizeToolName("1password.lookup", GOOGLE_TOOL_NAMES)).toBe("_1password_lookup");
    expect(sanitizeToolName("-x", GOOGLE_TOOL_NAMES)).toBe("_-x");
    const m = new ToolNameMap(GOOGLE_TOOL_NAMES);
    expect(m.toProvider("2fa")).toBe("_2fa");
    expect(m.toOurs("_2fa")).toBe("2fa");
  });

  it("keeps colliding truncated names apart within the length cap", () => {
    const m = new ToolNameMap(OPENAI_TOOL_NAMES);
    const a = m.toProvider(`${"x".repeat(70)}.a`);
    const b = m.toProvider(`${"x".repeat(70)}.b`);
    expect(a).not.toBe(b);
    expect(b.length).toBeLessThanOrEqual(64);
    expect(m.toOurs(b)).toBe(`${"x".repeat(70)}.b`);
  });
});

describe("local-server compat fixes", () => {
  it("rewrites a named tool choice for llama.cpp and LM Studio only", () => {
    const body = {
      tools: [
        { type: "function", function: { name: "a" } },
        { type: "function", function: { name: "b" } },
      ],
      tool_choice: { type: "function", function: { name: "b" } },
      messages: [{ role: "assistant", content: null, tool_calls: [] }],
    };
    const fixed = transformCompatRequest("llamacpp", body);
    expect(fixed.tool_choice).toBe("required");
    expect(fixed.tools).toEqual([{ type: "function", function: { name: "b" } }]);
    expect((fixed.messages as { content: unknown }[])[0]?.content).toBe("");
    expect(transformCompatRequest("openai-compatible", body)).toEqual(body);
    // The input is not mutated.
    expect(body.tool_choice).toEqual({ type: "function", function: { name: "b" } });
  });

  it("rewrites SSE events split across network chunks", async () => {
    const enc = new TextEncoder();
    const parts = [
      'data: {"choices":[{"delta":{"tool_c',
      'alls":[]},"finish_reason":"st',
      'op"}]}\n\ndata: [DONE]\n\n',
    ];
    const src = new ReadableStream<Uint8Array>({
      start(c) {
        for (const p of parts) c.enqueue(enc.encode(p));
        c.close();
      },
    });
    const fixer = new CompatStreamFixer();
    const out = await new Response(rewriteSse(src, (d) => fixer.fixChunk(d))).text();
    expect(out).toBe(
      'data: {"choices":[{"delta":{"tool_calls":[]},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    );
  });

  it("keeps usage when present and builds it from timings otherwise", () => {
    const withUsage = new CompatStreamFixer().fixChunk({
      choices: [],
      usage: { prompt_tokens: 5 },
      timings: { prompt_n: 99 },
    });
    expect(withUsage.usage).toEqual({ prompt_tokens: 5 });
    const fromTimings = new CompatStreamFixer().fixChunk({
      choices: [],
      timings: { prompt_n: 4, cache_n: 6, predicted_n: 3 },
    });
    expect(fromTimings.usage).toEqual({
      prompt_tokens: 10,
      completion_tokens: 3,
      total_tokens: 13,
      prompt_tokens_details: { cached_tokens: 6 },
    });
  });
});

describe("capability guesses", () => {
  it("guesses from local model names", () => {
    expect(guessFromName("qwen2.5-vl-7b-instruct")).toMatchObject({
      vision: true,
      toolCalling: true,
    });
    expect(guessFromName("gpt-oss-20b")).toMatchObject({ reasoning: true, toolCalling: true });
    expect(guessFromName("nomic-embed-text-v1.5")).toEqual({
      embeddings: true,
      toolCalling: false,
      vision: false,
    });
    expect(guessFromName("tinyllama-1.1b")).toEqual({});
  });

  it("merges by authority and names the strongest source", () => {
    const g = mergeFacts([
      ["heuristic", { vision: true, toolCalling: true }],
      ["catalog", undefined],
      ["listing", { vision: false, contextWindow: 8192 }],
      ["config", {}],
    ]);
    expect(g).toEqual({ source: "listing", vision: false, toolCalling: true, contextWindow: 8192 });
    expect(mergeFacts([["heuristic", {}]])).toEqual({ source: "heuristic" });
  });
});
