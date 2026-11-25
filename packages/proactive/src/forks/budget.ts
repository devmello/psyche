import type { Usage } from "@psyche/protocol";
import { round, UsageMeter } from "../staged/meter.ts";

/**
 * A fork's spend (docs/design/fork-a-plan-2026.md §6). Metered by Fork a plan itself from the
 * branches' usage events through the meter Night shift shares (`staged/meter.ts`):
 *
 * - 10% of the budget is the reserve, for the comparison pass and forced reports;
 * - the rest is split evenly across the branches;
 * - a branch that reaches its share is stopped, and a branch that ended without a report gets one
 *   forced `fork_report` from the reserve, while the reserve lasts;
 * - a 400k-token ceiling binds unpriced and local models, whose dollars are 0.
 */

export const FORK_RESERVE_FRACTION = 0.1;
export const FORK_TOKEN_CEILING = 400_000;
/** Per branch task: 16 steps, 120k tokens, 240 s (§6), lowered when the money share is smaller. */
export const FORK_BRANCH_CAPS = { maxSteps: 16, maxTokens: 120_000, maxWallMs: 240_000 } as const;
/** The forced report: one or two calls over what the branch already found. */
export const FORCED_REPORT_CAPS = { maxSteps: 3, maxTokens: 20_000, maxWallMs: 60_000 } as const;
/**
 * What one forced report may write, and what one step of a branch may write. Each is both what
 * the pre-call check reserves and the output limit the request is sent with, so the estimate is
 * an upper bound.
 */
export const FORCED_REPORT_OUTPUT_TOKENS = 2_500;
export const MAIN_STEP_OUTPUT_TOKENS = 4_096;
/** The smallest token cap a branch is lowered to: below it a branch could not read anything. */
export const MIN_BRANCH_TOKENS = 8_000;

export interface TaskCaps {
  maxSteps: number;
  maxTokens: number;
  maxWallMs: number;
}

export interface BudgetSplit {
  budgetUsd: number;
  reserveUsd: number;
  /** What one branch may spend. */
  branchShareUsd: number;
  /**
   * What one forced report may spend: one slot of the reserve per branch. The comparison pass uses
   * what the forced reports leave (the fallback comparison needs no model).
   */
  forcedReportUsd: number;
}

/** The split of a fork's budget (§6). */
export function splitBudget(budgetUsd: number, branches: number): BudgetSplit {
  const n = Math.max(1, branches);
  const reserveUsd = round(budgetUsd * FORK_RESERVE_FRACTION);
  return {
    budgetUsd,
    reserveUsd,
    branchShareUsd: round((budgetUsd - reserveUsd) / n),
    forcedReportUsd: round(reserveUsd / n),
  };
}

/**
 * A branch's task caps: the standing 16 steps, 120k tokens and 240 s, with the token cap lowered
 * to what the money share buys when the model's price per token is known, and to the branch's
 * share of the token ceiling.
 */
export function branchCaps(
  split: BudgetSplit,
  branches: number,
  opts: { usdPerToken?: number; tokenCeiling?: number } = {},
): TaskCaps {
  const ceiling = opts.tokenCeiling ?? FORK_TOKEN_CEILING;
  let maxTokens: number = FORK_BRANCH_CAPS.maxTokens;
  const tokenShare = Math.floor((ceiling * (1 - FORK_RESERVE_FRACTION)) / Math.max(1, branches));
  maxTokens = Math.min(maxTokens, tokenShare);
  const price = opts.usdPerToken;
  if (price !== undefined && Number.isFinite(price) && price > 0) {
    maxTokens = Math.min(maxTokens, Math.floor(split.branchShareUsd / price));
  }
  return {
    maxSteps: FORK_BRANCH_CAPS.maxSteps,
    maxTokens: Math.max(MIN_BRANCH_TOKENS, maxTokens),
    maxWallMs: FORK_BRANCH_CAPS.maxWallMs,
  };
}

export interface ForkBudgetState {
  spentUsd: number;
  tokens: number;
}

export type Lane = "branch" | "forced";

const laneKey = (lane: Lane, branchId: string): string => `${lane}:${branchId}`;

export class ForkBudget {
  readonly split: BudgetSplit;
  readonly tokenCeiling: number;
  readonly branches: number;
  readonly #meter: UsageMeter;
  #reserveUsd = 0;
  #reserveTokens = 0;

  constructor(
    budgetUsd: number,
    branches: number,
    opts: { tokenCeiling?: number; start?: ForkBudgetState } = {},
  ) {
    this.split = splitBudget(budgetUsd, branches);
    this.branches = branches;
    this.tokenCeiling = opts.tokenCeiling ?? FORK_TOKEN_CEILING;
    this.#meter = new UsageMeter(opts.start);
  }

  get state(): ForkBudgetState {
    return this.#meter.state;
  }

  /** A usage event of a branch's run (`lane: "branch"`) or of its forced report (`"forced"`). */
  add(
    branchId: string,
    lane: Lane,
    usage: Pick<Usage, "input" | "output" | "costUsd">,
    runKey: string,
  ): { overShare: boolean; overCap: boolean } {
    const grown = this.#meter.add(laneKey(lane, branchId), usage, runKey);
    if (lane === "forced") {
      this.#reserveUsd += grown.usd;
      this.#reserveTokens += grown.tokens;
    }
    return { overShare: this.overShare(branchId, lane), overCap: this.overCap() };
  }

  /** What a branch's main run has used. */
  branchUsed(branchId: string): { usd: number; tokens: number } {
    return this.#meter.used(laneKey("branch", branchId));
  }

  /** What a branch's forced report has used. */
  forcedUsed(branchId: string): { usd: number; tokens: number } {
    return this.#meter.used(laneKey("forced", branchId));
  }

  /** The branch has used its money share, its token share or the whole fork is at the cap. */
  overShare(branchId: string, lane: Lane = "branch"): boolean {
    if (lane === "forced") {
      const used = this.forcedUsed(branchId);
      return used.usd >= this.split.forcedReportUsd || used.tokens >= FORCED_REPORT_CAPS.maxTokens;
    }
    const used = this.branchUsed(branchId);
    const tokenShare = (this.tokenCeiling * (1 - FORK_RESERVE_FRACTION)) / this.branches;
    return used.usd >= this.split.branchShareUsd || used.tokens >= tokenShare;
  }

  /** A branch's share of the token ceiling. */
  tokenShare(): number {
    return (this.tokenCeiling * (1 - FORK_RESERVE_FRACTION)) / this.branches;
  }

  /** The fork's total is at its budget or token ceiling: nothing more may run. */
  overCap(): boolean {
    const s = this.#meter.state;
    return s.spentUsd >= this.split.budgetUsd || s.tokens >= this.tokenCeiling;
  }

  /**
   * Whether one more forced report fits in the reserve: the reserve is not spent and a whole
   * forced report's money and tokens fit under the fork's cap.
   */
  canForceReport(): boolean {
    if (this.#reserveUsd + this.split.forcedReportUsd > this.split.reserveUsd + 1e-9) return false;
    const s = this.#meter.state;
    if (s.spentUsd >= this.split.budgetUsd) return false;
    return s.tokens + FORCED_REPORT_CAPS.maxTokens <= this.tokenCeiling;
  }

  /** The reserve left for the comparison pass. */
  reserveLeftUsd(): number {
    return round(Math.max(0, this.split.reserveUsd - this.#reserveUsd));
  }
}
