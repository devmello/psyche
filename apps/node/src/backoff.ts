/**
 * Reconnection delays: exponential with full jitter, capped. `reset()` after a connection that
 * stayed up long enough, so a flapping Gateway does not pin the node at the cap.
 */
export interface BackoffOptions {
  initialMs?: number;
  maxMs?: number;
  factor?: number;
  random?: () => number;
}

export class Backoff {
  readonly #initial: number;
  readonly #max: number;
  readonly #factor: number;
  readonly #random: () => number;
  #attempt = 0;

  constructor(options: BackoffOptions = {}) {
    this.#initial = options.initialMs ?? 500;
    this.#max = options.maxMs ?? 30_000;
    this.#factor = options.factor ?? 2;
    this.#random = options.random ?? Math.random;
  }

  get attempt(): number {
    return this.#attempt;
  }

  next(): number {
    const ceiling = Math.min(this.#max, this.#initial * this.#factor ** this.#attempt);
    this.#attempt++;
    // Full jitter, but never below a tenth of the ceiling so retries never spin.
    return Math.round(ceiling * (0.1 + 0.9 * this.#random()));
  }

  reset(): void {
    this.#attempt = 0;
  }
}
