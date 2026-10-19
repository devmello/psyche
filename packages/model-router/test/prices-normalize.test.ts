import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { EMPTY_USAGE, type Usage } from "@psyche/protocol";
import { describe, expect, it } from "vitest";
import { type PriceEntry, Prices, type PriceTable } from "../src/prices.ts";
import { normalizeLiteLLM } from "../src/prices-normalize.ts";

const META = {
  source: "https://example.test/litellm.json",
  generatedAt: "2026-10-19T00:00:00.000Z",
};
const norm = (raw: unknown) => normalizeLiteLLM(raw, META);

describe("normalizeLiteLLM", () => {
  it("converts per-token prices to per-million and stamps the table metadata", () => {
    const table = norm({
      "claude-sonnet-5-5": {
        litellm_provider: "anthropic",
        mode: "chat",
        input_cost_per_token: 3e-6,
        output_cost_per_token: 1.5e-5,
        cache_read_input_token_cost: 3e-7,
        cache_creation_input_token_cost: 3.75e-6,
        cache_creation_input_token_cost_above_1hr: 6e-6,
      },
    });
    expect(table.source).toBe(META.source);
    expect(table.generatedAt).toBe(META.generatedAt);
    expect(table.unit).toBe("usd_per_million_tokens");
    expect(table.models["anthropic/claude-sonnet-5-5"]).toEqual({
      mode: "chat",
      input: 3,
      output: 15,
      cacheRead: 0.3,
      cacheWrite: 3.75,
      cacheWrite1h: 6,
    });
  });

  it("rounds float noise to 6 decimal places", () => {
    const table = norm({
      m: {
        litellm_provider: "openai",
        mode: "chat",
        input_cost_per_token: 2.9999999999999997e-6,
        output_cost_per_token: 1.23456789e-7,
      },
    });
    expect(table.models["openai/m"]).toMatchObject({ input: 3, output: 0.123457 });
  });

  it("maps LiteLLM providers and strips their key prefix", () => {
    const rate = { mode: "chat", input_cost_per_token: 1e-6, output_cost_per_token: 2e-6 };
    const table = norm({
      "gemini/gemini-4-argon": { ...rate, litellm_provider: "gemini" },
      "openrouter/deepseek/deepseek-r2": { ...rate, litellm_provider: "openrouter" },
      "gpt-6.1-sol": { ...rate, litellm_provider: "openai" },
      "mistral/mistral-large-3": { ...rate, litellm_provider: "mistral" },
      "xai/grok-5": { ...rate, litellm_provider: "xai" },
      "deepseek/deepseek-chat": { ...rate, litellm_provider: "deepseek" },
      "vertex_ai/gemini-4-argon": { ...rate, litellm_provider: "vertex_ai-language-models" },
      "bedrock/claude": { ...rate, litellm_provider: "bedrock" },
      "azure/gpt-6": { ...rate, litellm_provider: "azure" },
      "no-provider": { ...rate },
      "gemini/": { ...rate, litellm_provider: "gemini" },
    });
    expect(Object.keys(table.models)).toEqual([
      "deepseek/deepseek-chat",
      "google/gemini-4-argon",
      "mistral/mistral-large-3",
      "openai/gpt-6.1-sol",
      "openrouter/deepseek/deepseek-r2",
      "xai/grok-5",
    ]);
  });

  it("prefers the unprefixed key on a collision, else the first one seen", () => {
    const table = norm({
      "gemini/gemini-pro-latest": {
        litellm_provider: "gemini",
        mode: "chat",
        input_cost_per_token: 9e-6,
        output_cost_per_token: 9e-6,
      },
      "gemini-pro-latest": {
        litellm_provider: "gemini",
        mode: "chat",
        input_cost_per_token: 1e-6,
        output_cost_per_token: 2e-6,
      },
      "gemini/flash": {
        litellm_provider: "gemini",
        mode: "chat",
        input_cost_per_token: 1e-6,
        output_cost_per_token: 1e-6,
      },
    });
    expect(table.models["google/gemini-pro-latest"]).toMatchObject({ input: 1, output: 2 });
    const reversed = norm({
      "gemini-pro-latest": {
        litellm_provider: "gemini",
        mode: "chat",
        input_cost_per_token: 1e-6,
        output_cost_per_token: 2e-6,
      },
      "gemini/gemini-pro-latest": {
        litellm_provider: "gemini",
        mode: "chat",
        input_cost_per_token: 9e-6,
        output_cost_per_token: 9e-6,
      },
    });
    expect(reversed.models["google/gemini-pro-latest"]).toMatchObject({ input: 1, output: 2 });
  });

  it("keeps chat, responses and embedding modes and drops the rest", () => {
    const rate = {
      litellm_provider: "openai",
      input_cost_per_token: 1e-6,
      output_cost_per_token: 2e-6,
    };
    const table = norm({
      chat: { ...rate, mode: "chat" },
      responses: { ...rate, mode: "responses" },
      embed: { litellm_provider: "openai", mode: "embedding", input_cost_per_token: 2e-8 },
      nomode: { ...rate },
      image: { ...rate, mode: "image_generation" },
      audio: { ...rate, mode: "audio_transcription" },
      speech: { ...rate, mode: "audio_speech" },
      moderation: { ...rate, mode: "moderation" },
      rerank: { ...rate, mode: "rerank" },
      completion: { ...rate, mode: "completion" },
    });
    expect(table.models).toEqual({
      "openai/chat": { mode: "chat", input: 1, output: 2 },
      "openai/embed": { mode: "embedding", input: 0.02, output: 0 },
      "openai/nomode": { mode: "chat", input: 1, output: 2 },
      "openai/responses": { mode: "chat", input: 1, output: 2 },
    });
  });

  it("skips entries without an input rate, and chat entries without an output rate", () => {
    const table = norm({
      noInput: { litellm_provider: "openai", mode: "chat", output_cost_per_token: 1e-6 },
      noOutput: { litellm_provider: "openai", mode: "chat", input_cost_per_token: 1e-6 },
      noModeNoOutput: { litellm_provider: "openai", input_cost_per_token: 1e-6 },
    });
    expect(table.models).toEqual({});
  });

  it("parses the lowest long-context tier into aboveTokens", () => {
    const table = norm({
      "gemini/gemini-3.1-pro": {
        litellm_provider: "gemini",
        mode: "chat",
        input_cost_per_token: 2e-6,
        output_cost_per_token: 1.2e-5,
        cache_read_input_token_cost: 2e-7,
        input_cost_per_token_above_200k_tokens: 4e-6,
        output_cost_per_token_above_200k_tokens: 1.8e-5,
        cache_read_input_token_cost_above_200k_tokens: 4e-7,
        input_cost_per_token_above_1m_tokens: 8e-6,
      },
      "only-1m": {
        litellm_provider: "openai",
        mode: "chat",
        input_cost_per_token: 1e-6,
        output_cost_per_token: 1e-6,
        output_cost_per_token_above_1m_tokens: 5e-6,
      },
      "raw-count": {
        litellm_provider: "openai",
        mode: "chat",
        input_cost_per_token: 1e-6,
        output_cost_per_token: 1e-6,
        input_cost_per_token_above_128000_tokens: 2e-6,
      },
    });
    expect(table.models["google/gemini-3.1-pro"]?.aboveTokens).toEqual({
      threshold: 200_000,
      input: 4,
      output: 18,
      cacheRead: 0.4,
    });
    expect(table.models["openai/only-1m"]?.aboveTokens).toEqual({
      threshold: 1_000_000,
      output: 5,
    });
    expect(table.models["openai/raw-count"]?.aboveTokens).toEqual({ threshold: 128_000, input: 2 });
  });

  it("ignores invalid tier fields and unrelated *_above_* keys", () => {
    const table = norm({
      m: {
        litellm_provider: "openai",
        mode: "chat",
        input_cost_per_token: 1e-6,
        output_cost_per_token: 1e-6,
        input_cost_per_token_above_200k_tokens: "4e-6",
        output_cost_per_token_above_0k_tokens: 1e-6,
        output_cost_per_audio_token_above_200k_tokens: 1e-6,
        input_cost_per_token_above_128k_tokens_batch: 1e-6,
      },
    });
    expect(table.models["openai/m"]).toEqual({ mode: "chat", input: 1, output: 1 });
  });

  it("copies catalog facts and omits optional fields that are absent or malformed", () => {
    const table = norm({
      full: {
        litellm_provider: "openai",
        mode: "chat",
        input_cost_per_token: 1e-6,
        output_cost_per_token: 2e-6,
        max_input_tokens: 400_000,
        max_tokens: 1_000,
        max_output_tokens: 128_000,
        supports_function_calling: true,
        supports_vision: false,
        supports_reasoning: true,
        supports_prompt_caching: true,
      },
      fallback: {
        litellm_provider: "openai",
        mode: "chat",
        input_cost_per_token: 1e-6,
        output_cost_per_token: 2e-6,
        max_tokens: 8_192,
      },
      bad: {
        litellm_provider: "openai",
        mode: "chat",
        input_cost_per_token: 1e-6,
        output_cost_per_token: 2e-6,
        cache_read_input_token_cost: -1,
        cache_creation_input_token_cost: "0.1",
        cache_creation_input_token_cost_above_1hr: null,
        max_input_tokens: 1.5,
        max_output_tokens: 0,
        supports_function_calling: "yes",
        supports_vision: 1,
      },
    });
    expect(table.models["openai/full"]).toEqual({
      mode: "chat",
      input: 1,
      output: 2,
      contextWindow: 400_000,
      maxOutput: 128_000,
      toolCalling: true,
      vision: false,
      reasoning: true,
      promptCaching: true,
    });
    expect(table.models["openai/fallback"]).toEqual({
      mode: "chat",
      input: 1,
      output: 2,
      contextWindow: 8_192,
    });
    expect(table.models["openai/bad"]).toEqual({ mode: "chat", input: 1, output: 2 });
  });

  it("emits entry fields in PriceEntry declaration order", () => {
    const table = norm({
      m: {
        supports_prompt_caching: true,
        max_output_tokens: 10,
        input_cost_per_token_above_200k_tokens: 2e-6,
        cache_creation_input_token_cost_above_1hr: 1e-6,
        cache_creation_input_token_cost: 1e-6,
        cache_read_input_token_cost: 1e-6,
        output_cost_per_token: 1e-6,
        input_cost_per_token: 1e-6,
        mode: "chat",
        litellm_provider: "anthropic",
        supports_reasoning: true,
        supports_vision: true,
        supports_function_calling: true,
        max_input_tokens: 20,
      },
    });
    expect(Object.keys(table.models["anthropic/m"] ?? {})).toEqual([
      "mode",
      "input",
      "output",
      "cacheRead",
      "cacheWrite",
      "cacheWrite1h",
      "aboveTokens",
      "contextWindow",
      "maxOutput",
      "toolCalling",
      "vision",
      "reasoning",
      "promptCaching",
    ]);
  });

  it("sorts model keys", () => {
    const rate = { mode: "chat", input_cost_per_token: 1e-6, output_cost_per_token: 1e-6 };
    const table = norm({
      "z-model": { ...rate, litellm_provider: "openai" },
      "claude-a": { ...rate, litellm_provider: "anthropic" },
      "gemini/b": { ...rate, litellm_provider: "gemini" },
      "a-model": { ...rate, litellm_provider: "openai" },
    });
    expect(Object.keys(table.models)).toEqual([
      "anthropic/claude-a",
      "google/b",
      "openai/a-model",
      "openai/z-model",
    ]);
  });

  it("tolerates junk entries, sample_spec and inherited keys", () => {
    const inherited = Object.create({ litellm_provider: "openai", mode: "chat" }) as Record<
      string,
      unknown
    >;
    inherited.input_cost_per_token = 1e-6;
    inherited.output_cost_per_token = 1e-6;
    const table = norm({
      sample_spec: {
        litellm_provider: "openai",
        mode: "chat",
        input_cost_per_token: 0,
        output_cost_per_token: 0,
      },
      nullEntry: null,
      arrayEntry: [1, 2],
      stringEntry: "nope",
      numberProvider: {
        litellm_provider: 7,
        input_cost_per_token: 1e-6,
        output_cost_per_token: 1e-6,
      },
      protoProvider: {
        litellm_provider: "toString",
        input_cost_per_token: 1e-6,
        output_cost_per_token: 1e-6,
      },
      inherited,
      nanRate: {
        litellm_provider: "openai",
        mode: "chat",
        input_cost_per_token: Number.NaN,
        output_cost_per_token: 1e-6,
      },
      infRate: {
        litellm_provider: "openai",
        mode: "chat",
        input_cost_per_token: 1e-6,
        output_cost_per_token: Number.POSITIVE_INFINITY,
      },
      ok: {
        litellm_provider: "openai",
        mode: "chat",
        input_cost_per_token: 0,
        output_cost_per_token: 0,
      },
    });
    expect(table.models).toEqual({ "openai/ok": { mode: "chat", input: 0, output: 0 } });
  });

  it.each([null, [], "{}", 42, undefined])("throws on non-object input %j", (raw) => {
    expect(() => norm(raw)).toThrow(TypeError);
  });
});

