import {
  type CredentialBroker,
  PLACEHOLDER_PATTERN,
  PsycheError,
  type ResolvedSecret,
} from "@psyche/protocol";
import type { FetchFn } from "../framework/types.ts";
import type { DnsLookup } from "./fetch.ts";
import { isAllowlisted, vetUrl } from "./fetch.ts";

/**
 * Web search providers (feature M8): Brave, Exa, Tavily (API key from the vault) and SearXNG
 * (self-hosted, no key). The key is a `{{cred:slug}}` placeholder resolved through the Credential
 * Broker for the provider's API origin only, placed in one request header, and never copied into
 * results or errors. Titles and snippets are third-party text: data, never instructions.
 */

export type SearchProviderId = "brave" | "exa" | "tavily" | "searxng";
export const SEARCH_PROVIDER_IDS: readonly SearchProviderId[] = [
  "brave",
  "exa",
  "tavily",
  "searxng",
];

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
  /** ISO date or date-time when the provider reports one. */
  publishedAt?: string;
  /** Provider that returned the hit. */
  source: SearchProviderId;
}

export interface SearchOptions {
  count: number;
  signal?: AbortSignal;
}

export interface SearchProvider {
  id: SearchProviderId;
  /** Origin API calls go to (the credential binding target). */
  origin: string;
  search(query: string, options: SearchOptions): Promise<SearchHit[]>;
}

export interface ApproveKeyRequest {
  provider: SearchProviderId;
  /** The placeholder being resolved, e.g. `{{cred:brave-search}}`. */
  placeholder: string;
  origin: string;
}

/** Returns the id of an approved `credential_fill` for this provider key. */
export type ApproveKey = (request: ApproveKeyRequest) => Promise<string>;

export interface KeyedProviderOptions {
  fetch: FetchFn;
  credentials: CredentialBroker;
  /** `{{cred:slug}}` placeholder of the API key. */
  apiKey: string;
  approveKey: ApproveKey;
}

export interface SearxngProviderOptions {
  fetch: FetchFn;
  /** Instance base URL, e.g. `http://127.0.0.1:8888`. */
  baseUrl: string;
  /** Exact `host:port` pairs admitted although private (owner-configured). */
  privateAllowlist?: readonly string[];
  lookup?: DnsLookup;
}

export const MAX_RESULTS = 20;
const MAX_TITLE = 300;
const MAX_SNIPPET = 1_000;

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** Plain text from provider markup (Brave wraps matches in <strong>), whitespace-collapsed. */
export function plainText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  const text = value
    .replace(/<[^>]*>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (/^#x/i.test(e)) return String.fromCodePoint(Number.parseInt(e.slice(2), 16) || 0xfffd);
      if (e.startsWith("#")) return String.fromCodePoint(Number.parseInt(e.slice(1), 10) || 0xfffd);
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function httpUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const u = new URL(value);
    if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
    if (u.username !== "" || u.password !== "") return undefined;
    return u.toString();
  } catch {
    return undefined;
  }
}

