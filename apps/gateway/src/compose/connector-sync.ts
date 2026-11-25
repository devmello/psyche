import { PsycheError } from "@psyche/protocol";

/**
 * The Gateway's connector sync round. Each connector has its own failure count and backoff, and
 * each sync its own timeout, so one stalled or broken provider never holds up the others and a
 * broken one is not hammered. After `FAILURES_BEFORE_ERROR` failures in a row the record is parked
 * as `error` with a short reason (Settings shows it, the owner is told once); it keeps being
 * retried at the backed-off pace and flips back to `connected` on the first success.
 */

/** A hung sync is cut off after this long. */
export const DEFAULT_SYNC_TIMEOUT_MS = 60_000;
/** The longest wait between two tries of a failing connector. */
export const MAX_BACKOFF_MS = 60 * 60_000;
/** Failures in a row before the record turns `error`. */
export const FAILURES_BEFORE_ERROR = 5;

/** 1 failure → `base`, then doubled each time: 3 min, 6, 12, 24, 48, then 1 h. */
export function backoffMs(failures: number, baseMs: number): number {
  if (failures <= 0) return 0;
  return Math.min(baseMs * 2 ** (failures - 1), MAX_BACKOFF_MS);
}

export interface SyncRecord {
  id: string;
  status: string;
  config: Record<string, unknown>;
  lastSync: Record<string, unknown> | null;
}

export interface SyncTarget {
  list(): Promise<SyncRecord[]>;
  sync(id: string, signal?: AbortSignal): Promise<unknown>;
  status(id: string): Promise<unknown>;
  markSyncFailing(id: string, reason: string): Promise<void>;
}

export interface ConnectorSyncOptions {
  registry: SyncTarget;
  now: () => number;
  /** The normal sync interval; the backoff doubles from it. */
  intervalMs: number;
  timeoutMs?: number;
  failuresBeforeError?: number;
  log?: (message: string, fields: Record<string, string | number>) => void;
}

class SyncTimeoutError extends Error {
  constructor() {
    super("sync timed out");
  }
}

export class ConnectorSync {
  readonly #o: ConnectorSyncOptions;
  readonly #state = new Map<string, { failures: number; nextAt: number }>();
  #running = false;

  constructor(options: ConnectorSyncOptions) {
    this.#o = options;
  }

  /** Failures in a row for a connector (tests, diagnostics). */
  failures(id: string): number {
    return this.#state.get(id)?.failures ?? 0;
  }

  /** One round over every connector that is due. A slow round never stacks another. */
  async runOnce(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try {
      for (const record of await this.#o.registry.list()) {
        // Waiting on a macOS grant (#549): re-check it, so the row flips once it is allowed.
        if (record.status === "needs_auth" && typeof record.config.permission === "object") {
          await this.#o.registry.status(record.id).catch(() => undefined);
          continue;
        }
        const parked = record.status === "error" && record.lastSync?.syncFailing === true;
        if (record.status !== "connected" && !parked) {
          this.#state.delete(record.id);
          continue;
        }
        await this.#syncOne(record, parked);
      }
    } finally {
      this.#running = false;
    }
  }

  async #syncOne(record: SyncRecord, parked: boolean): Promise<void> {
    const threshold = this.#o.failuresBeforeError ?? FAILURES_BEFORE_ERROR;
    let state = this.#state.get(record.id);
    // After a restart a parked record resumes at its slowest pace, not at a fresh start.
    if (state === undefined && parked) state = { failures: threshold, nextAt: 0 };
    if (state !== undefined && this.#o.now() < state.nextAt) return;
    try {
      await this.#withTimeout(record.id);
      this.#state.delete(record.id);
    } catch (err) {
      const failures = (state?.failures ?? 0) + 1;
      const next = { failures, nextAt: this.#o.now() + backoffMs(failures, this.#o.intervalMs) };
      this.#state.set(record.id, next);
      const code = err instanceof SyncTimeoutError ? "timeout" : PsycheError.from(err).code;
      this.#o.log?.("connector sync failed", {
        connectorId: record.id,
        code,
        failures,
        retryInMs: next.nextAt - this.#o.now(),
      });
      if (failures >= threshold && !parked) {
        await this.#o.registry.markSyncFailing(record.id, code).catch((e) =>
          this.#o.log?.("connector status update failed", {
            connectorId: record.id,
            code: PsycheError.from(e).code,
          }),
        );
      }
    }
  }

  /** Aborts the sync's signal at the deadline and stops waiting even for one that ignores it. */
  async #withTimeout(id: string): Promise<void> {
    const timeoutMs = this.#o.timeoutMs ?? DEFAULT_SYNC_TIMEOUT_MS;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new SyncTimeoutError());
      }, timeoutMs);
    });
    const run = this.#o.registry.sync(id, controller.signal);
    // A sync that settles after the deadline must not become an unhandled rejection.
    run.catch(() => undefined);
    try {
      await Promise.race([run, deadline]);
    } finally {
      clearTimeout(timer);
    }
  }
}
