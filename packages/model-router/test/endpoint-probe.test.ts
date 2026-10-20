import { FakeCredentialBroker } from "@psyche/testing";
import { describe, expect, it } from "vitest";
import {
  brokerKeySource,
  type EndpointProbeResult,
  endpointRoot,
  InMemoryEndpointProbeStore,
  KEY_SENTINEL,
  KeyValueEndpointProbeStore,
  NOT_PROBED,
  type ProviderConfig,
  probeEndpoint,
} from "../src/index.ts";
import { fakeKey } from "./helpers/adapters.ts";
import { loadFixture, replayFetch } from "./helpers/replay.ts";

const clock = { now: () => Date.parse("2026-10-19T20:00:00Z") };

function withKey(config: ProviderConfig, origin: string, secret: string) {
  const broker = new FakeCredentialBroker();
  const slug = `${config.id}-key`;
  broker.add({ slug, kind: "api_key", bindings: [{ origin }], secret });
  broker.approve(`appr_${slug}`, { slug, origin, scope: "site" });
  return {
    config: {
      ...config,
      profiles: [{ id: "main", credential: `{{cred:${slug}}}`, approvalId: `appr_${slug}` }],
    },
    keys: brokerKeySource(broker),
  };
}

const byId = (r: EndpointProbeResult, id: string) => r.models.find((m) => m.id === id);

