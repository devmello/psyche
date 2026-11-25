import type { Usage } from "@psyche/protocol";
import { NIGHT_TOKEN_CEILING } from "./settings.ts";

/**
 * A night's spend (docs/design/night-shift-2026.md §4.4), metered by Night shift itself from the
 * jobs' usage events (`Usage.costUsd` is already priced by the model-router tables). `UsageLedger`
 * is not wired in the Gateway, so nothing here relies on it. The token ceiling also binds local or
 * unpriced models, whose dollars are 0.
 */

/** Per-job limits: 8 steps, 30k tokens, 120 s (§4.1). */
export const NIGHT_JOB_BUDGET = { maxSteps: 8, maxTokens: 30_000, maxWallMs: 120_000 } as const;

/** What one job may cost at worst until a real one has been seen tonight. */
export const DEFAULT_JOB_WORST_USD = 0.03;

export interface BudgetState {
  spentUsd: number;
  tokens: number;
}

export class NightBudget {
  readonly capUsd: number;
  readonly tokenCeiling: number;
  #spent: number;
  #tokens: number;
  #worstJob: number;
  /** Per task: what it has used so far, so a job's own cost is known when it ends. */
  readonly #byTask = new Map<string, { usd: number; tokens: number }>();
  /** The last running total seen per run: loop usage events are cumulative, not per step. */
  readonly #lastTotal = new Map<string, { tokens: number; usd: number }>();

  constructor(
    capUsd: number,
    start: BudgetState = { spentUsd: 0, tokens: 0 },
    tokenCeiling = NIGHT_TOKEN_CEILING,
  ) {
    this.capUsd = capUsd;
    this.tokenCeiling = tokenCeiling;
    this.#spent = start.spentUsd;
    this.#tokens = start.tokens;
    this.#worstJob = DEFAULT_JOB_WORST_USD;
  }

  get state(): BudgetState {
    return { spentUsd: round(this.#spent), tokens: this.#tokens };
  }

  /**
   * A usage event of a job's run. The event carries the run's running total, so only the growth
   * since the run's last event is counted; a total that went down is a new count (a fresh run).
   */
  add(taskId: string, usage: Pick<Usage, "input" | "output" | "costUsd">, runKey = taskId): void {
    const totalTokens = usage.input + usage.output;
    const totalUsd = Number.isFinite(usage.costUsd) ? usage.costUsd : 0;
    const last = this.#lastTotal.get(runKey) ?? { tokens: 0, usd: 0 };
    const tokens = totalTokens >= last.tokens ? totalTokens - last.tokens : totalTokens;
    const usd = totalUsd >= last.usd ? totalUsd - last.usd : totalUsd;
    this.#lastTotal.set(runKey, { tokens: totalTokens, usd: totalUsd });
    this.#spent += usd;
    this.#tokens += tokens;
    const t = this.#byTask.get(taskId) ?? { usd: 0, tokens: 0 };
    t.usd += usd;
    t.tokens += tokens;
    this.#byTask.set(taskId, t);
  }

  /** A job ended: the dearest job so far sets the worst case for the next one. */
  finish(taskId: string): void {
    const t = this.#byTask.get(taskId);
    if (t !== undefined) this.#worstJob = Math.max(this.#worstJob, t.usd);
    this.#byTask.delete(taskId);
  }

  /** No new job starts when what is left is below one job's worst case, or tokens are used up. */
  canStartJob(): { ok: true } | { ok: false; reason: "budget" | "tokens" } {
    if (this.capUsd - this.#spent < this.#worstJob) return { ok: false, reason: "budget" };
    if (this.tokenCeiling - this.#tokens < NIGHT_JOB_BUDGET.maxTokens) {
      return { ok: false, reason: "tokens" };
    }
    return { ok: true };
  }
}

const round = (n: number): number => Math.round(n * 1e6) / 1e6;
