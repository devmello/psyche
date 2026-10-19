import type { Clock } from "@psyche/protocol";

export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

export const realSleep: Sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted === true) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(signal.reason);
      },
      { once: true },
    );
  });

interface Bucket {
  tokens: number;
  at: number;
}

/**
 * Token buckets for outbound sends (feature N1 "per-channel rate limits"): one per channel and
 * one per chat. `take` waits (through the injectable `sleep`) until both have a token, in FIFO
 * order per key.
 */
export class RateLimiter {
  #buckets = new Map<string, Bucket>();
  #queues = new Map<string, Promise<void>>();
  #clock: Clock;
  #sleep: Sleep;

  constructor(options: { clock: Clock; sleep?: Sleep }) {
    this.#clock = options.clock;
    this.#sleep = options.sleep ?? realSleep;
  }

  /** Milliseconds until `key` has a token (0 = available now); consumes it when 0. */
  #tryTake(key: string, ratePerSec: number, burst: number): number {
    const now = this.#clock.now();
    const b = this.#buckets.get(key) ?? { tokens: burst, at: now };
    b.tokens = Math.min(burst, b.tokens + ((now - b.at) / 1000) * ratePerSec);
    b.at = now;
    this.#buckets.set(key, b);
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return 0;
    }
    return Math.ceil(((1 - b.tokens) / ratePerSec) * 1000);
  }

  async take(
    limits: { key: string; ratePerSec: number; burst: number }[],
    signal?: AbortSignal,
  ): Promise<void> {
    limits = limits.map((l) => ({ ...l, burst: Math.max(1, l.burst) }));
    const queueKey = limits.map((l) => l.key).join("|");
    const previous = this.#queues.get(queueKey) ?? Promise.resolve();
    const run = previous.then(async () => {
      for (;;) {
        const waits = limits.map((l) => this.#peek(l.key, l.ratePerSec, l.burst));
        const wait = Math.max(...waits);
        if (wait === 0) {
          for (const l of limits) this.#tryTake(l.key, l.ratePerSec, l.burst);
          return;
        }
        await this.#sleep(wait, signal);
      }
    });
    const settled = run.catch(() => undefined);
    this.#queues.set(queueKey, settled);
    try {
      await run;
    } finally {
      if (this.#queues.get(queueKey) === settled) this.#queues.delete(queueKey);
    }
  }

  #peek(key: string, ratePerSec: number, burst: number): number {
    const now = this.#clock.now();
    const b = this.#buckets.get(key) ?? { tokens: burst, at: now };
    const tokens = Math.min(burst, b.tokens + ((now - b.at) / 1000) * ratePerSec);
    return tokens >= 1 ? 0 : Math.ceil(((1 - tokens) / ratePerSec) * 1000);
  }
}

/** Exponential backoff with full jitter, capped (reconnects, 429 retries). */
export function backoffDelay(
  attempt: number,
  options: { baseMs?: number; maxMs?: number; random?: () => number } = {},
): number {
  const base = options.baseMs ?? 1000;
  const max = options.maxMs ?? 60_000;
  const random = options.random ?? Math.random;
  const ceiling = Math.min(max, base * 2 ** Math.max(0, attempt));
  return Math.round(ceiling / 2 + random() * (ceiling / 2));
}
