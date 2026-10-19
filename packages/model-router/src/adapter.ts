import type {
  EmbeddingModelV4,
  LanguageModelV4,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import {
  type CallOptions,
  type EmbedOptions,
  type ModelCapabilities,
  type ModelEvent,
  type ModelProvider,
  type ModelRef,
  type ModelRequest,
  PsycheError,
  type Usage,
} from "@psyche/protocol";
import {
  type AuthProfile,
  isLocalKind,
  type ProviderConfig,
  priceProviderOf,
  timeoutsOf,
} from "./config.ts";
import { convertRequest } from "./convert-request.ts";
import { StreamConverter } from "./convert-stream.ts";
import { type KeySource, keyInjectingFetch, NO_KEYS } from "./credentials.ts";
import { classifyError, ModelCallError } from "./errors.ts";
import { buildProvider } from "./factory.ts";
import { Prices } from "./prices.ts";
import { formatModelRef, parseModelRef } from "./refs.ts";
import { normalizeUsage } from "./usage.ts";

/** What happened on one call, reported to the router (the stream itself never throws). */
export interface CallOutcome {
  ref: ModelRef;
  profileId: string | undefined;
  usage: Usage | undefined;
  /** Cost came from the provider (OpenRouter) rather than the price table. */
  providerCost: boolean;
  /** The model has no price-table entry and is not local; cost is reported as 0. */
  unpriced: boolean;
  error: ModelCallError | undefined;
  /** Model-visible content was streamed before the error (no silent fallback possible). */
  contentStarted: boolean;
}

export interface AdapterCallOptions extends CallOptions {
  /** Auth profile to use (default: the first). */
  profileId?: string;
  onOutcome?: (outcome: CallOutcome) => void;
}

export interface EmbedTaskOptions extends EmbedOptions {
  /** Retrieval task for models that want prefixes (nomic-embed-text). Default `document`. */
  task?: "document" | "query";
}

export interface AdapterDeps {
  keys?: KeySource;
  prices?: Prices;
  /** Base fetch (tests replay recorded fixtures through this). */
  fetch?: typeof fetch;
}

/** Known embedding dimensions; others are measured on first use. */
export const EMBEDDING_DIMENSIONS: Record<string, number> = {
  "nomic-embed-text": 768,
  "nomic-embed-text:v1.5": 768,
  "nomic-embed-text-v1.5": 768,
  "qwen3-embedding:0.6b": 1024,
  "Qwen3-Embedding-0.6B": 1024,
  "text-embedding-3-small": 1536,
  "text-embedding-3-large": 3072,
};

function nomicPrefix(modelId: string, task: "document" | "query"): string {
  return /nomic-embed-text/i.test(modelId)
    ? task === "query"
      ? "search_query: "
      : "search_document: "
    : "";
}

/**
 * `ModelProvider` for one provider config, on an AI SDK v7 provider package. Drives the
 * model's `doStream` directly so the router owns retries and every provider-native part is
 * visible for opaque round-tripping.
 */
export class AiSdkAdapter implements ModelProvider {
  readonly id: string;
  readonly config: ProviderConfig;
  readonly #keys: KeySource;
  readonly #prices: Prices;
  readonly #fetch: typeof fetch;
  readonly #built = new Map<string, ReturnType<typeof buildProvider>>();
  readonly #dims = new Map<string, number>();

  constructor(config: ProviderConfig, deps: AdapterDeps = {}) {
    this.id = config.id;
    this.config = config;
    this.#keys = deps.keys ?? NO_KEYS;
    this.#prices = deps.prices ?? new Prices();
    this.#fetch = deps.fetch ?? globalThis.fetch;
  }

  /** Profiles in rotation order; a keyless provider has one implicit profile. */
  profiles(): (AuthProfile | undefined)[] {
    const p = this.config.profiles ?? [];
    return p.length > 0 ? p : [undefined];
  }

  #profile(id: string | undefined): AuthProfile | undefined {
    const all = this.config.profiles ?? [];
    if (id === undefined) return all[0];
    const hit = all.find((p) => p.id === id);
    if (hit === undefined) throw new PsycheError("not_found", `unknown auth profile "${id}"`);
    return hit;
  }

  #provider(profile: AuthProfile | undefined) {
    const key = profile?.id ?? "";
    let built = this.#built.get(key);
    if (built === undefined) {
      built = buildProvider(this.config, keyInjectingFetch(this.#fetch, this.#keys, profile));
      this.#built.set(key, built);
    }
    return built;
  }

  /** The AI SDK model for one model id (exposed for tests and `prepareStep` hooks). */
  languageModel(modelId: string, profileId?: string): LanguageModelV4 {
    return this.#provider(this.#profile(profileId)).language(modelId);
  }

  #priceRef(modelId: string): ModelRef | undefined {
    const pp = priceProviderOf(this.config);
    return pp === undefined ? undefined : formatModelRef(pp, modelId);
  }

  #cost(
    modelId: string,
    usage: Usage,
    metadata: Record<string, Record<string, unknown>> | undefined,
  ) {
    const orUsage = metadata?.openrouter?.usage as { cost?: unknown } | undefined;
    if (typeof orUsage?.cost === "number" && orUsage.cost >= 0) {
      return { costUsd: orUsage.cost, providerCost: true, unpriced: false };
    }
    if (isLocalKind(this.config.kind)) return { costUsd: 0, providerCost: false, unpriced: false };
    const ref = this.#priceRef(modelId);
    const cost =
      ref === undefined
        ? undefined
        : this.#prices.cost(ref, usage, { cacheTtl: this.config.cacheTtl ?? "5m" });
    return { costUsd: cost ?? 0, providerCost: false, unpriced: cost === undefined };
  }

  async *stream(
    request: ModelRequest,
    options: AdapterCallOptions = {},
  ): AsyncIterable<ModelEvent> {
    const outcome: CallOutcome = {
      ref: request.model,
      profileId: options.profileId,
      usage: undefined,
      providerCost: false,
      unpriced: false,
      error: undefined,
      contentStarted: false,
    };
    const report = () => options.onOutcome?.(outcome);
    const signal = options.signal;
    if (signal?.aborted === true) {
      outcome.error = new ModelCallError("cancelled", "cancelled");
      report();
      yield { type: "finish", reason: "cancelled" };
      return;
    }

    let modelId: string;
    let profile: AuthProfile | undefined;
    try {
      const parsed = parseModelRef(request.model);
      if (parsed.provider !== this.id) {
        throw new ModelCallError(
          "bad_request",
          `ref ${request.model} is not for provider ${this.id}`,
        );
      }
      modelId = parsed.model;
      profile = this.#profile(options.profileId);
      outcome.profileId = profile?.id;
    } catch (err) {
      outcome.error =
        err instanceof ModelCallError
          ? err
          : new ModelCallError("bad_request", String((err as Error).message));
      report();
      yield { type: "finish", reason: "error", error: outcome.error.toFinishError() };
      return;
    }

    const timeouts = timeoutsOf(this.config);
    const ac = new AbortController();
    const onAbort = () => ac.abort(signal?.reason);
    signal?.addEventListener("abort", onAbort, { once: true });
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = (ms: number) => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        timedOut = true;
        ac.abort(new Error("timeout"));
      }, ms);
    };
    const aborted = new Promise<never>((_, reject) => {
      ac.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
        once: true,
      });
    });
    aborted.catch(() => {});

    const converter = new StreamConverter(this.id, modelId);
    let reader: ReadableStreamDefaultReader<LanguageModelV4StreamPart> | undefined;
    arm(timeouts.firstEventMs);
    try {
      const model = this.#provider(profile).language(modelId);
      const call = convertRequest(request, { config: this.config, modelId });
      const result = await Promise.race([
        model.doStream({ ...call, abortSignal: ac.signal }),
        aborted,
      ]);
      reader = result.stream.getReader();
      while (true) {
        const { done, value } = await Promise.race([reader.read(), aborted]);
        if (done) break;
        arm(timeouts.idleMs);
        const events = converter.push(value);
        outcome.contentStarted = converter.contentStarted;
        for (const event of events) {
          yield event;
          if (isAborted(signal)) throw new DOMException("aborted", "AbortError");
        }
        if (converter.finish !== undefined) break;
      }
      const fin = converter.finish;
      if (fin === undefined)
        throw new ModelCallError("server_error", "stream ended without a finish part");
      const usage = normalizeUsage(fin.usage);
      const cost = this.#cost(modelId, usage, fin.metadata);
      usage.costUsd = cost.costUsd;
      outcome.usage = usage;
      outcome.providerCost = cost.providerCost;
      outcome.unpriced = cost.unpriced;
      if (fin.error !== undefined) {
        const kind = fin.error.startsWith("content_filter") ? "content_filter" : "server_error";
        outcome.error = new ModelCallError(kind, fin.error.slice(fin.error.indexOf(": ") + 2));
      }
      report();
      yield { type: "usage", usage };
      yield fin.error === undefined
        ? { type: "finish", reason: fin.reason }
        : { type: "finish", reason: "error", error: fin.error };
    } catch (err) {
      outcome.contentStarted = converter.contentStarted;
      if (isAborted(signal) && !timedOut) {
        outcome.error = new ModelCallError("cancelled", "cancelled");
        report();
        yield { type: "finish", reason: "cancelled" };
        return;
      }
      const e = timedOut
        ? new ModelCallError("timeout", `no stream data from ${request.model} within the timeout`)
        : classifyError(err, (t) => this.#keys.redact(t));
      outcome.error = e;
      report();
      yield { type: "finish", reason: "error", error: e.toFinishError() };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (!ac.signal.aborted) ac.abort();
      reader?.cancel().catch(() => {});
    }
  }

  #embeddingModel(modelId: string, profileId?: string): EmbeddingModelV4 {
    const built = this.#provider(this.#profile(profileId));
    if (built.embedding === undefined) {
      throw new PsycheError(
        "invalid_params",
        `provider ${this.id} (${this.config.kind}) has no embeddings`,
      );
    }
    return built.embedding(modelId);
  }

  /** Embed texts; `options.model` is required (or the first of `embeddingModels`). */
  async embed(texts: string[], options: EmbedTaskOptions = {}): Promise<number[][]> {
    const ref = options.model;
    const modelId = ref !== undefined ? parseModelRef(ref).model : this.config.embeddingModels?.[0];
    if (modelId === undefined)
      throw new PsycheError("invalid_params", `no embedding model for ${this.id}`);
    if (texts.length === 0) return [];
    const prefix = nomicPrefix(modelId, options.task ?? "document");
    const model = this.#embeddingModel(modelId);
    const max = (await model.maxEmbeddingsPerCall) ?? texts.length;
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += max) {
      const values = texts.slice(i, i + max).map((t) => prefix + t);
      try {
        const callOpts: Parameters<EmbeddingModelV4["doEmbed"]>[0] = { values };
        if (options.signal !== undefined) callOpts.abortSignal = options.signal;
        const res = await model.doEmbed(callOpts);
        out.push(...res.embeddings.map((e) => Array.from(e)));
      } catch (err) {
        const e = classifyError(err, (t) => this.#keys.redact(t));
        throw new PsycheError(
          e.kind === "rate_limited" ? "rate_limited" : "unavailable",
          e.toFinishError(),
          {
            retryable: e.kind !== "bad_request",
          },
        );
      }
    }
    const first = out[0];
    if (first !== undefined) this.#dims.set(modelId, first.length);
    return out;
  }

  /** Dimension of an embedding model: known table, measured value, or one probe call. */
  async embeddingDimensions(modelId: string): Promise<number> {
    const known = this.#dims.get(modelId) ?? EMBEDDING_DIMENSIONS[modelId];
    if (known !== undefined) return known;
    const [v] = await this.embed(["dimension probe"], { model: formatModelRef(this.id, modelId) });
    return v?.length ?? 0;
  }

  async capabilities(model?: ModelRef): Promise<ModelCapabilities> {
    const modelId = model === undefined ? undefined : parseModelRef(model).model;
    const priceRef = modelId === undefined ? undefined : this.#priceRef(modelId);
    const price = priceRef === undefined ? undefined : this.#prices.lookup(priceRef);
    const local = isLocalKind(this.config.kind);
    const caps: ModelCapabilities = {
      // Local models are agent-capable only once the probe says so (`ModelRouter` gates this).
      toolCalling: price?.toolCalling ?? true,
      vision: price?.vision ?? false,
      reasoning: price?.reasoning ?? false,
      embeddings:
        price?.mode === "embedding" ||
        (modelId !== undefined && (this.config.embeddingModels ?? []).includes(modelId)),
      promptCaching: price?.promptCaching ?? this.config.kind === "anthropic",
    };
    if (price?.contextWindow !== undefined) caps.contextWindow = price.contextWindow;
    if (price?.maxOutput !== undefined) caps.maxOutputTokens = price.maxOutput;
    if (local && price === undefined) caps.promptCaching = false;
    const override = modelId === undefined ? undefined : this.config.models?.[modelId];
    return { ...caps, ...override };
  }
}

/** Read through a function so TypeScript does not narrow `aborted` across awaits. */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}
