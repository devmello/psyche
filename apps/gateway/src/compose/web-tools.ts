import { safeFetch } from "@psyche/connectors";
import { getSetting, type PsycheDb, setSetting } from "@psyche/db";
import type { EventName, EventPayload, ResolvedSecret, ToolRegistration } from "@psyche/protocol";
import {
  createWebTools,
  type FetchFn,
  parsePreference,
  parseSearxngUrl,
  providerFor,
  RateLimiter,
  WEB_SEARCH_PROVIDER_SETTING,
  WEB_SEARCH_SEARXNG_SETTING,
  WEB_SEARCH_STATUS_SETTING,
  type WebSearchStatus,
  type WebToolsOptions,
  webSearchStatus,
} from "@psyche/search";
import type { SecretRedactor, Vault } from "@psyche/vault";
import type { Logger } from "../log.ts";
import { BRAVE_OWNER, braveEnvSecret, braveVaultSecret } from "./api-keys.ts";

/**
 * The built-in `web.search` / `web.fetch` tools (issue #557), always registered so the agent can
 * look things up on any surface (web client, channels) without the desktop browser.
 *
 * Provider (settings `search.web.provider`, default `auto`): a Brave Search key from
 * `PSYCHE_SEARCH_BRAVE_KEY`, else the SearXNG instance at `search.web.searxngUrl`, else the
 * keyless DuckDuckGo HTML endpoint behind a conservative rate limit. The Gateway writes what is
 * in effect to the read-only `search.web.status` setting for Settings → Model & providers.
 */

export const BRAVE_KEY_ENV = "PSYCHE_SEARCH_BRAVE_KEY";

export interface WebToolsSetup {
  /** Provider transport (tests replay fixtures through it). Default: global `fetch`. */
  fetch?: FetchFn;
  /** `safeFetch` seams for `web.fetch` (tests). */
  fetchOptions?: WebToolsOptions["fetchOptions"];
  /** Keyless rate limit (tests pass one without waits). */
  limiter?: RateLimiter;
}

export interface ComposedWebTools {
  readonly tools: ToolRegistration[];
  /** Current provider state (also published as `search.web.status`). */
  status(): WebSearchStatus;
  /** Re-read the settings and republish the status when it changed. */
  refresh(): void;
  /** In-process search for deep research (same provider and limits as `web.search`). */
  search(
    query: string,
    count: number,
    signal: AbortSignal,
  ): Promise<{ title: string; url: string; snippet: string }[]>;
  /** In-process page read for deep research (same SSRF policy as `web.fetch`). */
  readPage(url: string, signal: AbortSignal): Promise<{ title?: string; text: string }>;
}

export function composeWebTools(
  deps: {
    db: PsycheDb;
    env: Readonly<Record<string, string | undefined>>;
    publish: <E extends EventName>(event: E, payload: EventPayload<E>) => void;
    redactor?: SecretRedactor;
    /** The vault: a Brave key set in Settings is read from it when the variable is unset. */
    vault?: () => Vault | undefined;
    logger?: Logger;
  },
  setup: WebToolsSetup = {},
): ComposedWebTools {
  const braveEnvKey = deps.env[BRAVE_KEY_ENV]?.trim() ?? "";
  // The key is masked wherever the Gateway logs; it only ever leaves in Brave's request header.
  // An environment key wins; otherwise the vault's (read per request, never kept here).
  if (braveEnvKey !== "") deps.redactor?.add(braveEnvKey, { sticky: true });
  const braveSource = (): "env" | "vault" | undefined =>
    braveEnvKey !== ""
      ? "env"
      : deps.vault?.()?.connectorItem(BRAVE_OWNER) !== undefined
        ? "vault"
        : undefined;
  const braveSecret = async (): Promise<ResolvedSecret> =>
    braveSource() === "vault" && deps.vault !== undefined
      ? braveVaultSecret(deps.vault)
      : braveEnvSecret(braveEnvKey, BRAVE_KEY_ENV);
  const fetchFn: FetchFn = setup.fetch ?? ((input, init) => fetch(input, init));
  const limiter = setup.limiter ?? new RateLimiter();

  const status = (): WebSearchStatus => {
    const searxngUrl = parseSearxngUrl(getSetting(deps.db, WEB_SEARCH_SEARXNG_SETTING)?.value);
    const preference = parsePreference(getSetting(deps.db, WEB_SEARCH_PROVIDER_SETTING)?.value);
    const source = braveSource();
    // Automatic mode never makes a search fail on a key it cannot read without an unlock (an
    // agent must not raise that prompt): a Brave key in a locked vault is unavailable and the
    // next provider is used. When the owner chose Brave, the "locked vault" error stays.
    const unavailable =
      source === "vault" && preference === "auto" && deps.vault?.()?.locked === true;
    return webSearchStatus({
      preference,
      ...(source === undefined || unavailable ? {} : { braveKey: source }),
      ...(searxngUrl === undefined ? {} : { searxngUrl }),
    });
  };

  let published = "";
  const refresh = () => {
    const s = status();
    const json = JSON.stringify(s);
    if (json === published) return;
    published = json;
    if (JSON.stringify(getSetting(deps.db, WEB_SEARCH_STATUS_SETTING)?.value ?? null) === json)
      return;
    const entry = setSetting(deps.db, WEB_SEARCH_STATUS_SETTING, s);
    deps.publish("settings.changed", { entries: [entry] });
  };

  const tools = createWebTools({
    provider: () => {
      const s = status();
      return providerFor(s, {
        fetch: fetchFn,
        braveKey: braveSecret,
        limiter,
      });
    },
    offReason: () => "web search is turned off in Settings → Model & providers → Web search",
    ...(setup.fetchOptions === undefined ? {} : { fetchOptions: setup.fetchOptions }),
  });

  const search: ComposedWebTools["search"] = async (query, count, signal) => {
    const provider = providerFor(status(), {
      fetch: fetchFn,
      braveKey: braveSecret,
      limiter,
    });
    if (provider === undefined) throw new Error("web search is turned off in Settings");
    return provider.search(query, { count, signal });
  };
  const readPage: ComposedWebTools["readPage"] = async (url, signal) => {
    const origin = new URL(url).origin;
    const page = await safeFetch(url, {
      ...setup.fetchOptions,
      signal,
      maxChars: 40_000,
      maxRedirects: 5,
      allowHop: (next) => next.origin === origin,
    });
    if (page.status >= 400) throw new Error(`HTTP ${page.status}`);
    return { ...(page.title === undefined ? {} : { title: page.title }), text: page.markdown };
  };

  return { tools, status, refresh, search, readPage };
}