function isoDate(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  // A zone-less ISO date-time would parse as local time; providers mean UTC.
  const text = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(value.trim())
    ? `${value.trim()}Z`
    : value;
  const t = Date.parse(text);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function hit(
  source: SearchProviderId,
  raw: { title: unknown; url: unknown; snippet: unknown; publishedAt?: unknown },
): SearchHit | undefined {
  const url = httpUrl(raw.url);
  if (url === undefined) return undefined;
  const out: SearchHit = {
    title: plainText(raw.title, MAX_TITLE) || url,
    url,
    snippet: plainText(raw.snippet, MAX_SNIPPET),
    source,
  };
  const publishedAt = isoDate(raw.publishedAt);
  if (publishedAt !== undefined) out.publishedAt = publishedAt;
  return out;
}

function clampCount(count: number): number {
  if (!Number.isFinite(count)) return 10;
  return Math.min(MAX_RESULTS, Math.max(1, Math.trunc(count)));
}

function checkQuery(query: string): string {
  const q = typeof query === "string" ? query.trim() : "";
  if (q === "" || q.length > 1_000) {
    throw new PsycheError("invalid_params", "query must be 1 to 1000 characters");
  }
  return q;
}

/** Call the provider; errors carry the status only, never request headers or response bodies. */
async function callApi(
  provider: SearchProviderId,
  fetchFn: FetchFn,
  url: string,
  init: RequestInit,
): Promise<unknown> {
  let res: Response;
  try {
    // Never follow a redirect: provider keys ride in custom headers that fetch would forward.
    res = await fetchFn(url, { ...init, redirect: "error" });
  } catch (err) {
    if (init.signal?.aborted === true) {
      throw new PsycheError("cancelled", `${provider} search was cancelled`);
    }
    const timeout = err instanceof Error && err.name === "TimeoutError";
    throw new PsycheError(
      timeout ? "timeout" : "unavailable",
      `${provider} search request failed`,
      {
        retryable: true,
      },
    );
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    const details = { provider, status: res.status };
    if (res.status === 401 || res.status === 403) {
      throw new PsycheError("unauthorized", `${provider} rejected the request (${res.status})`, {
        details,
      });
    }
    if (res.status === 429) {
      throw new PsycheError("rate_limited", `${provider} rate limit reached`, {
        details,
        retryable: true,
      });
    }
    throw new PsycheError("unavailable", `${provider} returned HTTP ${res.status}`, {
      details,
      retryable: res.status >= 500,
    });
  }
  try {
    return await res.json();
  } catch {
    throw new PsycheError("unavailable", `${provider} returned a malformed response`, {
      details: { provider },
    });
  }
}

/** Throws unless `value` is exactly one `{{cred:slug}}` placeholder. */
export function assertPlaceholder(value: unknown, what = "apiKey"): string {
  if (typeof value !== "string" || !new RegExp(`^${PLACEHOLDER_PATTERN.source}$`).test(value)) {
    throw new PsycheError("invalid_params", `${what} must be a {{cred:slug}} vault placeholder`);
  }
  return value;
}

async function resolveKey(
  provider: SearchProviderId,
  origin: string,
  opts: KeyedProviderOptions,
  signal: AbortSignal | undefined,
): Promise<ResolvedSecret> {
  const placeholder = assertPlaceholder(opts.apiKey);
  const approvalId = await opts.approveKey({ provider, placeholder, origin });
  return opts.credentials.resolve(placeholder, { kind: "origin", value: origin }, approvalId, {
    executor: "connector",
    ...(signal === undefined ? {} : { signal }),
  });
}

/** Run `fn` with the header set built from the key; the key never leaves this frame. */
async function withKeyHeader<T>(
  secret: ResolvedSecret,
  name: string,
  format: (key: string) => string,
  fn: (headers: Record<string, string>) => Promise<T>,
): Promise<T> {
  const headers: Record<string, string> = {};
  secret.use((key) => {
    headers[name] = format(key);
  });
  try {
    return await fn(headers);
  } finally {
    delete headers[name];
    secret.dispose();
  }
}

// Brave Web Search API: GET https://api.search.brave.com/res/v1/web/search?q=&count= with header
// X-Subscription-Token; results in `web.results[]` {title, url, description, page_age}; count <= 20.
// Docs: https://api-dashboard.search.brave.com/app/documentation/web-search/get-started
export function braveProvider(opts: KeyedProviderOptions): SearchProvider {
  const origin = "https://api.search.brave.com";
  return {
    id: "brave",
    origin,
    async search(query, options) {
      const q = checkQuery(query);
      const url = new URL("/res/v1/web/search", origin);
      url.searchParams.set("q", q);
      url.searchParams.set("count", String(clampCount(options.count)));
      const secret = await resolveKey("brave", origin, opts, options.signal);
      const data = await withKeyHeader(
        secret,
        "x-subscription-token",
        (k) => k,
        (auth) =>
          callApi("brave", opts.fetch, url.toString(), {
            method: "GET",
            headers: { accept: "application/json", ...auth },
            ...(options.signal === undefined ? {} : { signal: options.signal }),
          }),
      );
      return asArray(asRecord(asRecord(data).web).results)
        .map((r) => {
          const x = asRecord(r);
          return hit("brave", {
            title: x.title,
            url: x.url,
            snippet: x.description,
            publishedAt: x.page_age,
          });
        })
        .filter((h): h is SearchHit => h !== undefined)
        .slice(0, clampCount(options.count));
    },
  };
}

// Exa search API: POST https://api.exa.ai/search, header x-api-key, JSON body
// {query, numResults, contents: {highlights}}; results[] {title, url, publishedDate, highlights[],
// summary, text}. Docs: https://exa.ai/docs/reference/search
export function exaProvider(opts: KeyedProviderOptions): SearchProvider {
  const origin = "https://api.exa.ai";
  return {
    id: "exa",
    origin,
    async search(query, options) {
      const q = checkQuery(query);
      const count = clampCount(options.count);
      const secret = await resolveKey("exa", origin, opts, options.signal);
      const data = await withKeyHeader(
        secret,
        "x-api-key",
        (k) => k,
        (auth) =>
          callApi("exa", opts.fetch, `${origin}/search`, {
            method: "POST",
            headers: { accept: "application/json", "content-type": "application/json", ...auth },
            body: JSON.stringify({
              query: q,
              numResults: count,
              contents: { highlights: { maxCharacters: 600 } },
            }),
            ...(options.signal === undefined ? {} : { signal: options.signal }),
          }),
      );
      return asArray(asRecord(data).results)
        .map((r) => {
          const x = asRecord(r);
          const highlights = asArray(x.highlights).filter((h) => typeof h === "string");
          const snippet =
            highlights.length > 0
              ? highlights.join(" … ")
              : typeof x.summary === "string"
                ? x.summary
                : x.text;
          return hit("exa", { title: x.title, url: x.url, snippet, publishedAt: x.publishedDate });
        })
        .filter((h): h is SearchHit => h !== undefined)
        .slice(0, count);
    },
  };
}

// Tavily search API: POST https://api.tavily.com/search, header `Authorization: Bearer <key>`,
// JSON body {query, max_results (0-20), search_depth, include_published_date}; results[]
// {title, url, content, score, published_date}.
// Docs: https://docs.tavily.com/documentation/api-reference/endpoint/search
export function tavilyProvider(opts: KeyedProviderOptions): SearchProvider {
  const origin = "https://api.tavily.com";
  return {
    id: "tavily",
    origin,
    async search(query, options) {
      const q = checkQuery(query);
      const count = clampCount(options.count);
      const secret = await resolveKey("tavily", origin, opts, options.signal);
      const data = await withKeyHeader(
        secret,
        "authorization",
        (k) => `Bearer ${k}`,
        (auth) =>
          callApi("tavily", opts.fetch, `${origin}/search`, {
            method: "POST",
            headers: { accept: "application/json", "content-type": "application/json", ...auth },
            body: JSON.stringify({
              query: q,
              max_results: count,
              search_depth: "basic",
              include_answer: false,
              include_raw_content: false,
              include_published_date: true,
            }),
            ...(options.signal === undefined ? {} : { signal: options.signal }),
          }),
      );
      return asArray(asRecord(data).results)
        .map((r) => {
          const x = asRecord(r);
          return hit("tavily", {
            title: x.title,
            url: x.url,
            snippet: x.content,
            publishedAt: x.published_date,
          });
        })
        .filter((h): h is SearchHit => h !== undefined)
        .slice(0, count);
    },
  };
}

// SearXNG search API: GET <base>/search?q=&format=json&pageno=1 (the json format must be enabled
// under `search.formats` in settings.yml, else 403); results[] {title, url, content,
// publishedDate, engine}. Docs: https://docs.searxng.org/dev/search_api.html
export function searxngProvider(opts: SearxngProviderOptions): SearchProvider {
  const base = parseBaseUrl(opts.baseUrl);
  return {
    id: "searxng",
    origin: base.origin,
    async search(query, options) {
      const q = checkQuery(query);
      const count = clampCount(options.count);
      // Owner-configured, but still vetted: private hosts need an explicit allowlist entry.
      // Known gap (low): this call goes through `opts.fetch`, which resolves DNS again, so the
      // vetted address is not pinned as in `safeFetch`. The base URL comes only from the owner's
      // settings, never from the model; pinning is a follow-up.
      if (!isAllowlisted(base, opts.privateAllowlist)) {
        await vetUrl(base, {
          ...(opts.lookup === undefined ? {} : { lookup: opts.lookup }),
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
      }
      const url = new URL("search", base);
      url.searchParams.set("q", q);
      url.searchParams.set("format", "json");
      url.searchParams.set("pageno", "1");
      const data = await callApi("searxng", opts.fetch, url.toString(), {
        method: "GET",
        headers: { accept: "application/json" },
        redirect: "error",
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      return asArray(asRecord(data).results)
        .map((r) => {
          const x = asRecord(r);
          return hit("searxng", {
            title: x.title,
            url: x.url,
            snippet: x.content,
            publishedAt: x.publishedDate,
          });
        })
        .filter((h): h is SearchHit => h !== undefined)
        .slice(0, count);
    },
  };
}

/** SearXNG base URL: http(s), no credentials, query or fragment; path kept with a trailing slash. */
export function parseBaseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PsycheError("invalid_params", "baseUrl must be an absolute http(s) URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new PsycheError("invalid_params", "baseUrl must be an absolute http(s) URL");
  }
  if (url.username !== "" || url.password !== "") {
    throw new PsycheError("invalid_params", "baseUrl must not embed credentials");
  }
  url.search = "";
  url.hash = "";
  if (!url.pathname.endsWith("/")) url.pathname = `${url.pathname}/`;
  return url;
}
