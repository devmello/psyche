/**
 * Push-to-pull bridge: callbacks `push` values, a consumer `for await`s them. `end()` finishes
 * the iteration after buffered values drain; `fail(err)` rethrows in the consumer.
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  readonly #buffer: T[] = [];
  #waiters: ((r: IteratorResult<T>) => void)[] = [];
  #rejecters: ((e: unknown) => void)[] = [];
  #done = false;
  #error: { err: unknown } | undefined;

  push(value: T): void {
    if (this.#done) return;
    const w = this.#waiters.shift();
    this.#rejecters.shift();
    if (w !== undefined) w({ value, done: false });
    else this.#buffer.push(value);
  }

  end(): void {
    if (this.#done) return;
    this.#done = true;
    for (const w of this.#waiters) w({ value: undefined, done: true });
    this.#waiters = [];
    this.#rejecters = [];
  }

  fail(err: unknown): void {
    if (this.#done) return;
    this.#error = { err };
    this.#done = true;
    for (const r of this.#rejecters) r(err);
    this.#waiters = [];
    this.#rejecters = [];
  }

  get ended(): boolean {
    return this.#done;
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.#buffer.length > 0) {
          return Promise.resolve({ value: this.#buffer.shift() as T, done: false });
        }
        if (this.#error !== undefined) return Promise.reject(this.#error.err);
        if (this.#done) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve, reject) => {
          this.#waiters.push(resolve);
          this.#rejecters.push(reject);
        });
      },
      return: () => {
        this.end();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}

/** Base64 helpers for JSON transports (node capabilities, `voice.push`). */
export function toBase64(data: Uint8Array): string {
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("base64");
}

export function fromBase64(text: string): Uint8Array {
  const b = Buffer.from(text, "base64");
  return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
}
