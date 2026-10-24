import { PsycheError, type ResolvedSecret } from "@psyche/protocol";

/**
 * Web search providers for the built-in `web.search` tool (issue #557). In order of preference:
 * a Brave Search API key, an owner-configured SearXNG instance, else DuckDuckGo's HTML endpoint
 * (no key) behind a conservative rate limit. Every result is third-party text (`untrusted`).
 */

export type WebSearchProviderId = "brave" | "searxng" | "duckduckgo";

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  /** ISO date when the provider reports one. */
  publishedAt?: string;
}

export interface WebSearchProvider {
  readonly id: WebSearchProviderId;
  /** The origin every request goes to (the approval card and the audit show it). */
  readonly origin: string;
  search(query: string, opts: { count: number; signal?: AbortSignal }): Promise<WebSearchResult[]>;
}

export type FetchFn = (input: string | URL, init?: RequestInit) => Promise<Response>;

export const MAX_RESULTS = 20;
const MAX_QUERY = 1_000;
const TIMEOUT_MS = 15_000;
/** Honest user agent; no cookies are ever sent or kept. */
export const USER_AGENT =
  "Mozilla/5.0 (compatible; Psyche/1.0; +https://github.com/devmello/psyche)";

export function checkQuery(query: string): string {
  const q = query.replace(/\s+/g, " ").trim();
  if (q.length === 0) throw new PsycheError("invalid_params", "the query is empty");
  if (q.length > MAX_QUERY) throw new PsycheError("invalid_params", "the query is too long");
  return q;
}

export function clampCount(count: number | undefined, fallback = 8): number {
  if (count === undefined || !Number.isFinite(count)) return fallback;
  return Math.max(1, Math.min(MAX_RESULTS, Math.trunc(count)));
}

function withTimeout(signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}

async function get(
  fetch: FetchFn,
  provider: string,
  url: URL,
  headers: Record<string, string>,
  signal: AbortSignal | undefined,
): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url.toString(), {
      method: "GET",
      headers: { "user-agent": USER_AGENT, ...headers },
      redirect: "error",
      credentials: "omit",
      signal: withTimeout(signal),
    });
  } catch (err) {
    throw new PsycheError("unavailable", `${provider} could not be reached`, {
      details: { provider, reason: (err as Error).name },
      retryable: true,
    });
  }
  if (res.status === 429) {
    throw new PsycheError("rate_limited", `${provider} is rate limiting searches`, {
      details: { provider },
      retryable: true,
    });
  }
  if (res.status === 401 || res.status === 403) {
    throw new PsycheError("unauthorized", `${provider} refused the request (${res.status})`, {
      details: { provider },
    });
  }
  if (!res.ok) {
    throw new PsycheError("unavailable", `${provider} answered ${res.status}`, {
      details: { provider, status: res.status },
      retryable: res.status >= 500,
    });
  }
  return res;
}

function httpUrl(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}

function result(raw: { title?: unknown; url?: unknown; snippet?: unknown; date?: unknown }) {
  const url = httpUrl(raw.url);
  const title = typeof raw.title === "string" ? stripTags(raw.title).trim() : "";
  if (url === undefined || title.length === 0) return undefined;
  const r: WebSearchResult = {
    title: title.slice(0, 300),
    url,
    snippet: typeof raw.snippet === "string" ? stripTags(raw.snippet).trim().slice(0, 600) : "",
  };
  if (typeof raw.date === "string" && raw.date.length > 0) r.publishedAt = raw.date;
  return r;
}

// --- Brave ---------------------------------------------------------------------------------

export const BRAVE_ORIGIN = "https://api.search.brave.com";

/**
 * Brave Search API. The key is a `ResolvedSecret` handed in per request (from the environment or
 * the vault) and read only inside `use`, so it never sits in a provider object, log or result.
 */
