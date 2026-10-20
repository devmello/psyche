import type { Clock, ModelRef } from "@psyche/protocol";
import {
  type CapabilityFacts,
  type CapabilityGuess,
  factsFromConfig,
  factsFromPrice,
  guessFromName,
  mergeFacts,
} from "./capability-guess.ts";
import { cliDialectFor } from "./cli/index.ts";
import { probeCli } from "./cli/probe.ts";
import type { ResolveCliOptions } from "./cli/resolve.ts";
import {
  type AuthProfile,
  isSubscriptionKind,
  type ProviderConfig,
  priceProviderOf,
} from "./config.ts";
import { KEY_SENTINEL, type KeySource, keyInjectingFetch, NO_KEYS } from "./credentials.ts";
import { HOSTED_DEFAULT_BASE_URLS, LOCAL_DEFAULT_BASE_URLS } from "./factory.ts";
import { Prices } from "./prices.ts";
import type { KeyValueStore } from "./probe.ts";
import { formatModelRef } from "./refs.ts";

/**
 * Endpoint probe (B4, Settings → Model & providers): given one provider config, report whether
 * the endpoint answers, which models it lists and what each can probably do (vision, tool use,
 * context length). Runs only when the owner asks; until then a provider is `not_probed`.
 * Read-only GETs (plus Ollama's `POST /api/show`, which reads model metadata); keys go through
 * the same `KeySource` the adapters use and never appear in the result.
 */

export type EndpointProbeState =
  | "not_probed"
  | "reachable"
  | "unreachable"
  | "auth_failed"
  | "error";

export interface ProbedModel {
  ref: ModelRef;
  id: string;
  label?: string;
  capabilities: CapabilityGuess;
  loaded?: boolean;
}

export interface EndpointProbeResult {
  state: EndpointProbeState;
  /** ISO-8601 UTC. */
  probedAt?: string;
  latencyMs?: number;
  server?: string;
  models: ProbedModel[];
  error?: string;
}

export const NOT_PROBED: EndpointProbeResult = Object.freeze({
  state: "not_probed",
  models: [],
}) as EndpointProbeResult;

export interface EndpointProbeDeps {
  fetch?: typeof fetch;
  keys?: KeySource;
  prices?: Prices;
  clock?: Clock;
  /** Per HTTP request (default 5 s; local servers answer listings at once). */
  timeoutMs?: number;
  /** Most models reported (default 500). */
  maxModels?: number;
  /** Most Ollama `/api/show` lookups (default 25); the rest keep name guesses. */
  maxDetails?: number;
  /** Subscription CLIs: the environment their probe commands run in (default `process.env`). */
  cliEnv?: NodeJS.ProcessEnv;
  /** Subscription CLIs: how the CLI is found (tests: a fake home, no login shell). */
  cliResolve?: Omit<ResolveCliOptions, "command" | "env">;
}

export interface EndpointProbeOptions {
  signal?: AbortSignal;
  /** Auth profile to probe with (default: the first). */
  profileId?: string;
}

/** A model as one listing reports it, before facts merge. */
interface Listed {
  id: string;
  label?: string;
  facts: CapabilityFacts;
  loaded?: boolean;
}

interface Listing {
  server?: string;
  models: Listed[];
}

class HttpError extends Error {
  readonly status: number;
  /** The provider's own reason from the error body (`invalid x-api-key`), when it gave one. */
  readonly reason: string | undefined;
  constructor(status: number, message: string, reason?: string) {
    super(message);
    this.status = status;
    this.reason = reason;
  }
}

/**
 * The reason in a provider error body: Anthropic / OpenAI / OpenRouter `{error: {message}}`,
 * Gemini `{error: {message, status}}`, LM Studio `{error: "…"}`, or `{message}`.
 */
export function providerErrorReason(body: string): string | undefined {
  try {
    const j = JSON.parse(body) as { error?: unknown; message?: unknown };
    const e = j.error;
    const text =
      typeof e === "string"
        ? e
        : isObject(e) && typeof e.message === "string"
          ? e.message
          : typeof j.message === "string"
            ? j.message
            : undefined;
    return text === undefined ? undefined : text.replace(/\s+/g, " ").trim().slice(0, 200);
  } catch {
    return undefined;
  }
}

