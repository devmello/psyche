import { fail } from "./errors.ts";

/** FIFO counting semaphore; waiting can be aborted (`cancelled`). */
export class Semaphore {
  #available: number;
  #waiters: { resolve: () => void; reject: (e: unknown) => void }[] = [];

  constructor(permits: number) {
    this.#available = permits;
  }

  get waiting(): number {
    return this.#waiters.length;
  }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted === true) fail("cancelled", "exec aborted before start");
    if (this.#available > 0) {
      this.#available -= 1;
      return this.#releaser();
    }
    await new Promise<void>((resolve, reject) => {
      const waiter = {
        resolve: () => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        },
        reject,
      };
      const onAbort = () => {
        const i = this.#waiters.indexOf(waiter);
        if (i >= 0) this.#waiters.splice(i, 1);
        try {
          fail("cancelled", "exec aborted while waiting for a free slot");
        } catch (e) {
          reject(e);
        }
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#waiters.push(waiter);
    });
    return this.#releaser();
  }

  #releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.#waiters.shift();
      if (next) next.resolve();
      else this.#available += 1;
    };
  }
}

/** Single-consumer async queue with an end marker; `pause`/`resume` hooks apply backpressure. */
export class AsyncQueue<T> implements AsyncIterable<T> {
  #items: T[] = [];
  #ended = false;
  #wake: (() => void) | undefined;
  readonly #highWater: number;
  readonly #onPressure: ((paused: boolean) => void) | undefined;
  #paused = false;

  constructor(options: { highWater?: number; onPressure?: (paused: boolean) => void } = {}) {
    this.#highWater = options.highWater ?? 256;
    this.#onPressure = options.onPressure;
  }

  push(item: T): void {
    if (this.#ended) return;
    this.#items.push(item);
    if (!this.#paused && this.#items.length >= this.#highWater) {
      this.#paused = true;
      this.#onPressure?.(true);
    }
    this.#wake?.();
  }

  end(): void {
    this.#ended = true;
    this.#wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      const item = this.#items.shift();
      if (item !== undefined) {
        if (this.#paused && this.#items.length < this.#highWater / 2) {
          this.#paused = false;
          this.#onPressure?.(false);
        }
        yield item;
        continue;
      }
      if (this.#ended) return;
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
      });
      this.#wake = undefined;
    }
  }
}
