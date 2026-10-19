/** Unbounded single-consumer async queue: the run pushes, `startTurn`'s iterator pulls. */
export class EventQueue<T> implements AsyncIterable<T> {
  #items: T[] = [];
  #waiting: ((r: IteratorResult<T>) => void) | undefined;
  #closed = false;

  push(item: T): void {
    if (this.#closed) return;
    const waiting = this.#waiting;
    if (waiting !== undefined) {
      this.#waiting = undefined;
      waiting({ value: item, done: false });
    } else {
      this.#items.push(item);
    }
  }

  close(): void {
    this.#closed = true;
    const waiting = this.#waiting;
    this.#waiting = undefined;
    waiting?.({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const item = this.#items.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.#closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => {
          this.#waiting = resolve;
        });
      },
    };
  }
}
