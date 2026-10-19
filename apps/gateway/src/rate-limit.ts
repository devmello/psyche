/** Sliding-window counter per key (security §10 rate limits). In memory; resets on restart. */
export class RateLimiter {
  readonly #hits = new Map<string, number[]>();
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #now: () => number;

  constructor(limit: number, windowMs: number, now: () => number = Date.now) {
    this.#limit = limit;
    this.#windowMs = windowMs;
    this.#now = now;
  }

  #recent(key: string): number[] {
    const cutoff = this.#now() - this.#windowMs;
    const hits = (this.#hits.get(key) ?? []).filter((t) => t > cutoff);
    if (hits.length === 0) this.#hits.delete(key);
    else this.#hits.set(key, hits);
    return hits;
  }

  /** `true` while `key` is under its limit. */
  allowed(key: string): boolean {
    return this.#recent(key).length < this.#limit;
  }

  record(key: string): void {
    const hits = this.#recent(key);
    hits.push(this.#now());
    this.#hits.set(key, hits);
  }
}