describe("endpoint probe (B4)", () => {
  it("has a not_probed state with no models", () => {
    expect(NOT_PROBED).toEqual({ state: "not_probed", models: [] });
  });

  it("derives the server root from a base URL", () => {
    expect(endpointRoot("http://127.0.0.1:1234/v1")).toBe("http://127.0.0.1:1234");
    expect(endpointRoot("http://127.0.0.1:11434/api/")).toBe("http://127.0.0.1:11434");
    expect(endpointRoot("https://generativelanguage.googleapis.com/v1beta")).toBe(
      "https://generativelanguage.googleapis.com",
    );
  });

  it("llama-server: one loaded model with runtime context, vision and tool caps from /props", async () => {
    const replay = replayFetch(
      loadFixture("llamacpp/models.json"),
      loadFixture("llamacpp/props.json"),
    );
    const r = await probeEndpoint(
      { id: "llamacpp", kind: "llamacpp" },
      { fetch: replay.fetch, clock },
    );
    expect(r).toMatchObject({
      state: "reachable",
      probedAt: "2026-10-19T20:00:00.000Z",
      server: "llama.cpp b6700-fixture",
    });
    expect(r.models).toEqual([
      {
        ref: "llamacpp/qwen3.8-27b",
        id: "qwen3.8-27b",
        loaded: true,
        capabilities: {
          source: "listing",
          contextWindow: 32768,
          vision: false,
          toolCalling: true,
          reasoning: true,
          embeddings: false,
        },
      },
    ]);
    expect(replay.requests.map((q) => q.url)).toEqual([
      "http://127.0.0.1:8080/v1/models",
      "http://127.0.0.1:8080/props",
    ]);
    expect(replay.requests[0]?.headers.authorization).toBeUndefined();
  });

  it("llama-server without /props still lists its model", async () => {
    const missing = {
      request: { method: "GET", pathEndsWith: "/props" },
      response: { status: 404, headers: { "content-type": "application/json" }, body: "{}" },
    };
    const replay = replayFetch(loadFixture("llamacpp/models.json"), missing);
    const r = await probeEndpoint(
      { id: "llamacpp", kind: "llamacpp" },
      { fetch: replay.fetch, clock },
    );
    expect(r.state).toBe("reachable");
    expect(r.server).toBe("llama.cpp");
    expect(byId(r, "qwen3.8-27b")?.capabilities.contextWindow).toBe(32768);
  });

  it("LM Studio 0.4: type, load state, loaded context and capabilities from /api/v1/models", async () => {
    const replay = replayFetch(loadFixture("lmstudio/api-v1-models.json"));
    const r = await probeEndpoint(
      { id: "lmstudio", kind: "lmstudio" },
      { fetch: replay.fetch, clock },
    );
    expect(r.state).toBe("reachable");
    expect(r.server).toBe("LM Studio");
    expect(replay.requests[0]?.url).toBe("http://127.0.0.1:1234/api/v1/models");
    expect(byId(r, "qwen/qwen3.8-27b")).toMatchObject({
      ref: "lmstudio/qwen/qwen3.8-27b",
      label: "Qwen3.8 27B",
      loaded: true,
      capabilities: { toolCalling: true, vision: false, reasoning: true, contextWindow: 32768 },
    });
    expect(byId(r, "google/gemma-4-12b")).toMatchObject({
      loaded: false,
      capabilities: { vision: true, toolCalling: true, contextWindow: 131072 },
    });
    expect(byId(r, "text-embedding-nomic-embed-text-v1.5")?.capabilities).toMatchObject({
      embeddings: true,
      toolCalling: false,
    });
  });

  it("LM Studio 0.3: falls back to /api/v0/models", async () => {
    const replay = replayFetch(
      loadFixture("lmstudio/api-v1-models-404.json"),
      loadFixture("lmstudio/api-models.json"),
    );
    const r = await probeEndpoint(
      { id: "lmstudio", kind: "lmstudio" },
      { fetch: replay.fetch, clock },
    );
    expect(byId(r, "qwen/qwen3.8-27b")).toMatchObject({
      loaded: true,
      capabilities: { toolCalling: true, vision: false, contextWindow: 32768 },
    });
    expect(byId(r, "google/gemma-4-12b")?.capabilities.vision).toBe(true);
  });

  it("older LM Studio: falls back to the OpenAI-compatible /v1/models", async () => {
    const replay = replayFetch(
      loadFixture("lmstudio/api-v1-models-404.json"),
      loadFixture("lmstudio/api-v0-models-404.json"),
      loadFixture("lmstudio/v1-models.json"),
    );
    const r = await probeEndpoint(
      { id: "lmstudio", kind: "lmstudio" },
      { fetch: replay.fetch, clock },
    );
    expect(r.state).toBe("reachable");
    expect(r.models.map((m) => m.id)).toEqual([
      "qwen/qwen3.8-27b",
      "text-embedding-nomic-embed-text-v1.5",
    ]);
    // Only the names are known: guesses.
    expect(byId(r, "qwen/qwen3.8-27b")?.capabilities).toMatchObject({
      source: "heuristic",
      toolCalling: true,
    });
    expect(byId(r, "text-embedding-nomic-embed-text-v1.5")?.capabilities.embeddings).toBe(true);
  });

  it("Ollama: tags, loaded models, version and per-model capabilities from /api/show", async () => {
    const replay = replayFetch(
      loadFixture("ollama/probe-tags.json"),
      loadFixture("ollama/probe-ps.json"),
      loadFixture("ollama/probe-version.json"),
      loadFixture("ollama/probe-show-qwen.json"),
      loadFixture("ollama/probe-show-nomic.json"),
    );
    const r = await probeEndpoint({ id: "ollama", kind: "ollama" }, { fetch: replay.fetch, clock });
    expect(r.server).toBe("Ollama 0.12.6");
    expect(byId(r, "qwen3.8:27b")).toMatchObject({
      loaded: true,
      capabilities: {
        source: "listing",
        toolCalling: true,
        vision: false,
        reasoning: true,
        contextWindow: 262144,
      },
    });
    expect(byId(r, "nomic-embed-text:latest")).toMatchObject({
      loaded: false,
      capabilities: { embeddings: true, toolCalling: false, contextWindow: 2048 },
    });
    expect(replay.requests[3]).toMatchObject({ method: "POST", body: { model: "qwen3.8:27b" } });
  });

  it("OpenRouter: context, modalities and tool support from the public listing", async () => {
    const replay = replayFetch(loadFixture("openrouter/list-models.json"));
    const r = await probeEndpoint(
      { id: "openrouter", kind: "openrouter" },
      { fetch: replay.fetch, clock },
    );
    expect(byId(r, "anthropic/claude-sonnet-5-5")).toMatchObject({
      ref: "openrouter/anthropic/claude-sonnet-5-5",
      label: "Anthropic: Claude Sonnet 5.5",
      capabilities: { contextWindow: 1000000, vision: true, toolCalling: true, reasoning: true },
    });
    expect(byId(r, "meta-llama/llama-3.1-8b-instruct:free")?.capabilities).toMatchObject({
      toolCalling: false,
      vision: false,
    });
  });

  it("Gemini: the key goes in x-goog-api-key, resolved from the vault per request", async () => {
    const secret = fakeKey("probe-google");
    const { config, keys } = withKey(
      { id: "google", kind: "google" },
      "https://generativelanguage.googleapis.com",
      secret,
    );
    const replay = replayFetch(loadFixture("google/list-models.json"));
    const r = await probeEndpoint(config, { fetch: replay.fetch, keys, clock });
    expect(replay.requests[0]?.headers["x-goog-api-key"]).toBe(secret);
    expect(byId(r, "gemini-3.8-flash")).toMatchObject({
      label: "Gemini 3.8 Flash",
      capabilities: {
        contextWindow: 1048576,
        toolCalling: true,
        reasoning: true,
        embeddings: false,
      },
    });
    expect(byId(r, "gemini-embedding-001")?.capabilities.embeddings).toBe(true);
    expect(JSON.stringify(r)).not.toContain(secret);
  });

  it("OpenAI: ids from the listing, facts from the catalog", async () => {
    const secret = fakeKey("probe-openai");
    const { config, keys } = withKey(
      { id: "openai", kind: "openai" },
      "https://api.openai.com",
      secret,
    );
    const replay = replayFetch(loadFixture("openai/list-models.json"));
    const r = await probeEndpoint(config, { fetch: replay.fetch, keys, clock });
    expect(replay.requests[0]?.headers.authorization).toBe(`Bearer ${secret}`);
    expect(r.models.map((m) => m.ref)).toEqual(["openai/gpt-5.5", "openai/text-embedding-3-small"]);
    expect(byId(r, "text-embedding-3-small")?.capabilities.embeddings).toBe(true);
  });

  it("reports auth_failed for a refused key, without the key", async () => {
    const secret = fakeKey("probe-anthropic");
    const { config, keys } = withKey(
      { id: "anthropic", kind: "anthropic" },
      "https://api.anthropic.com",
      secret,
    );
    const replay = replayFetch(loadFixture("anthropic/list-models-401.json"));
    const r = await probeEndpoint(config, { fetch: replay.fetch, keys, clock });
    expect(r).toMatchObject({ state: "auth_failed", models: [] });
    expect(replay.requests[0]?.headers["x-api-key"]).toBe(secret);
    expect(replay.requests[0]?.headers["anthropic-version"]).toBe("2023-06-01");
    expect(JSON.stringify(r)).not.toContain(secret);
    expect(JSON.stringify(r)).not.toContain(KEY_SENTINEL);
  });

  it("reports unreachable when nothing answers, and when it times out", async () => {
    const refused = (async () => {
      throw new TypeError("fetch failed", {
        cause: new Error("connect ECONNREFUSED 127.0.0.1:1234"),
      });
    }) as unknown as typeof fetch;
    const r = await probeEndpoint({ id: "lmstudio", kind: "lmstudio" }, { fetch: refused, clock });
    expect(r).toMatchObject({ state: "unreachable", models: [] });
    expect(r.error).toContain("http://127.0.0.1:1234/v1");

    const stalled = ((_: unknown, init?: RequestInit) =>
      new Promise((_, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      })) as unknown as typeof fetch;
    const t = await probeEndpoint(
      { id: "llamacpp", kind: "llamacpp" },
      { fetch: stalled, clock, timeoutMs: 5 },
    );
    expect(t.state).toBe("unreachable");
  });

  it("reports error for a generic compatible kind with no baseURL", async () => {
    const r = await probeEndpoint({ id: "vllm", kind: "openai-compatible" }, { clock });
    expect(r).toMatchObject({ state: "error", models: [] });
  });

  it("lets the owner's per-model config win over the listing", async () => {
    const replay = replayFetch(
      loadFixture("llamacpp/models.json"),
      loadFixture("llamacpp/props.json"),
    );
    const r = await probeEndpoint(
      { id: "llamacpp", kind: "llamacpp", models: { "qwen3.8-27b": { vision: true } } },
      { fetch: replay.fetch, clock },
    );
    expect(byId(r, "qwen3.8-27b")?.capabilities).toMatchObject({ source: "config", vision: true });
  });

  it("stores results in memory and as settings rows", () => {
    const result: EndpointProbeResult = { state: "unreachable", models: [], error: "x" };
    const mem = new InMemoryEndpointProbeStore();
    mem.set("lmstudio", result);
    expect(mem.get("lmstudio")).toEqual(result);
    const rows = new Map<string, unknown>();
    const kv = new KeyValueEndpointProbeStore({
      get: (k) => rows.get(k),
      set: (k, v) => rows.set(k, v),
    });
    kv.set("lmstudio", result);
    expect(rows.has("models.endpoint.lmstudio")).toBe(true);
    expect(kv.get("lmstudio")).toEqual(result);
    rows.set("models.endpoint.bad", { nope: true });
    expect(kv.get("bad")).toBeUndefined();
  });
});
