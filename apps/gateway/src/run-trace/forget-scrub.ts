import {
  beginTraceScrub,
  deleteTraceScrub,
  enqueueTraceScrub,
  listTraceScrub,
  type PsycheDb,
  restartTraceScrubFinal,
  runTraceScrubBatch,
  TRACE_SCRUB_BUDGET_BYTES,
  type TraceScrubRow,
} from "@psyche/db";

/**
 * Runs Forget's trace scrub in the background: one phrase at a time, in byte-budgeted batches
 * that yield to the event loop. The queue lives in the database, so a phrase still pending at a
 * shutdown is resumed by `start()`. A run that was active when a pass began may write the text
 * back after the pass has passed its rows, so a final pass follows once those runs have ended
 * (or after a day). A phrase waiting for its final pass never holds up the phrases behind it, and
 * nothing polls: the worker wakes when a run ends (`wake()`) or when a wait expires.
 */

type Outcome = "idle" | "more" | "wait";

/** How long a final pass waits for the runs it watches before it runs anyway. */
export const FINAL_WAIT_MS = 24 * 60 * 60 * 1000;

export interface TraceScrubWorkerOptions {
  readonly db: PsycheDb;
  /** Ids of the runs in progress right now (the loop's view, not the database's). */
  readonly activeRuns: () => readonly string[];
  readonly log: (level: "info" | "warn", message: string) => void;
  readonly now?: () => string;
  readonly budgetBytes?: number;
  /** How long a final pass waits for its runs; default a day. */
  readonly finalWaitMs?: number;
}

export class TraceScrubWorker {
  readonly #o: TraceScrubWorkerOptions;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #busy = false;
  #stopped = false;
  /** Set while waiting: the earliest time a waiting final pass gives up waiting. */
  #nextExpiry: number | undefined;

  constructor(options: TraceScrubWorkerOptions) {
    this.#o = options;
  }

  /** Resumes whatever the queue still holds (after a restart). */
  start(): void {
    this.#stopped = false;
    this.#kick(0);
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  /** Queues a forgotten phrase; a phrase already queued starts its pass over, once. */
  enqueue(subject: string): void {
    enqueueTraceScrub(this.#o.db, subject, this.#nowIso());
    this.wake();
  }

  /** A run ended (or anything else that may let a waiting pass go on): look at the queue again. */
  wake(): void {
    if (this.#stopped) return;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#kick(0);
  }

  #nowIso(): string {
    return this.#o.now?.() ?? new Date().toISOString();
  }

  #kick(ms: number): void {
    if (this.#stopped || this.#timer !== undefined) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.#drain();
    }, ms);
    // A day-long wait never keeps the process alive.
    this.#timer.unref?.();
  }

  async #drain(): Promise<void> {
    if (this.#busy || this.#stopped) return;
    this.#busy = true;
    try {
      for (;;) {
        if (this.#stopped) return;
        let outcome: Outcome;
        try {
          outcome = this.#step();
        } catch {
          this.#o.log("warn", "forget's run-trace scrub paused; it resumes at the next start");
          return;
        }
        if (outcome === "idle") return;
        if (outcome === "wait") {
          // Nothing can progress until a run ends (wake) or the oldest wait expires.
          if (this.#nextExpiry !== undefined) {
            this.#kick(Math.max(0, this.#nextExpiry - Date.parse(this.#nowIso())));
          }
          return;
        }
        // Between batches the Gateway keeps serving.
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    } finally {
      this.#busy = false;
    }
  }

  /** The time a waiting row's final pass gives up waiting. */
  #expiresAt(row: TraceScrubRow): number {
    const since = row.finalSince === undefined ? Number.NaN : Date.parse(row.finalSince);
    return (Number.isNaN(since) ? Date.parse(this.#nowIso()) : since) + this.#waitMs();
  }

  #waitMs(): number {
    return this.#o.finalWaitMs ?? FINAL_WAIT_MS;
  }

  /** One batch of the oldest runnable phrase, or the step that ends its pass. */
  #step(): Outcome {
    const db = this.#o.db;
    const rows = listTraceScrub(db);
    if (rows.length === 0) return "idle";
    const active = new Set(this.#o.activeRuns());
    const now = Date.parse(this.#nowIso());
    // A final pass waits only for the runs that were active when its pass began, and only so long.
    this.#nextExpiry = undefined;
    const waiting = (r: TraceScrubRow): boolean => {
      if (!r.final || !r.watchRuns.some((id) => active.has(id))) return false;
      const expiry = this.#expiresAt(r);
      if (now >= expiry) return false;
      this.#nextExpiry = Math.min(this.#nextExpiry ?? expiry, expiry);
      return true;
    };
    const row = rows.find((r) => !waiting(r));
    if (row === undefined) return "wait";
    if (!row.final && !row.started) beginTraceScrub(db, row.id, [...active]);

    const batch = runTraceScrubBatch(db, row, this.#o.budgetBytes ?? TRACE_SCRUB_BUDGET_BYTES);
    if (!batch.finished) return "more";

    // The pass covered every table. Its counts and watch list are read again after the save.
    const done = listTraceScrub(db).find((r) => r.id === row.id);
    if (done === undefined) return "more";
    if (!done.final && done.watchRuns.length > 0) {
      restartTraceScrubFinal(db, done.id, this.#nowIso());
      return "more";
    }
    this.#o.log("info", `forget rewrote ${done.rewritten} run-trace row(s)`);
    if (done.skipped > 0) {
      this.#o.log("warn", `forget skipped ${done.skipped} run-trace row(s) that could not be read`);
    }
    deleteTraceScrub(db, done.subject);
    return "more";
  }
}
