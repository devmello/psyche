import type { JsonObject, ModelCapabilities } from "@psyche/protocol";

/** Provider families (feature B1). `*-compatible` kinds take a `baseURL`. */
export const PROVIDER_KINDS = [
  "anthropic",
  "openai",
  "google",
  "openrouter",
  "openai-compatible",
  "anthropic-compatible",
  "ollama",
] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

/**
 * One credential a provider can use. Providers rotate through profiles in order before the
 * router falls back to another model (architecture §4.4). Keys live only in the vault: the
 * profile names a `{{cred:slug}}` placeholder and the id of the standing `credential_fill`
 * grant (scope `site`, bound to the provider origin) created when the owner entered the key in
 * Settings → Model & providers (B6).
 */
export interface AuthProfile {
  id: string;
  /** `{{cred:<slug>}}` or `{{cred:<slug>.token}}`. Absent for keyless local servers. */
  credential?: string;
  approvalId?: string;
}

export interface ProviderTimeouts {
  /** Time allowed until the first stream part (model load on local servers counts). */
  firstEventMs?: number;
  /** Longest gap between stream parts. */
  idleMs?: number;
}

export interface ProviderConfig {
  /** Ref prefix: `anthropic`, `ollama`, `lmstudio`, `anthropic-work`, … */
  id: string;
  kind: ProviderKind;
  /** Required for `openai-compatible` and `anthropic-compatible`; optional elsewhere. */
  baseURL?: string;
  profiles?: AuthProfile[];
  /** Non-secret extra headers. Never put keys here; use a profile. */
  headers?: Record<string, string>;
  /** Defaults merged under the request's `providerOptions` for this provider. */
  defaultOptions?: JsonObject;
  /** Anthropic: mark the system prompt and the last message as cache breakpoints (default true). */
  promptCaching?: boolean;
  /** Anthropic: `"5m"` (default) or `"1h"` cache TTL. */
  cacheTtl?: "5m" | "1h";
  /**
   * Anthropic only: replace client tools named `memory` / `computer` with the provider-defined
   * `memory_20250818` / `computer_toolset_20260801` (architecture §4.4). Off by default.
   */
  providerTools?: { memory?: boolean; computer?: boolean };
  /** Per-model capability facts that override the catalog and price table. */
  models?: Record<string, Partial<ModelCapabilities>>;
  /** Embedding model ids this provider serves (for `embed`). */
  embeddingModels?: string[];
  timeouts?: ProviderTimeouts;
  /** Price-table provider to use for refs of this provider (default: the kind's family). */
  priceProvider?: string;
}

/** Kinds that run on the owner's machine: zero cost, longer timeouts, no keys required. */
export function isLocalKind(kind: ProviderKind): boolean {
  return kind === "ollama" || kind === "openai-compatible" || kind === "anthropic-compatible";
}

/** The key the provider package reads `providerOptions` and writes `providerMetadata` under. */
export function packageKey(config: ProviderConfig): string {
  switch (config.kind) {
    case "anthropic":
    case "anthropic-compatible":
      return "anthropic";
    case "openai":
      return "openai";
    case "google":
      return "google";
    case "openrouter":
      return "openrouter";
    case "ollama":
      return "ollama";
    case "openai-compatible":
      return config.id;
  }
}

/** The price-table provider for this config, or undefined for local kinds (cost 0). */
export function priceProviderOf(config: ProviderConfig): string | undefined {
  if (config.priceProvider !== undefined) return config.priceProvider;
  switch (config.kind) {
    case "anthropic":
    case "openai":
    case "google":
    case "openrouter":
      return config.kind;
    default:
      return undefined;
  }
}

export const DEFAULT_TIMEOUTS: Required<ProviderTimeouts> = {
  firstEventMs: 60_000,
  idleMs: 120_000,
};
export const LOCAL_TIMEOUTS: Required<ProviderTimeouts> = {
  firstEventMs: 300_000,
  idleMs: 300_000,
};

export function timeoutsOf(config: ProviderConfig): Required<ProviderTimeouts> {
  const base = isLocalKind(config.kind) ? LOCAL_TIMEOUTS : DEFAULT_TIMEOUTS;
  return { ...base, ...config.timeouts };
}
