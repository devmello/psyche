import type { createAnthropic } from "@ai-sdk/anthropic";
import type { createGoogle } from "@ai-sdk/google";
import type { createOpenAI } from "@ai-sdk/openai";
import type { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { EmbeddingModelV4, LanguageModelV4 } from "@ai-sdk/provider";
import type { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { PsycheError } from "@psyche/protocol";
import type { createOllama } from "ollama-ai-provider-v2";
import { compatFetch, transformCompatRequest } from "./compat.ts";
import type { ProviderConfig, ProviderKind } from "./config.ts";
import { KEY_SENTINEL } from "./credentials.ts";

/**
 * The AI SDK provider packages, imported on first use (docs/design/lightweight-2026.md): each
 * costs 1–2 MB of heap and a Gateway talks to one or two providers, so the rest never load.
 */
interface Packages {
  anthropic?: typeof createAnthropic;
  google?: typeof createGoogle;
  openai?: typeof createOpenAI;
  openaiCompatible?: typeof createOpenAICompatible;
  openrouter?: typeof createOpenRouter;
  ollama?: typeof createOllama;
}
const packages: Packages = {};

/** Imports the package `kind` needs; `buildProvider` for that kind works once this resolved. */
export async function loadProviderPackage(kind: ProviderKind): Promise<void> {
  switch (kind) {
    case "anthropic":
    case "anthropic-compatible":
      packages.anthropic ??= (await import("@ai-sdk/anthropic")).createAnthropic;
      return;
    case "openai":
      packages.openai ??= (await import("@ai-sdk/openai")).createOpenAI;
      return;
    case "google":
      packages.google ??= (await import("@ai-sdk/google")).createGoogle;
      return;
    case "openrouter":
      packages.openrouter ??= (await import("@openrouter/ai-sdk-provider")).createOpenRouter;
      return;
    case "ollama":
      packages.ollama ??= (await import("ollama-ai-provider-v2")).createOllama;
      return;
    case "openai-compatible":
    case "llamacpp":
    case "lmstudio":
      packages.openaiCompatible ??= (
        await import("@ai-sdk/openai-compatible")
      ).createOpenAICompatible;
      return;
    case "claude-code":
    case "codex":
      return;
  }
}

function loaded<T>(fn: T | undefined, kind: ProviderKind): T {
  if (fn === undefined) {
    throw new PsycheError(
      "internal",
      `provider package for ${kind} not loaded (loadProviderPackage)`,
    );
  }
  return fn;
}

/**
 * Hosted defaults, passed explicitly so the packages never read `ANTHROPIC_BASE_URL`,
 * `OPENAI_BASE_URL` and friends from the environment.
 */
export const HOSTED_DEFAULT_BASE_URLS = {
  anthropic: "https://api.anthropic.com/v1",
  openai: "https://api.openai.com/v1",
  google: "https://generativelanguage.googleapis.com/v1beta",
  openrouter: "https://openrouter.ai/api/v1",
} as const;

/** Defaults for the local servers the README documents. */
export const LOCAL_DEFAULT_BASE_URLS = {
  ollama: "http://127.0.0.1:11434/api",
  ollamaAnthropic: "http://127.0.0.1:11434/v1",
  llamaCpp: "http://127.0.0.1:8080/v1",
  lmStudio: "http://127.0.0.1:1234/v1",
  vllm: "http://127.0.0.1:8000/v1",
} as const;

interface Built {
  language(modelId: string): LanguageModelV4;
  embedding?(modelId: string): EmbeddingModelV4;
}

function needBaseURL(config: ProviderConfig): string {
  if (config.baseURL === undefined || config.baseURL.length === 0) {
    throw new PsycheError(
      "invalid_params",
      `provider "${config.id}" (${config.kind}) needs a baseURL`,
    );
  }
  return config.baseURL;
}

/**
 * Build the AI SDK provider for one config, after `loadProviderPackage(config.kind)`. `fetch` is the key-injecting wrapper for the
 * profile in use; packages get `KEY_SENTINEL` as their key so they never hold the real one
 * and never fall back to environment variables.
 */
export function buildProvider(config: ProviderConfig, fetch: typeof globalThis.fetch): Built {
  const headers = config.headers;
  switch (config.kind) {
    case "anthropic":
    case "anthropic-compatible": {
      const settings: Parameters<typeof createAnthropic>[0] = {
        apiKey: KEY_SENTINEL,
        fetch,
        name: config.id,
      };
      settings.baseURL =
        config.kind === "anthropic-compatible"
          ? needBaseURL(config)
          : (config.baseURL ?? HOSTED_DEFAULT_BASE_URLS.anthropic);
      if (headers !== undefined) settings.headers = headers;
      const p = loaded(packages.anthropic, config.kind)(settings);
      return { language: (id) => p.languageModel(id) };
    }
    case "openai": {
      const settings: Parameters<typeof createOpenAI>[0] = {
        apiKey: KEY_SENTINEL,
        fetch,
        name: config.id,
      };
      settings.baseURL = config.baseURL ?? HOSTED_DEFAULT_BASE_URLS.openai;
      if (headers !== undefined) settings.headers = headers;
      const p = loaded(packages.openai, config.kind)(settings);
      return { language: (id) => p.responses(id), embedding: (id) => p.embedding(id) };
    }
    case "google": {
      const settings: Parameters<typeof createGoogle>[0] = {
        apiKey: KEY_SENTINEL,
        fetch,
        name: config.id,
      };
      settings.baseURL = config.baseURL ?? HOSTED_DEFAULT_BASE_URLS.google;
      if (headers !== undefined) settings.headers = headers;
      const p = loaded(packages.google, config.kind)(settings);
      return {
        language: (id) =>
          config.googleApi === "generate-content" ? p.languageModel(id) : p.interactions(id),
        embedding: (id) => p.embedding(id),
      };
    }
    case "openrouter": {
      const settings: Parameters<typeof createOpenRouter>[0] = {
        apiKey: KEY_SENTINEL,
        fetch,
        compatibility: "strict",
      };
      settings.baseURL = config.baseURL ?? HOSTED_DEFAULT_BASE_URLS.openrouter;
      // App attribution only when the owner asks for it (no telemetry by default).
      if (config.attribution?.url !== undefined) settings.appUrl = config.attribution.url;
      if (config.attribution?.title !== undefined) settings.appName = config.attribution.title;
      if (headers !== undefined) settings.headers = headers;
      const p = loaded(packages.openrouter, config.kind)(settings);
      return {
        language: (id) => p.chat(id) as unknown as LanguageModelV4,
        embedding: (id) => p.textEmbeddingModel(id) as unknown as EmbeddingModelV4,
      };
    }
    case "openai-compatible": {
      const settings: Parameters<typeof createOpenAICompatible>[0] = {
        name: config.id,
        baseURL: needBaseURL(config),
        apiKey: KEY_SENTINEL,
        fetch,
        includeUsage: true,
      };
      if (headers !== undefined) settings.headers = headers;
      const p = loaded(packages.openaiCompatible, config.kind)(settings);
      return { language: (id) => p.chatModel(id), embedding: (id) => p.embeddingModel(id) };
    }
    case "llamacpp":
    case "lmstudio": {
      const kind = config.kind;
      const settings: Parameters<typeof createOpenAICompatible>[0] = {
        name: config.id,
        baseURL:
          config.baseURL ??
          (kind === "llamacpp"
            ? LOCAL_DEFAULT_BASE_URLS.llamaCpp
            : LOCAL_DEFAULT_BASE_URLS.lmStudio),
        apiKey: KEY_SENTINEL,
        fetch: compatFetch(fetch),
        includeUsage: true,
        transformRequestBody: (body) => transformCompatRequest(kind, body),
      };
      if (headers !== undefined) settings.headers = headers;
      const p = loaded(packages.openaiCompatible, config.kind)(settings);
      return { language: (id) => p.chatModel(id), embedding: (id) => p.embeddingModel(id) };
    }
    case "claude-code":
    case "codex":
      // Subscription CLIs are not AI SDK providers; `createModelRouter` builds a CliAdapter.
      throw new PsycheError(
        "invalid_params",
        `provider "${config.id}" (${config.kind}) runs through its CLI, not an API package`,
      );
    case "ollama": {
      const settings: Parameters<typeof createOllama>[0] = {
        baseURL: config.baseURL ?? LOCAL_DEFAULT_BASE_URLS.ollama,
        fetch,
        compatibility: "strict",
      };
      if (headers !== undefined) settings.headers = headers;
      const p = loaded(packages.ollama, config.kind)(settings);
      return { language: (id) => p.chat(id), embedding: (id) => p.embedding(id) };
    }
  }
}