export function braveSearch(opts: {
  fetch: FetchFn;
  key: () => Promise<ResolvedSecret>;
}): WebSearchProvider {
  return {
    id: "brave",
    origin: BRAVE_ORIGIN,
    async search(query, { count, signal }) {
      const url = new URL("/res/v1/web/search", BRAVE_ORIGIN);
      url.searchParams.set("q", checkQuery(query));
      url.searchParams.set("count", String(clampCount(count)));
      const secret = await opts.key();
      const res = await secret.use((key) =>
        get(
          opts.fetch,
          "Brave Search",
          url,
          { accept: "application/json", "x-subscription-token": key },
          signal,
        ),
      );
      const data = (await res.json()) as {
        web?: {
          results?: {
            title?: unknown;
            url?: unknown;
            description?: unknown;
            age?: unknown;
            page_age?: unknown;
          }[];
        };
      };
      return (data.web?.results ?? [])
        .map((r) =>
          result({ title: r.title, url: r.url, snippet: r.description, date: r.page_age }),
        )
        .filter((r): r is WebSearchResult => r !== undefined)
        .slice(0, clampCount(count));
    },
  };
}

// --- DuckDuckGo HTML -----------------------------------------------------------------------

export const DUCKDUCKGO_ORIGIN = "https://html.duckduckgo.com";

/**
 * DuckDuckGo's no-JavaScript HTML results page: no key, so it is the fallback. Ads are skipped,
 * redirect links (`/l/?uddg=`) are unwrapped. When DuckDuckGo answers with its bot check
 * instead of results, the search fails with `rate_limited`: Psyche never solves CAPTCHAs.
 */
export function duckDuckGoSearch(opts: {
  fetch: FetchFn;
  limiter?: RateLimiter;
}): WebSearchProvider {
  return {
    id: "duckduckgo",
    origin: DUCKDUCKGO_ORIGIN,
    async search(query, { count, signal }) {
      const q = checkQuery(query);
      await opts.limiter?.take(signal);
      const url = new URL("/html/", DUCKDUCKGO_ORIGIN);
      url.searchParams.set("q", q);
      const res = await get(opts.fetch, "DuckDuckGo", url, { accept: "text/html" }, signal);
      const html = await res.text();
      if (isBotCheck(html)) {
        opts.limiter?.backoff();
        throw new PsycheError(
          "rate_limited",
          "DuckDuckGo asked for a human check instead of answering; Psyche does not solve those. Try again later, or set a Brave Search key or a SearXNG URL in Settings → Search.",
          { details: { provider: "duckduckgo", reason: "bot_check" }, retryable: true },
        );
      }
      return parseDuckDuckGoHtml(html).slice(0, clampCount(count));
    },
  };
}

export function isBotCheck(html: string): boolean {
  return /anomaly-modal|anomaly\.js|class="challenge-form"|bots use DuckDuckGo too/i.test(html);
}

/** Result blocks of `html.duckduckgo.com/html/` (ads excluded). */
export function parseDuckDuckGoHtml(html: string): WebSearchResult[] {
  const out: WebSearchResult[] = [];
  const starts = [...html.matchAll(/<div[^>]+class="([^"]*\bresult\b[^"]*)"/gi)];
  for (const [i, m] of starts.entries()) {
    const cls = m[1] ?? "";
    const block = html.slice(m.index, starts[i + 1]?.index ?? html.length);
    if (/result--ad|result--sponsored/.test(cls) || /badge--ad/.test(block)) continue;
    const link =
      /<a[^>]+class="[^"]*\bresult__a\b[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
    if (link === null) continue;
    const snippet =
      /<(?:a|div|td)[^>]+class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|td)>/i.exec(
        block,
      );
    const r = result({
      url: unwrapDuckDuckGoLink(decodeEntities(link[1] ?? "")),
      title: decodeEntities(link[2] ?? ""),
      snippet: decodeEntities(snippet?.[1] ?? ""),
    });
    if (r !== undefined && !out.some((x) => x.url === r.url)) out.push(r);
  }
  return out;
}

