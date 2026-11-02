/**
 * Opens something once a key that is not ready at start-up becomes available (the Mac helper
 * connects after the Gateway is composed). `provider` returns the key, or undefined while it is
 * not ready; it is tried every `retryMs` (2 s, backing off to 30 s) until it succeeds, then
 * `open` runs once. Used for the search index; the memory store's encrypted file can reuse it.
 */
export interface DeferredOpenOptions<T> {
  /** The key, or undefined while the source of keys is not ready. May throw: that is "not ready". */
  provider: () => Promise<Buffer | undefined>;
  open: (key: Buffer) => T | Promise<T>;
  /** Called once with the opened value. */
  onReady?: (value: T) => void;
  /** Called with the reason each time the provider fails or is not ready. */
  onWaiting?: (reason: string) => void;
  retryMs?: number;
  maxRetryMs?: number;
}

export class DeferredOpen<T> {
  readonly #o: DeferredOpenOptions<T>;
  #value: T | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #stopped = false;
  #started = false;
  #reason = "waiting for the Mac helper";

  constructor(options: DeferredOpenOptions<T>) {
    this.#o = options;
  }

  get value(): T | undefined {
    return this.#value;
  }

  get reason(): string {
    return this.#reason;
  }

  start(): void {
    if (this.#started || this.#stopped) return;
    this.#started = true;
    void this.#attempt(this.#o.retryMs ?? 2000);
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  async #attempt(delay: number): Promise<void> {
    if (this.#stopped || this.#value !== undefined) return;
    try {
      const key = await this.#o.provider();
      if (key !== undefined) {
        const value = await this.#o.open(key);
        if (this.#stopped) return;
        this.#value = value;
        this.#o.onReady?.(value);
        return;
      }
      this.#reason = "waiting for the Mac helper";
    } catch (err) {
      this.#reason = err instanceof Error ? err.message : String(err);
    }
    this.#o.onWaiting?.(this.#reason);
    const next = Math.min(delay * 1.5, this.#o.maxRetryMs ?? 30_000);
    this.#timer = setTimeout(() => void this.#attempt(next), delay);
    this.#timer.unref?.();
  }
}
