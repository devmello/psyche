import { getSetting, type PsycheDb, setSetting } from "@psyche/db";
import type { EventName, EventPayload, ToolRegistration } from "@psyche/protocol";
import { ResolvedSecret } from "@psyche/protocol";
import {
  BRAVE_ORIGIN,
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
import type { SecretRedactor } from "@psyche/vault";
import type { Logger } from "../log.ts";

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
}

export function composeWebTools(
  deps: {
    db: PsycheDb;
    env: Readonly<Record<string, string | undefined>>;
    publish: <E extends EventName>(event: E, payload: EventPayload<E>) => void;
    redactor?: SecretRedactor;
    logger?: Logger;
  },
  setup: WebToolsSetup = {},
): ComposedWebTools {
  const braveKey = deps.env[BRAVE_KEY_ENV]?.trim() ?? "";
  // The key is masked wherever the Gateway logs; it only ever leaves in Brave's request header.
  if (braveKey !== "") deps.redactor?.add(braveKey, { sticky: true });
  const fetchFn: FetchFn = setup.fetch ?? ((input, init) => fetch(input, init));
  const limiter = setup.limiter ?? new RateLimiter();

  const status = (): WebSearchStatus => {
    const searxngUrl = parseSearxngUrl(getSetting(deps.db, WEB_SEARCH_SEARXNG_SETTING)?.value);
    return webSearchStatus({
      preference: parsePreference(getSetting(deps.db, WEB_SEARCH_PROVIDER_SETTING)?.value),
      ...(braveKey === "" ? {} : { braveKey: "env" as const }),
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
        braveKey: async () =>
          new ResolvedSecret(braveKey, {
            credentialId: `env:${BRAVE_KEY_ENV}`,
            target: { kind: "origin", value: BRAVE_ORIGIN },
          }),
        limiter,
      });
    },
    offReason: () => "web search is turned off in Settings → Model & providers → Web search",
    ...(setup.fetchOptions === undefined ? {} : { fetchOptions: setup.fetchOptions }),
  });

  return { tools, status, refresh };
}