describe("bundled price table", () => {
  const table = JSON.parse(
    readFileSync(resolve(import.meta.dirname, "../src/data/prices.json"), "utf8"),
  ) as PriceTable;

  it("has sane entries throughout", () => {
    expect(table.unit).toBe("usd_per_million_tokens");
    const entries = Object.entries(table.models);
    expect(entries.length).toBeGreaterThan(0);
    for (const [ref, e] of entries) {
      expect(ref, ref).toMatch(/^[a-z0-9][a-z0-9_.-]*\/.+/);
      expect(["chat", "embedding"], ref).toContain(e.mode);
      for (const rate of [e.input, e.output, e.cacheRead, e.cacheWrite, e.cacheWrite1h]) {
        if (rate === undefined) continue;
        expect(Number.isFinite(rate) && rate >= 0, ref).toBe(true);
      }
      expect(Number.isFinite(e.input) && e.input >= 0, ref).toBe(true);
      expect(Number.isFinite(e.output) && e.output >= 0, ref).toBe(true);
      if (e.aboveTokens !== undefined) {
        expect(
          Number.isSafeInteger(e.aboveTokens.threshold) && e.aboveTokens.threshold > 0,
          ref,
        ).toBe(true);
      }
    }
  });

  it("is sorted by key", () => {
    const keys = Object.keys(table.models);
    expect(keys).toEqual([...keys].sort());
  });
});

