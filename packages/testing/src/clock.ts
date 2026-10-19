import type { Clock } from "@psyche/protocol";

/** Default start: the data model's example timestamp, 2026-10-18T20:00:00Z. */
export const FAKE_EPOCH_MS = Date.UTC(2026, 9, 18, 20, 0, 0);

interface Timer {
  id: number;
  at: number;
  fn: () => void;
}

/**
 * Deterministic time for fakes and conformance suites. Time only moves when `advance` or `set`
 * is called; timers registered with `setTimer` fire synchronously, in order, during the move.
 */
export class FakeClock implements Clock {
  #now: number;
  #timers: Timer[] = [];
  #nextId = 1;

  constructor(startMs: number = FAKE_EPOCH_MS) {
    this.#now = startMs;
  }

  now(): number {
    return this.#now;
  }

  /** Current time as an ISO-8601 string (matches the protocol `IsoDateTime`). */
  iso(offsetMs = 0): string {
    return new Date(this.#now + offsetMs).toISOString();
  }

  advance(ms: number): void {
    if (ms < 0) throw new RangeError("FakeClock cannot go backwards");
    this.set(this.#now + ms);
  }

  set(ms: number): void {
    if (ms < this.#now) throw new RangeError("FakeClock cannot go backwards");
    for (;;) {
      const due = this.#timers
        .filter((t) => t.at <= ms)
        .sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (due === undefined) break;
      this.#timers = this.#timers.filter((t) => t !== due);
      this.#now = Math.max(this.#now, due.at);
      due.fn();
    }
    this.#now = ms;
  }

  /** Run `fn` when the clock reaches `atMs`. Returns a cancel function. */
  setTimer(atMs: number, fn: () => void): () => void {
    const timer: Timer = { id: this.#nextId++, at: atMs, fn };
    this.#timers.push(timer);
    return () => {
      this.#timers = this.#timers.filter((t) => t !== timer);
    };
  }

  get pendingTimers(): number {
    return this.#timers.length;
  }
}

/** Real wall-clock time, for code that accepts a `Clock`. */
export const systemClock: Clock = { now: () => Date.now() };

/** Epoch ms → ISO-8601. */
export function toIso(ms: number): string {
  return new Date(ms).toISOString();
}