/**
 * What a failed probe tells the owner. 401 / 403: the key (a missing key says so). 400, 404,
 * 405, 415, 422: the request itself, which is Psyche's or the endpoint's problem, not the key's.
 */
export function probeHttpError(err: { status: number; reason?: string | undefined }): {
  state: "auth_failed" | "error";
  error: string;
} {
  const detail = `HTTP ${err.status}${err.reason === undefined ? "" : `: ${err.reason}`}`;
  if (err.status === 401 || err.status === 403) {
    const missing = /header is required|missing (?:api )?key|no api key|not provided/i.test(
      err.reason ?? "",
    );
    return {
      state: "auth_failed",
      error: missing
        ? `no key reached the endpoint (${detail})`
        : `the endpoint refused the key (${detail})`,
    };
  }
  if ([400, 404, 405, 415, 422].includes(err.status)) {
    return { state: "error", error: `the endpoint rejected the request as malformed (${detail})` };
  }
  return { state: "error", error: `the endpoint failed (${detail})` };
}

type Get = (
  url: string,
  init?: { method?: string; body?: unknown; key?: KeyStyle },
) => Promise<{
  json: unknown;
  headers: Headers;
}>;

type KeyStyle = "bearer" | "anthropic" | "google" | "none";

function trimSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

/** `http://host:1234/v1` → `http://host:1234` (llama.cpp `/props`, LM Studio `/api/v0`). */
export function endpointRoot(baseURL: string): string {
  return trimSlash(baseURL).replace(/\/(?:api\/v\d+|api|v\d+(?:beta)?)$/, "");
}

