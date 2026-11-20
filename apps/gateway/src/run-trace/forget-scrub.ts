import {
  deleteTraceScrub,
  enqueueTraceScrub,
  markTraceScrubWatch,
  nextTraceScrub,
  type PsycheDb,
  restartTraceScrubFinal,
  runTraceScrubBatch,
  TRACE_SCRUB_BUDGET_BYTES,
} from "@psyche/db";

/**
 * Runs Forget's trace scrub in the background: one phrase at a time, in byte-budgeted batches
 * that yield to the event loop. The queue lives in the database, so a phrase still pending at a
 * shutdown is resumed by `start()`. A run that was active when a pass began may write the text
 * back after the pass has passed its rows, so a final pass follows once no run is active.
 */

type Outcome = "idle" | "more" | "wait";

export interface TraceScrubWorkerOptions {
  readonly db: PsycheDb;
  /** Ids of the runs in progress right now (the loop's view, not the database's). */
  readonly activeRuns: () => readonly string[];
  readonly log: (level: "info" | "warn", message: string) => void;
  readonly now?: () => string;
  readonly budgetBytes?: number;
  /** How long to wait before checking again while a run is active. */
  readonly retryMs?: number;
}

export class TraceScrubWorker {
  readonly #o: TraceScrubWorkerOptions;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #busy = false;
  #stopped = false;

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
    enqueueTraceScrub(this.#o.db, subject, this.#o.now?.() ?? new Date().toISOString());
    this.#kick(0);
  }

  #kick(ms: number): void {
    if (this.#stopped || this.#timer !== undefined) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.#drain();
    }, ms);
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
          this.#kick(this.#o.retryMs ?? 1000);
          return;
        }
        // Between batches the Gateway keeps serving.
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    } finally {
      this.#busy = false;
    }
  }

  /** One batch of the oldest queued phrase, or the step that ends its pass. */
  #step(): Outcome {
    const db = this.#o.db;
    const row = nextTraceScrub(db);
    if (row === undefined) return "idle";
    const active = this.#o.activeRuns();
    if (row.final && active.length > 0) return "wait";
    if (!row.final && row.phase === 0 && row.cursor === 0 && !row.watch && active.length > 0) {
      markTraceScrubWatch(db, row.subject);
    }
    const batch = runTraceScrubBatch(db, row, this.#o.budgetBytes ?? TRACE_SCRUB_BUDGET_BYTES);
    if (!batch.finished) return "more";

    // The pass covered every table. Its counts and watch flag are read again after the save.
    const done = nextTraceScrub(db);
    if (done === undefined) return "idle";
    if (!done.final && (done.watch || this.#o.activeRuns().length > 0)) {
      restartTraceScrubFinal(db, done.subject);
      return "wait";
    }
    this.#o.log("info", `forget rewrote ${done.rewritten} run-trace row(s)`);
    if (done.skipped > 0) {
      this.#o.log("warn", `forget skipped ${done.skipped} run-trace row(s) that could not be read`);
    }
    deleteTraceScrub(db, done.subject);
    return "more";
  }
}
