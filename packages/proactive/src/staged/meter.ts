import type { Usage } from "@psyche/protocol";

/**
 * The spend meter Night shift and Fork a plan share (fork-a-plan-2026 §10, night-shift-2026 §4.4).
 * A loop usage event carries the run's running total, not a step's cost, so only the growth since
 * the run's last event is counted; a total that went down is a new count (a fresh run). `costUsd`
 * is already priced by the model-router tables; a non-finite price counts as 0, and the token
 * ceilings of the two features bind local and unpriced models.
 */

export interface MeterState {
  spentUsd: number;
  tokens: number;
}

export const round = (n: number): number => Math.round(n * 1e6) / 1e6;

export class UsageMeter {
  #spent: number;
  #tokens: number;
  /** The last running total seen per run. */
  readonly #lastTotal = new Map<string, { tokens: number; usd: number }>();
  /** Per key (a task or a branch): what it has used so far. */
  readonly #byKey = new Map<string, { usd: number; tokens: number }>();

  constructor(start: MeterState = { spentUsd: 0, tokens: 0 }) {
    this.#spent = start.spentUsd;
    this.#tokens = start.tokens;
  }

  get state(): MeterState {
    return { spentUsd: round(this.#spent), tokens: this.#tokens };
  }

  /** What one key has used so far. */
  used(key: string): { usd: number; tokens: number } {
    const t = this.#byKey.get(key);
    return t === undefined ? { usd: 0, tokens: 0 } : { usd: round(t.usd), tokens: t.tokens };
  }

  /** Counts the growth of `runKey`'s running total toward `key`. Returns the growth. */
  add(
    key: string,
    usage: Pick<Usage, "input" | "output" | "costUsd">,
    runKey = key,
  ): { usd: number; tokens: number } {
    const totalTokens = usage.input + usage.output;
    const totalUsd = Number.isFinite(usage.costUsd) ? usage.costUsd : 0;
    const last = this.#lastTotal.get(runKey) ?? { tokens: 0, usd: 0 };
    const tokens = totalTokens >= last.tokens ? totalTokens - last.tokens : totalTokens;
    const usd = totalUsd >= last.usd ? totalUsd - last.usd : totalUsd;
    this.#lastTotal.set(runKey, { tokens: totalTokens, usd: totalUsd });
    this.#spent += usd;
    this.#tokens += tokens;
    const t = this.#byKey.get(key) ?? { usd: 0, tokens: 0 };
    t.usd += usd;
    t.tokens += tokens;
    this.#byKey.set(key, t);
    return { usd, tokens };
  }

  /** Forgets one key's own count (the total keeps it) and returns it. */
  release(key: string): { usd: number; tokens: number } | undefined {
    const t = this.#byKey.get(key);
    this.#byKey.delete(key);
    return t;
  }
}
