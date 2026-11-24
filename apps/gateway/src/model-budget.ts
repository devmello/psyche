import { PsycheError } from "@psyche/protocol";
import { RateLimiter } from "./rate-limit.ts";

/**
 * The per-device budget for methods that call a model (`callsModel` in `packages/protocol`), so
 * a paired phone or a remote client cannot spend the owner's tokens in a loop. These are the
 * only numbers: there is no setting for them, so a device cannot raise its own budget.
 *
 * - A burst of 20 calls in any 60 seconds, so a person typing, retrying and tapping never
 *   notices it.
 * - 240 calls in any hour (real phone chat reaches 60 to 120), so a loop is held to about four calls a minute. A refusal is
 *   never longer than the window that is full (a minute for the burst, an hour at the most for
 *   the hourly cap), and nothing is locked: the first call that finds room goes through.
 */
export const MODEL_BUDGET = {
  burst: { calls: 20, windowMs: 60_000 },
  hourly: { calls: 240, windowMs: 3_600_000 },
} as const;

export interface ModelBudgetLimits {
  burstCalls: number;
  burstWindowMs: number;
  hourlyCalls: number;
  hourlyWindowMs: number;
}

export const DEFAULT_MODEL_BUDGET_LIMITS: ModelBudgetLimits = {
  burstCalls: MODEL_BUDGET.burst.calls,
  burstWindowMs: MODEL_BUDGET.burst.windowMs,
  hourlyCalls: MODEL_BUDGET.hourly.calls,
  hourlyWindowMs: MODEL_BUDGET.hourly.windowMs,
};

/** Sliding windows per device id, in memory (a restart gives a fresh budget, like the others). */
export class ModelBudget {
  readonly #burst: RateLimiter;
  readonly #hourly: RateLimiter;
  readonly #burstWindowMs: number;
  readonly #hourlyWindowMs: number;
  #admissions = 0;

  constructor(limits: ModelBudgetLimits, now: () => number) {
    this.#burst = new RateLimiter(limits.burstCalls, limits.burstWindowMs, now);
    this.#hourly = new RateLimiter(limits.hourlyCalls, limits.hourlyWindowMs, now);
    this.#burstWindowMs = limits.burstWindowMs;
    this.#hourlyWindowMs = limits.hourlyWindowMs;
  }

  /**
   * Counts one model-calling request from `deviceId`, or throws `rate_limited` with
   * `details.retryAfterMs` when a window is full. A refused call is not counted, so waiting
   * the advertised time is enough.
   */
  admit(deviceId: string): void {
    if (++this.#admissions % 1024 === 0) {
      this.#burst.sweep();
      this.#hourly.sweep();
    }
    const burstFull = !this.#burst.allowed(deviceId);
    const hourlyFull = !this.#hourly.allowed(deviceId);
    if (burstFull || hourlyFull) {
      const retryAfterSec = Math.max(
        burstFull ? this.#burst.retryAfterSec(deviceId) : 0,
        hourlyFull ? this.#hourly.retryAfterSec(deviceId) : 0,
        1,
      );
      const minutes = Math.max(1, Math.ceil(retryAfterSec / 60));
      throw new PsycheError(
        "rate_limited",
        `Too many requests from this device. Try again in ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`,
        {
          retryable: true,
          details: {
            scope: "model_calls",
            // The catalogue sentence clients show (`errors.reason.model_budget`).
            reason: "model_budget",
            windowMs: hourlyFull ? this.#hourlyWindowMs : this.#burstWindowMs,
            retryAfterSec,
            retryAfterMs: retryAfterSec * 1000,
          },
        },
      );
    }
    this.#burst.record(deviceId);
    this.#hourly.record(deviceId);
  }
}
