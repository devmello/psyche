// Duplicated from apps/desktop/src/lib/backoff.ts for the bootstrap; S11 merges the two shells' client code.
export interface BackoffOptions {
  baseMs?: number;
  maxMs?: number;
  /** 0..1 share of the delay that is randomised ("equal jitter"). */
  jitter?: number;
  random?: () => number;
}

/** Exponential reconnect delay: base * 2^attempt, capped, with partial jitter. `attempt` starts at 0. */
export function backoffDelay(attempt: number, opts: BackoffOptions = {}): number {
  const { baseMs = 500, maxMs = 30_000, jitter = 0.5, random = Math.random } = opts;
  const exp = Math.min(maxMs, baseMs * 2 ** Math.max(0, Math.min(attempt, 30)));
  const fixed = exp * (1 - jitter);
  return Math.round(fixed + exp * jitter * random());
}
