import type { Usage } from "@psyche/protocol";
import { UsageMeter } from "../staged/meter.ts";
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
  /** The shared meter (`staged/meter.ts`): loop usage events are cumulative, not per step. */
  readonly #meter: UsageMeter;
  #worstJob: number;

  constructor(
    capUsd: number,
    start: BudgetState = { spentUsd: 0, tokens: 0 },
    tokenCeiling = NIGHT_TOKEN_CEILING,
  ) {
    this.capUsd = capUsd;
    this.tokenCeiling = tokenCeiling;
    this.#meter = new UsageMeter(start);
    this.#worstJob = DEFAULT_JOB_WORST_USD;
  }

  get state(): BudgetState {
    return this.#meter.state;
  }

  /**
   * A usage event of a job's run. The event carries the run's running total, so only the growth
   * since the run's last event is counted; a total that went down is a new count (a fresh run).
   */
  add(taskId: string, usage: Pick<Usage, "input" | "output" | "costUsd">, runKey = taskId): void {
    this.#meter.add(taskId, usage, runKey);
  }

  /** A job ended: the dearest job so far sets the worst case for the next one. */
  finish(taskId: string): void {
    const t = this.#meter.release(taskId);
    if (t !== undefined) this.#worstJob = Math.max(this.#worstJob, t.usd);
  }

  /** No new job starts when what is left is below one job's worst case, or tokens are used up. */
  canStartJob(): { ok: true } | { ok: false; reason: "budget" | "tokens" } {
    const { spentUsd, tokens } = this.#meter.state;
    if (this.capUsd - spentUsd < this.#worstJob) return { ok: false, reason: "budget" };
    if (this.tokenCeiling - tokens < NIGHT_JOB_BUDGET.maxTokens) {
      return { ok: false, reason: "tokens" };
    }
    return { ok: true };
  }
}