/** `//duckduckgo.com/l/?uddg=https%3A%2F%2Fnodejs.org%2F&rut=…` → `https://nodejs.org/`. */
export function unwrapDuckDuckGoLink(href: string): string {
  try {
    const u = new URL(href, "https://duckduckgo.com");
    if (/(^|\.)duckduckgo\.com$/.test(u.hostname) && u.pathname === "/l/") {
      return u.searchParams.get("uddg") ?? href;
    }
    return u.toString();
  } catch {
    return href;
  }
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  "#39": "'",
  "#x27": "'",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
    const k = e.toLowerCase();
    if (ENTITIES[k] !== undefined) return ENTITIES[k];
    if (k.startsWith("#x")) return String.fromCodePoint(Number.parseInt(k.slice(2), 16));
    if (k.startsWith("#")) return String.fromCodePoint(Number.parseInt(k.slice(1), 10));
    return m;
  });
}

export function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, "").replace(/\s+/g, " ");
}

// --- Rate limit ----------------------------------------------------------------------------

/**
 * A conservative limiter for keyless DuckDuckGo use: requests at least `minIntervalMs` apart
 * (a caller waits up to `maxWaitMs` for its slot), at most `perWindow` per `windowMs`, and a
 * `backoffMs` pause after a bot check.
 */
export class RateLimiter {
  #stamps: number[] = [];
  #next = 0;
  #blockedUntil = 0;
  readonly #o: {
    minIntervalMs: number;
    perWindow: number;
    windowMs: number;
    maxWaitMs: number;
    backoffMs: number;
    now: () => number;
    sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  };

  constructor(
    opts: Partial<{
      minIntervalMs: number;
      perWindow: number;
      windowMs: number;
      maxWaitMs: number;
      backoffMs: number;
      now: () => number;
      sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
    }> = {},
  ) {
    this.#o = {
      minIntervalMs: opts.minIntervalMs ?? 2_000,
      perWindow: opts.perWindow ?? 20,
      windowMs: opts.windowMs ?? 10 * 60_000,
      maxWaitMs: opts.maxWaitMs ?? 6_000,
      backoffMs: opts.backoffMs ?? 15 * 60_000,
      now: opts.now ?? Date.now,
      sleep:
        opts.sleep ??
        ((ms, signal) =>
          new Promise((resolve, reject) => {
            const t = setTimeout(resolve, ms);
            signal?.addEventListener("abort", () => {
              clearTimeout(t);
              reject(signal.reason);
            });
          })),
    };
  }

  async take(signal?: AbortSignal): Promise<void> {
    const o = this.#o;
    const now = o.now();
    if (now < this.#blockedUntil) {
      throw new PsycheError(
        "rate_limited",
        "web search is paused after a bot check; try again later",
        {
          details: { provider: "duckduckgo", retryAfterMs: this.#blockedUntil - now },
          retryable: true,
        },
      );
    }
    this.#stamps = this.#stamps.filter((t) => t > now - o.windowMs);
    if (this.#stamps.length >= o.perWindow) {
      throw new PsycheError(
        "rate_limited",
        `keyless web search is limited to ${o.perWindow} searches per ${Math.round(o.windowMs / 60_000)} minutes`,
        { details: { provider: "duckduckgo" }, retryable: true },
      );
    }
    const slot = Math.max(now, this.#next);
    const wait = slot - now;
    if (wait > o.maxWaitMs) {
      throw new PsycheError("rate_limited", "too many web searches at once", {
        details: { provider: "duckduckgo", retryAfterMs: wait },
        retryable: true,
      });
    }
    this.#next = slot + o.minIntervalMs;
    this.#stamps.push(slot);
    if (wait > 0) await o.sleep(wait, signal);
  }

  backoff(): void {
    this.#blockedUntil = this.#o.now() + this.#o.backoffMs;
  }
}
