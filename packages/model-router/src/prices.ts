import type { ModelRef, Usage } from "@psyche/protocol";
import bundled from "./data/prices.json" with { type: "json" };
import { roundUsd } from "./usage.ts";

/** One model's prices in USD per million tokens, plus catalog facts LiteLLM records. */
export interface PriceEntry {
  mode: "chat" | "embedding";
  input: number;
  output: number;
  cacheRead?: number;
  /** 5-minute cache write (Anthropic) or the only write rate. */
  cacheWrite?: number;
  /** 1-hour cache write (Anthropic `ttl: "1h"`). */
  cacheWrite1h?: number;
  /** Rates above a long-context threshold (e.g. Gemini, Claude > 200k input tokens). */
  aboveTokens?: { threshold: number; input?: number; output?: number; cacheRead?: number };
  contextWindow?: number;
  maxOutput?: number;
  toolCalling?: boolean;
  vision?: boolean;
  reasoning?: boolean;
  promptCaching?: boolean;
}

export interface PriceTable {
  source: string;
  generatedAt: string;
  unit: "usd_per_million_tokens";
  models: Record<string, PriceEntry>;
}

export const BUNDLED_PRICES = bundled as PriceTable;

/**
 * Price lookup by `provider/model`. Adapters whose id is not a price-table provider (a second
 * Anthropic account `anthropic-work`, an OpenRouter alias) pass `priceProvider` so the lookup
 * uses the family key; local kinds price at zero.
 */
export class Prices {
  readonly #models: Map<string, PriceEntry>;
  readonly #overrides = new Map<string, PriceEntry>();

  constructor(table: PriceTable = BUNDLED_PRICES) {
    this.#models = new Map(Object.entries(table.models));
  }

  /** User-supplied prices (settings) win over the bundled table. */
  override(ref: ModelRef, entry: PriceEntry): void {
    this.#overrides.set(ref, entry);
  }

  lookup(ref: ModelRef): PriceEntry | undefined {
    const hit = this.#overrides.get(ref) ?? this.#models.get(ref);
    if (hit !== undefined) return hit;
    // Dated snapshots and `:variant` suffixes fall back to the base id.
    const base = ref.replace(/:(?:free|nitro|floor|beta)$/, "").replace(/-\d{8}$/, "");
    return base === ref ? undefined : (this.#overrides.get(base) ?? this.#models.get(base));
  }

  /** Cost of one call. Unknown models cost 0 and the ledger flags them as unpriced. */
  cost(ref: ModelRef, usage: Usage, options: { cacheTtl?: "5m" | "1h" } = {}): number | undefined {
    const p = this.lookup(ref);
    if (p === undefined) return undefined;
    const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
    const long = p.aboveTokens !== undefined && promptTokens > p.aboveTokens.threshold;
    const inRate = (long ? p.aboveTokens?.input : undefined) ?? p.input;
    const outRate = (long ? p.aboveTokens?.output : undefined) ?? p.output;
    const readRate = (long ? p.aboveTokens?.cacheRead : undefined) ?? p.cacheRead ?? inRate;
    const writeRate = (options.cacheTtl === "1h" ? p.cacheWrite1h : undefined) ?? p.cacheWrite ?? inRate;
    const usd =
      (usage.input * inRate +
        usage.cacheRead * readRate +
        usage.cacheWrite * writeRate +
        usage.output * outRate) /
      1_000_000;
    return roundUsd(usd);
  }
}
