import { searxngProvider } from "@psyche/connectors";
import type { ResolvedSecret } from "@psyche/protocol";
import {
  braveSearch,
  duckDuckGoSearch,
  type FetchFn,
  type RateLimiter,
  type WebSearchProvider,
  type WebSearchProviderId,
} from "./providers.ts";

/**
 * Which provider `web.search` uses, from the owner's settings and what is configured:
 * `auto` (default) = Brave when a key is set, else SearXNG when a URL is set, else DuckDuckGo.
 * An explicit choice that is not configured falls back the same way and says so in `note`.
 */

export const WEB_SEARCH_PREFERENCES = ["auto", "brave", "searxng", "duckduckgo", "off"] as const;
export type WebSearchPreference = (typeof WEB_SEARCH_PREFERENCES)[number];

/** Settings keys (admin settings; the status key is written by the Gateway, read by Settings). */
export const WEB_SEARCH_PROVIDER_SETTING = "search.web.provider";
export const WEB_SEARCH_SEARXNG_SETTING = "search.web.searxngUrl";
export const WEB_SEARCH_STATUS_SETTING = "search.web.status";

export interface WebSearchConfig {
  preference: WebSearchPreference;
  /** Where the Brave key comes from, when there is one. */
  braveKey?: "env" | "vault";
  searxngUrl?: string;
}

export interface WebSearchStatus {
  preference: WebSearchPreference;
  active: WebSearchProviderId | "off";
  brave: "env" | "vault" | null;
  searxngUrl: string | null;
  note: string | null;
}

export function parsePreference(value: unknown): WebSearchPreference {
  return typeof value === "string" && (WEB_SEARCH_PREFERENCES as readonly string[]).includes(value)
    ? (value as WebSearchPreference)
    : "auto";
}

/** An http(s) base URL, or `undefined` for anything else (blank, junk, other schemes). */
export function parseSearxngUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  try {
    const u = new URL(value.trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
    if (u.username !== "" || u.password !== "") return undefined;
    return u.toString();
  } catch {
    return undefined;
  }
}

export function webSearchStatus(config: WebSearchConfig): WebSearchStatus {
  const brave = config.braveKey ?? null;
  const searxngUrl = config.searxngUrl ?? null;
  const auto = (): WebSearchProviderId =>
    brave !== null ? "brave" : searxngUrl !== null ? "searxng" : "duckduckgo";
  const base = { preference: config.preference, brave, searxngUrl };
  switch (config.preference) {
    case "off":
      return { ...base, active: "off", note: null };
    case "brave":
      return brave !== null
        ? { ...base, active: "brave", note: null }
        : {
            ...base,
            active: auto(),
            note: "No Brave Search key is set (PSYCHE_SEARCH_BRAVE_KEY).",
          };
    case "searxng":
      return searxngUrl !== null
        ? { ...base, active: "searxng", note: null }
        : { ...base, active: auto(), note: "No SearXNG URL is set." };
    case "duckduckgo":
      return { ...base, active: "duckduckgo", note: null };
    default:
      return { ...base, active: auto(), note: null };
  }
}

export interface ProviderDeps {
  fetch: FetchFn;
  /** The Brave key for one request, when one is configured. */
  braveKey: () => Promise<ResolvedSecret>;
  /** Shared across calls so the keyless rate limit holds. */
  limiter: RateLimiter;
}

export function providerFor(
  status: WebSearchStatus,
  deps: ProviderDeps,
): WebSearchProvider | undefined {
  switch (status.active) {
    case "off":
      return undefined;
    case "brave":
      return braveSearch({ fetch: deps.fetch, key: deps.braveKey });
    case "searxng": {
      const base = new URL(status.searxngUrl as string);
      const port = base.port !== "" ? base.port : base.protocol === "https:" ? "443" : "80";
      const p = searxngProvider({
        fetch: deps.fetch,
        baseUrl: base.toString(),
        // The owner's own instance may live on the LAN: that one host:port is admitted.
        privateAllowlist: [`${base.hostname}:${port}`],
      });
      return {
        id: "searxng",
        origin: p.origin,
        async search(query, opts) {
          const hits = await p.search(query, opts);
          return hits.map((h) => ({
            title: h.title,
            url: h.url,
            snippet: h.snippet,
            ...(h.publishedAt === undefined ? {} : { publishedAt: h.publishedAt }),
          }));
        },
      };
    }
    default:
      return duckDuckGoSearch({ fetch: deps.fetch, limiter: deps.limiter });
  }
}