describe("Prices.cost", () => {
  const usage = (u: Partial<Usage>): Usage => ({ ...EMPTY_USAGE, ...u });
  const table = (models: Record<string, PriceEntry>): PriceTable => ({
    source: "test",
    generatedAt: META.generatedAt,
    unit: "usd_per_million_tokens",
    models,
  });
  const prices = new Prices(
    table({
      "anthropic/claude-x": {
        mode: "chat",
        input: 3,
        output: 15,
        cacheRead: 0.3,
        cacheWrite: 3.75,
        cacheWrite1h: 6,
      },
      "google/gemini-x": {
        mode: "chat",
        input: 2,
        output: 12,
        cacheRead: 0.2,
        aboveTokens: { threshold: 200_000, input: 4, output: 18, cacheRead: 0.4 },
      },
      "openai/plain": { mode: "chat", input: 1, output: 2 },
      "openrouter/vendor/model": { mode: "chat", input: 0.5, output: 1 },
      "openai/gpt-dated": { mode: "chat", input: 1, output: 1 },
    }),
  );

  it("bills each token class at its own rate", () => {
    const cost = prices.cost(
      "anthropic/claude-x",
      usage({ input: 1_000, cacheRead: 10_000, cacheWrite: 2_000, output: 500 }),
    );
    expect(cost).toBeCloseTo((1_000 * 3 + 10_000 * 0.3 + 2_000 * 3.75 + 500 * 15) / 1e6, 9);
  });

  it("uses the 1h cache write rate when asked", () => {
    const u = usage({ cacheWrite: 1_000_000 });
    expect(prices.cost("anthropic/claude-x", u)).toBe(3.75);
    expect(prices.cost("anthropic/claude-x", u, { cacheTtl: "5m" })).toBe(3.75);
    expect(prices.cost("anthropic/claude-x", u, { cacheTtl: "1h" })).toBe(6);
  });

  it("falls back to the input rate for missing cache rates", () => {
    expect(
      prices.cost("openai/plain", usage({ cacheRead: 1_000_000, cacheWrite: 1_000_000 }), {
        cacheTtl: "1h",
      }),
    ).toBe(2);
  });

  it("switches to the long-context tier above the threshold of total prompt tokens", () => {
    const at = usage({ input: 150_000, cacheRead: 50_000, output: 1_000 });
    expect(prices.cost("google/gemini-x", at)).toBeCloseTo(
      (150_000 * 2 + 50_000 * 0.2 + 1_000 * 12) / 1e6,
      9,
    );
    const above = usage({ input: 150_000, cacheRead: 50_001, output: 1_000 });
    expect(prices.cost("google/gemini-x", above)).toBeCloseTo(
      (150_000 * 4 + 50_001 * 0.4 + 1_000 * 18) / 1e6,
      9,
    );
  });

  it("returns undefined for an unknown model", () => {
    expect(prices.cost("openai/nope", usage({ input: 10 }))).toBeUndefined();
    expect(prices.cost("ollama/qwen3.8:27b", usage({ input: 10 }))).toBeUndefined();
  });

  it("falls back from :free and dated variants to the base id", () => {
    const u = usage({ input: 1_000_000, output: 1_000_000 });
    expect(prices.cost("openrouter/vendor/model:free", u)).toBe(1.5);
    expect(prices.cost("openrouter/vendor/model:nitro", u)).toBe(1.5);
    expect(prices.cost("openai/gpt-dated-20260101", u)).toBe(2);
    expect(prices.cost("openrouter/vendor/model:other", u)).toBeUndefined();
  });

  it("lets user overrides win over the bundled table, including for variants", () => {
    const p = new Prices(table({ "openai/plain": { mode: "chat", input: 1, output: 2 } }));
    p.override("openai/plain", { mode: "chat", input: 10, output: 20 });
    expect(p.cost("openai/plain", usage({ input: 1_000_000 }))).toBe(10);
    expect(p.cost("openai/plain:free", usage({ input: 1_000_000 }))).toBe(10);
  });

  it("rounds to 1e-9 USD and is zero for zero usage", () => {
    expect(prices.cost("openai/plain", usage({ input: 1 }))).toBe(0.000001);
    expect(prices.cost("openai/plain", usage({}))).toBe(0);
    expect(prices.cost("openai/plain", usage({ output: 1, input: 1 }))).toBe(0.000003);
  });

  it("prices the bundled google/gemini-4-argon entry", () => {
    const bundled = new Prices();
    const entry = bundled.lookup("google/gemini-4-argon");
    expect(entry).toBeDefined();
    const u = usage({ input: 1_000_000, output: 1_000_000 });
    expect(bundled.cost("google/gemini-4-argon", u)).toBeCloseTo(
      (entry?.input ?? Number.NaN) + (entry?.output ?? Number.NaN),
      9,
    );
  });
});