export function defaultBaseURL(config: ProviderConfig): string | undefined {
  if (config.baseURL !== undefined && config.baseURL.length > 0) return trimSlash(config.baseURL);
  switch (config.kind) {
    case "anthropic":
    case "openai":
    case "google":
    case "openrouter":
      return HOSTED_DEFAULT_BASE_URLS[config.kind];
    case "ollama":
      return LOCAL_DEFAULT_BASE_URLS.ollama;
    case "llamacpp":
      return LOCAL_DEFAULT_BASE_URLS.llamaCpp;
    case "lmstudio":
      return LOCAL_DEFAULT_BASE_URLS.lmStudio;
    default:
      return undefined;
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** OpenAI-style `{data: [{id}]}` (OpenAI, Anthropic, Ollama `/v1`, generic compatible). */
function openAIList(json: unknown): Listed[] {
  const data = isObject(json) ? arr(json.data) : [];
  const out: Listed[] = [];
  for (const m of data) {
    if (!isObject(m)) continue;
    const id = str(m.id);
    if (id === undefined) continue;
    const listed: Listed = { id, facts: {} };
    const label = str(m.display_name) ?? str(m.name);
    if (label !== undefined && label !== id) listed.label = label;
    out.push(listed);
  }
  return out;
}

async function listOpenAI(get: Get, base: string): Promise<Listing> {
  const { json } = await get(`${base}/models`, { key: "bearer" });
  return { models: openAIList(json) };
}

async function listAnthropic(get: Get, base: string): Promise<Listing> {
  const { json } = await get(`${base}/models?limit=1000`, { key: "anthropic" });
  return { models: openAIList(json) };
}

/** Gemini `GET /v1beta/models`: `models[].name` is `models/<id>`. */
async function listGoogle(get: Get, base: string): Promise<Listing> {
  const { json } = await get(`${base}/models?pageSize=1000`, { key: "google" });
  const out: Listed[] = [];
  for (const m of isObject(json) ? arr(json.models) : []) {
    if (!isObject(m)) continue;
    const name = str(m.name);
    if (name === undefined) continue;
    const id = name.startsWith("models/") ? name.slice(7) : name;
    const methods = arr(m.supportedGenerationMethods).filter((x) => typeof x === "string");
    const facts: CapabilityFacts = {};
    const ctx = num(m.inputTokenLimit);
    if (ctx !== undefined) facts.contextWindow = ctx;
    if (methods.includes("embedContent")) facts.embeddings = true;
    if (methods.includes("generateContent")) {
      facts.embeddings = false;
      facts.toolCalling = true;
    }
    if (typeof m.thinking === "boolean") facts.reasoning = m.thinking;
    const listed: Listed = { id, facts };
    const label = str(m.displayName);
    if (label !== undefined) listed.label = label;
    out.push(listed);
  }
  return { models: out };
}

/** OpenRouter `GET /api/v1/models`: context, modalities and supported parameters per model. */
async function listOpenRouter(get: Get, base: string): Promise<Listing> {
  const { json } = await get(`${base}/models`, { key: "bearer" });
  const out: Listed[] = [];
  for (const m of isObject(json) ? arr(json.data) : []) {
    if (!isObject(m)) continue;
    const id = str(m.id);
    if (id === undefined) continue;
    const facts: CapabilityFacts = { embeddings: false };
    const ctx = num(m.context_length);
    if (ctx !== undefined) facts.contextWindow = ctx;
    const arch = isObject(m.architecture) ? m.architecture : {};
    const input = arr(arch.input_modalities);
    if (input.length > 0) facts.vision = input.includes("image");
    const params = arr(m.supported_parameters);
    if (params.length > 0) {
      facts.toolCalling = params.includes("tools");
      facts.reasoning = params.includes("reasoning") || params.includes("include_reasoning");
    }
    const listed: Listed = { id, facts };
    const label = str(m.name);
    if (label !== undefined) listed.label = label;
    out.push(listed);
  }
  return { models: out };
}

/**
 * llama-server: `GET /v1/models` (one model; `architecture.input_modalities`, `meta.n_ctx`,
 * `meta.n_ctx_train`; `meta` is null while loading) and `GET /props`
 * (`default_generation_settings.n_ctx`, `modalities.vision`, `chat_template_caps`). `/props`
 * is optional (older builds), so its failure keeps the listing.
 */
async function listLlamaCpp(get: Get, base: string): Promise<Listing> {
  const { json } = await get(`${base}/models`, { key: "bearer" });
  const data = isObject(json) ? arr(json.data) : [];
  let props: Record<string, unknown> = {};
  try {
    const res = await get(`${endpointRoot(base)}/props`, { key: "bearer" });
    if (isObject(res.json)) props = res.json;
  } catch (err) {
    if (err instanceof HttpError && (err.status === 401 || err.status === 403)) throw err;
  }
  const settings = isObject(props.default_generation_settings)
    ? props.default_generation_settings
    : {};
  const modalities = isObject(props.modalities) ? props.modalities : undefined;
  const caps = isObject(props.chat_template_caps) ? props.chat_template_caps : undefined;
  const models: Listed[] = [];
  for (const m of data) {
    if (!isObject(m)) continue;
    const id = str(m.id);
    if (id === undefined) continue;
    const meta = isObject(m.meta) ? m.meta : {};
    const arch = isObject(m.architecture) ? m.architecture : {};
    const facts: CapabilityFacts = {};
    // The runtime window (`-c`), not the training one, is what a prompt must fit.
    const ctx = num(settings.n_ctx) ?? num(meta.n_ctx) ?? num(meta.n_ctx_train);
    if (ctx !== undefined) facts.contextWindow = ctx;
    const input = arr(arch.input_modalities);
    if (input.length > 0) facts.vision = input.includes("image");
    if (typeof modalities?.vision === "boolean") facts.vision = modalities.vision;
    if (typeof caps?.supports_tool_calls === "boolean")
      facts.toolCalling = caps.supports_tool_calls;
    else if (typeof caps?.supports_tools === "boolean") facts.toolCalling = caps.supports_tools;
    facts.embeddings = false;
    // A server that is up answers for the one model it has loaded.
    models.push({ id, facts, loaded: true });
  }
  const build = str(props.build_info);
  return { server: build === undefined ? "llama.cpp" : `llama.cpp ${build}`, models };
}

/** LM Studio `GET /api/v1/models` (0.4+): `{models: [{key, type, capabilities, …}]}`. */
function lmStudioV1(json: unknown): Listed[] | undefined {
  if (!isObject(json) || !Array.isArray(json.models)) return undefined;
  const models: Listed[] = [];
  for (const m of json.models) {
    if (!isObject(m)) continue;
    const id = str(m.key) ?? str(m.id);
    if (id === undefined) continue;
    const type = str(m.type);
    const facts: CapabilityFacts = {};
    if (type === "embedding") {
      facts.embeddings = true;
      facts.toolCalling = false;
      facts.vision = false;
    } else if (type === "llm") {
      facts.embeddings = false;
    }
    const caps = isObject(m.capabilities) ? m.capabilities : undefined;
    if (typeof caps?.vision === "boolean") facts.vision = caps.vision;
    if (typeof caps?.trained_for_tool_use === "boolean")
      facts.toolCalling = caps.trained_for_tool_use;
    if (isObject(caps?.reasoning)) facts.reasoning = true;
    const instances = arr(m.loaded_instances);
    const loadedCtx = instances
      .map((i) => (isObject(i) && isObject(i.config) ? num(i.config.context_length) : undefined))
      .find((n) => n !== undefined);
    const ctx = loadedCtx ?? num(m.max_context_length);
    if (ctx !== undefined) facts.contextWindow = ctx;
    const listed: Listed = { id, facts, loaded: instances.length > 0 };
    const label = str(m.display_name);
    if (label !== undefined && label !== id) listed.label = label;
    models.push(listed);
  }
  return models;
}

/** LM Studio `GET /api/v0/models`: `{data: [{id, type: llm|vlm|embeddings, state, …}]}`. */
function lmStudioV0(json: unknown): Listed[] {
  const models: Listed[] = [];
  for (const m of isObject(json) ? arr(json.data) : []) {
    if (!isObject(m)) continue;
    const id = str(m.id);
    if (id === undefined) continue;
    const type = str(m.type);
    const facts: CapabilityFacts = {};
    if (type === "embeddings") {
      facts.embeddings = true;
      facts.toolCalling = false;
      facts.vision = false;
    } else if (type === "llm" || type === "vlm") {
      facts.embeddings = false;
      facts.vision = type === "vlm";
    }
    const ctx = num(m.loaded_context_length) ?? num(m.max_context_length);
    if (ctx !== undefined) facts.contextWindow = ctx;
    if (arr(m.capabilities).includes("tool_use")) facts.toolCalling = true;
    const listed: Listed = { id, facts };
    const state = str(m.state);
    if (state !== undefined) listed.loaded = state === "loaded";
    models.push(listed);
  }
  return models;
}

/**
 * LM Studio: the native REST listings carry model type, load state, context length and
 * capabilities. Newest first: `/api/v1/models`, then `/api/v0/models`, then the
 * OpenAI-compatible `/v1/models` (ids only).
 */
async function listLmStudio(get: Get, base: string): Promise<Listing> {
  const root = endpointRoot(base);
  const tryGet = async (url: string): Promise<unknown> => {
    try {
      return (await get(url, { key: "bearer" })).json;
    } catch (err) {
      if (!(err instanceof HttpError) || err.status === 401 || err.status === 403) throw err;
      return undefined;
    }
  };
  const v1 = lmStudioV1(await tryGet(`${root}/api/v1/models`));
  if (v1 !== undefined) return { server: "LM Studio", models: v1 };
  const v0 = await tryGet(`${root}/api/v0/models`);
  if (v0 !== undefined) return { server: "LM Studio", models: lmStudioV0(v0) };
  return { server: "LM Studio", models: (await listOpenAI(get, base)).models };
}

/**
 * Ollama native: `GET /api/tags`, then `POST /api/show` per model (capped) for `capabilities`
 * (`tools`, `vision`, `thinking`, `embedding`) and `<arch>.context_length`, `GET /api/ps` for
 * what is loaded and `GET /api/version`.
 */
async function listOllama(get: Get, base: string, maxDetails: number): Promise<Listing> {
  const { json } = await get(`${base}/tags`);
  const names = (isObject(json) ? arr(json.models) : [])
    .map((m) => (isObject(m) ? (str(m.model) ?? str(m.name)) : undefined))
    .filter((n): n is string => n !== undefined);
  const loaded = new Set<string>();
  let server = "Ollama";
  try {
    const ps = await get(`${base}/ps`);
    for (const m of isObject(ps.json) ? arr(ps.json.models) : []) {
      const n = isObject(m) ? (str(m.model) ?? str(m.name)) : undefined;
      if (n !== undefined) loaded.add(n);
    }
    const v = await get(`${base}/version`);
    const version = isObject(v.json) ? str(v.json.version) : undefined;
    if (version !== undefined) server = `Ollama ${version}`;
  } catch {
    // Optional endpoints.
  }
  const models: Listed[] = [];
  for (const [i, id] of names.entries()) {
    const facts: CapabilityFacts = {};
    if (i < maxDetails) {
      try {
        const show = await get(`${base}/show`, { method: "POST", body: { model: id } });
        const s = isObject(show.json) ? show.json : {};
        const caps = arr(s.capabilities);
        if (caps.length > 0) {
          facts.toolCalling = caps.includes("tools");
          facts.vision = caps.includes("vision");
          facts.reasoning = caps.includes("thinking");
          facts.embeddings = caps.includes("embedding");
        }
        const info = isObject(s.model_info) ? s.model_info : {};
        for (const [k, v] of Object.entries(info)) {
          if (k.endsWith(".context_length") && num(v) !== undefined) facts.contextWindow = num(v);
        }
      } catch (err) {
        if (err instanceof HttpError && (err.status === 401 || err.status === 403)) throw err;
      }
    }
    models.push({ id, facts, loaded: loaded.has(id) });
  }
  return { server, models };
}

function headersFor(style: KeyStyle | undefined): Record<string, string> {
  switch (style) {
    case "bearer":
      return { authorization: `Bearer ${KEY_SENTINEL}` };
    case "anthropic":
      return { "x-api-key": KEY_SENTINEL, "anthropic-version": "2023-06-01" };
    case "google":
      return { "x-goog-api-key": KEY_SENTINEL };
    default:
      return {};
  }
}

const NETWORK =
  /ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ETIMEDOUT|fetch failed|socket hang up|network|timeout|aborted/i;

function profileOf(config: ProviderConfig, id: string | undefined): AuthProfile | undefined {
  const all = config.profiles ?? [];
  return id === undefined ? all[0] : all.find((p) => p.id === id);
}

/** Probe one provider endpoint. Never throws: failures are a result state. */
export async function probeEndpoint(
  config: ProviderConfig,
  deps: EndpointProbeDeps = {},
  options: EndpointProbeOptions = {},
): Promise<EndpointProbeResult> {
  if (isSubscriptionKind(config.kind)) {
    return probeCli(config, cliDialectFor(config), {
      ...(deps.clock === undefined ? {} : { clock: deps.clock }),
      ...(deps.cliEnv === undefined ? {} : { env: deps.cliEnv }),
      ...(deps.cliResolve === undefined ? {} : { resolve: deps.cliResolve }),
    });
  }
  const clock = deps.clock ?? { now: () => Date.now() };
  const keys = deps.keys ?? NO_KEYS;
  const timeoutMs = deps.timeoutMs ?? 5_000;
  const started = clock.now();
  const probedAt = new Date(started).toISOString();
  const base = defaultBaseURL(config);
  if (base === undefined) {
    return { state: "error", probedAt, models: [], error: `${config.kind} needs a baseURL` };
  }
  const fetchFn = keyInjectingFetch(
    deps.fetch ?? globalThis.fetch,
    keys,
    profileOf(config, options.profileId),
  );
  const get: Get = async (url, init = {}) => {
    const ac = new AbortController();
    const onAbort = () => ac.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => ac.abort(new Error("timeout")), timeoutMs);
    try {
      const headers: Record<string, string> = {
        accept: "application/json",
        ...headersFor(init.key),
        ...config.headers,
      };
      const req: RequestInit = { method: init.method ?? "GET", headers, signal: ac.signal };
      if (init.body !== undefined) {
        headers["content-type"] = "application/json";
        req.body = JSON.stringify(init.body);
      }
      const res = await fetchFn(url, req);
      const text = await res.text();
      if (!res.ok) {
        throw new HttpError(res.status, `HTTP ${res.status}`, providerErrorReason(text));
      }
      return { json: text.length === 0 ? {} : (JSON.parse(text) as unknown), headers: res.headers };
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    }
  };

  let listing: Listing;
  try {
    switch (config.kind) {
      case "anthropic":
      case "anthropic-compatible":
        listing = await listAnthropic(get, base);
        break;
      case "google":
        listing = await listGoogle(get, base);
        break;
      case "openrouter":
        listing = await listOpenRouter(get, base);
        break;
      case "llamacpp":
        listing = await listLlamaCpp(get, base);
        break;
      case "lmstudio":
        listing = await listLmStudio(get, base);
        break;
      case "ollama":
        listing = await listOllama(get, base, deps.maxDetails ?? 25);
        break;
      default:
        listing = await listOpenAI(get, base);
    }
  } catch (err) {
    const latencyMs = Math.max(0, clock.now() - started);
    const message = keys.redact(err instanceof Error ? err.message : String(err)).slice(0, 300);
    if (err instanceof HttpError) {
      const reason = err.reason === undefined ? undefined : keys.redact(err.reason);
      const { state, error } = probeHttpError({ status: err.status, reason });
      return { state, probedAt, latencyMs, models: [], error };
    }
    const unreachable =
      NETWORK.test(message) || (err instanceof Error && err.name === "AbortError");
    return {
      state: unreachable ? "unreachable" : "error",
      probedAt,
      latencyMs,
      models: [],
      error: unreachable ? `nothing answered at ${base}` : `unexpected response (${message})`,
    };
  }

  const prices = deps.prices ?? new Prices();
  const pp = priceProviderOf(config);
  const models = listing.models.slice(0, deps.maxModels ?? 500).map((m): ProbedModel => {
    const price = pp === undefined ? undefined : prices.lookup(formatModelRef(pp, m.id));
    const capabilities = mergeFacts([
      ["heuristic", guessFromName(m.id)],
      ["catalog", price === undefined ? undefined : factsFromPrice(price)],
      ["listing", m.facts],
      ["config", factsFromConfig(config.models?.[m.id])],
    ]);
    const out: ProbedModel = { ref: formatModelRef(config.id, m.id), id: m.id, capabilities };
    if (m.label !== undefined) out.label = m.label;
    if (m.loaded !== undefined) out.loaded = m.loaded;
    return out;
  });
  const result: EndpointProbeResult = {
    state: "reachable",
    probedAt,
    latencyMs: Math.max(0, clock.now() - started),
    models,
  };
  if (listing.server !== undefined) result.server = listing.server;
  return result;
}

/** Where probe results live between runs. */
export interface EndpointProbeStore {
  get(
    providerId: string,
  ): EndpointProbeResult | undefined | Promise<EndpointProbeResult | undefined>;
  set(providerId: string, result: EndpointProbeResult): void | Promise<void>;
}

export class InMemoryEndpointProbeStore implements EndpointProbeStore {
  readonly #m = new Map<string, EndpointProbeResult>();
  get(providerId: string): EndpointProbeResult | undefined {
    const r = this.#m.get(providerId);
    return r === undefined ? undefined : structuredClone(r);
  }
  set(providerId: string, result: EndpointProbeResult): void {
    this.#m.set(providerId, structuredClone(result));
  }
}

export const ENDPOINT_PROBE_SETTING_PREFIX = "models.endpoint.";

/** Endpoint probe results as settings rows (`models.endpoint.<provider id>`). */
export class KeyValueEndpointProbeStore implements EndpointProbeStore {
  readonly #kv: KeyValueStore;

  constructor(kv: KeyValueStore) {
    this.#kv = kv;
  }

  get(providerId: string): EndpointProbeResult | undefined {
    const v = this.#kv.get(ENDPOINT_PROBE_SETTING_PREFIX + providerId);
    if (!isObject(v) || typeof v.state !== "string" || !Array.isArray(v.models)) return undefined;
    return structuredClone(v) as unknown as EndpointProbeResult;
  }

  set(providerId: string, result: EndpointProbeResult): void {
    this.#kv.set(ENDPOINT_PROBE_SETTING_PREFIX + providerId, structuredClone(result));
  }
}
