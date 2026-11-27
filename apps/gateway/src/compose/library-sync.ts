/** How often the library is fully diffed against the index even when nothing looked changed. */
export const LIBRARY_FULL_RECONCILE_MS = 60 * 60_000;

export interface LibrarySyncOptions {
  /**
   * A cheap fingerprint of the library table (count and newest created_at): it changes when an
   * item is added or removed. Edits come as `library.*` events, see `changed()`.
   */
  watermark(): string;
  /**
   * The full diff and indexing pass. Resolves true when it stopped early (images past the OCR
   * budget) and the next pass has work left. A throw leaves the next pass due.
   */
  reconcile(): Promise<boolean>;
  now?: () => number;
  fullEveryMs?: number;
}

export interface LibrarySync {
  /** Runs a pass when one is due. A pass already running makes this a no-op (no overlap). */
  run(): Promise<void>;
  /** A `library.*` event arrived: the next pass is not skipped. */
  changed(): void;
}

/**
 * The library reconcile (search §library) on a timer: one pass at a time, and a pass only when
 * something could have changed. A pass is skipped when the watermark is the same, no library event
 * arrived, and the last pass left no work; a full diff still runs at most once an hour.
 */
export function createLibrarySync(options: LibrarySyncOptions): LibrarySync {
  const now = options.now ?? Date.now;
  const fullEveryMs = options.fullEveryMs ?? LIBRARY_FULL_RECONCILE_MS;
  let running = false;
  let seen = false;
  let pending = false;
  let watermark: string | undefined;
  let fullAt: number | undefined;
  return {
    async run() {
      if (running) return;
      const current = options.watermark();
      const full = fullAt === undefined || now() - fullAt >= fullEveryMs;
      if (!full && !seen && !pending && current === watermark) return;
      running = true;
      seen = false;
      pending = false;
      try {
        pending = await options.reconcile();
        watermark = current;
        fullAt = now();
      } catch (err) {
        // Nothing is recorded as clean: the next pass runs whatever the watermark says.
        pending = true;
        throw err;
      } finally {
        running = false;
      }
    },
    changed() {
      seen = true;
    },
  };
}
