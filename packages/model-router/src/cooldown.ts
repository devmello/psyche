import type { Clock } from "@psyche/protocol";
import type { ModelErrorKind } from "./errors.ts";

export interface CooldownPolicy {
  /** Cooldown after the 1st, 2nd, … consecutive failure (the last value repeats). */
  schedule: number[];
  /** Billing / quota failures disable the profile for this long. */
  billingMs: number;
}

/** OpenClaw's schedule: 30 s, 1 min, then 5 min; billing failures 10 min. */
export const DEFAULT_COOLDOWN: CooldownPolicy = {
  schedule: [30_000, 60_000, 300_000],
  billingMs: 600_000,
};

export interface CooldownState {
  key: string;
  until: number;
  strikes: number;
  lastKind: ModelErrorKind;
}

/**
 * Per-key cooldowns (`provider:<id>` and `profile:<id>:<profile>`). Time comes from the
 * injected clock; a key is cooling while `now < until`. Success clears the strikes.
 */
export class Cooldowns {
  readonly #clock: Clock;
  readonly #policy: CooldownPolicy;
  readonly #state = new Map<string, CooldownState>();

  constructor(clock: Clock, policy: CooldownPolicy = DEFAULT_COOLDOWN) {
    this.#clock = clock;
    this.#policy = policy;
  }

  isCooling(key: string): boolean {
    const s = this.#state.get(key);
    return s !== undefined && this.#clock.now() < s.until;
  }

  /** Expiry of a live cooldown, or undefined. */
  until(key: string): number | undefined {
    const s = this.#state.get(key);
    return s !== undefined && this.#clock.now() < s.until ? s.until : undefined;
  }

  fail(key: string, kind: ModelErrorKind, retryAfterSec?: number): CooldownState {
    const prev = this.#state.get(key);
    const strikes = (prev?.strikes ?? 0) + 1;
    const { schedule, billingMs } = this.#policy;
    let ms =
      kind === "billing" ? billingMs : (schedule[Math.min(strikes, schedule.length) - 1] ?? 0);
    if (retryAfterSec !== undefined) ms = Math.max(ms, retryAfterSec * 1000);
    const state: CooldownState = { key, until: this.#clock.now() + ms, strikes, lastKind: kind };
    this.#state.set(key, state);
    return state;
  }

  succeed(key: string): void {
    this.#state.delete(key);
  }

  /** Live cooldowns, for the provider health panel. */
  snapshot(): CooldownState[] {
    const now = this.#clock.now();
    return [...this.#state.values()].filter((s) => now < s.until).map((s) => ({ ...s }));
  }
}

export const providerKey = (provider: string) => `provider:${provider}`;
export const profileKey = (provider: string, profile: string | undefined) =>
  `profile:${provider}:${profile ?? "default"}`;
