import type { SearchIndexDocKind } from "@psyche/protocol";
import type { SqliteSearchIndex } from "./sqlite-index.ts";
import type { SearchDoc } from "./types.ts";

/**
 * Resumable, throttled backfill of the index from the stores (docs/design/search-2026.md §5.1).
 * Sources are read in order, one page at a time; after each page its cursor is saved in
 * `search_meta` (`backfill.cursor.<source>`), so a crash or quit resumes where it stopped. A
 * completed pass records `backfill.version`; `needed()` is true until the current version ran.
 *
 * A full rebuild (`run({ full: true })`) starts every source from the beginning and afterwards
 * sweeps the rows it did not see: documents whose store row is gone. Only rows that existed when
 * the run started and whose kind a source covers are swept, so live events indexed meanwhile and
 * documents of other producers (connectors, the people graph) are never touched.
 */

export interface BackfillPage {
  docs: SearchDoc[];
  /** `has:` facts to record (attachments seen while paging). */
  flags?: { targetId: string; flag: "approval" | "receipt" | "attachment" }[];
  /** Cursor for the next page; `null` when the source is exhausted. */
  next: string | null;
}

export interface BackfillSource {
  readonly name: string;
  /** Document kinds this source produces (what a full rebuild may sweep). */
  readonly kinds: readonly SearchIndexDocKind[];
  page(cursor: string | null): Promise<BackfillPage>;
}

export interface BackfillStatus {
  state: "idle" | "running" | "done" | "error";
  done: number;
  source?: string;
  error?: string;
  startedAt?: number;
  finishedAt?: number;
}

export interface BackfillOptions {
  /** Bump when adapters change so existing installs re-index once. */
  version?: number;
  /** Pause between pages, so chat and ⌘K stay responsive (default 10 ms). */
  pauseMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onStatus?: (status: BackfillStatus) => void;
}

/** Current adapter version: bump to re-index existing installs once. */
export const BACKFILL_VERSION = 1;

const CURSOR = (source: string) => `backfill.cursor.${source}`;
const VERSION_KEY = "backfill.version";
/** Set while a full rebuild runs: rows up to this rowid that no source re-produces are swept. */
const FULL_KEY = "backfill.full";

export class Backfill {
  readonly #index: SqliteSearchIndex;
  readonly #sources: readonly BackfillSource[];
  readonly #version: number;
  readonly #pauseMs: number;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #onStatus: ((status: BackfillStatus) => void) | undefined;
  #status: BackfillStatus = { state: "idle", done: 0 };
  #running: Promise<void> | null = null;
  #stopped = false;

  constructor(
    index: SqliteSearchIndex,
    sources: readonly BackfillSource[],
    options: BackfillOptions = {},
  ) {
    this.#index = index;
    this.#sources = sources;
    this.#version = options.version ?? BACKFILL_VERSION;
    this.#pauseMs = options.pauseMs ?? 10;
    this.#now = options.now ?? Date.now;
    this.#sleep =
      options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms))));
    this.#onStatus = options.onStatus;
    if (!this.needed()) this.#status = { state: "done", done: 0 };
  }

  status(): BackfillStatus {
    return { ...this.#status };
  }

  get running(): boolean {
    return this.#running !== null;
  }

  /** True until a pass of the current version completed (a new index, or adapters changed). */
  needed(): boolean {
    return this.#meta(VERSION_KEY) !== String(this.#version);
  }

  /**
   * Starts a pass, or returns the one in flight (idempotent). `full` re-reads every source from
   * the start and sweeps rows whose store row is gone. Returns whether a new run started.
   */
  start(options: { full?: boolean } = {}): { started: boolean; done: Promise<void> } {
    if (this.#running !== null) return { started: false, done: this.#running };
    this.#stopped = false;
    const run = this.#run(options.full === true).finally(() => {
      this.#running = null;
    });
    this.#running = run;
    return { started: true, done: run };
  }

  /** Stops after the current page; the saved cursors resume the pass next time. */
  async stop(): Promise<void> {
    this.#stopped = true;
    await this.#running?.catch(() => undefined);
  }

  async #run(full: boolean): Promise<void> {
    const db = this.#index.db;
    // A full rebuild that was interrupted stays a full rebuild (its sweep still has to run).
    const isFull = full || this.#meta(FULL_KEY) !== undefined;
    let sweepBelow: number;
    if (full) {
      for (const s of this.#sources) this.#setMeta(CURSOR(s.name), undefined);
      sweepBelow = (
        db.prepare("SELECT coalesce(max(rowid), 0) AS m FROM search_docs").get() as {
          m: number;
        }
      ).m;
      this.#setMeta(FULL_KEY, String(sweepBelow));
    } else {
      sweepBelow = Number(this.#meta(FULL_KEY) ?? 0);
    }
    this.#set({ state: "running", done: 0, startedAt: this.#now() });
    let done = 0;
    try {
      for (const source of this.#sources) {
        let cursor = this.#meta(CURSOR(source.name)) ?? null;
        if (cursor === DONE) continue;
        this.#set({ ...this.#status, source: source.name });
        for (;;) {
          if (this.#stopped) {
            this.#set({ state: "idle", done });
            return;
          }
          const page = await source.page(cursor);
          await this.#index.indexMany(page.docs);
          if (isFull) this.#markSeen(page.docs);
          for (const f of page.flags ?? []) await this.#index.setFlag(f.targetId, f.flag);
          done += page.docs.length;
          cursor = page.next;
          this.#setMeta(CURSOR(source.name), cursor ?? DONE);
          this.#set({ ...this.#status, done });
          if (cursor === null) break;
          await this.#sleep(this.#pauseMs);
        }
      }
      if (isFull) this.#sweep(sweepBelow);
      for (const s of this.#sources) this.#setMeta(CURSOR(s.name), undefined);
      this.#setMeta(FULL_KEY, undefined);
      this.#setMeta(VERSION_KEY, String(this.#version));
      this.#set({
        state: "done",
        done,
        startedAt: this.#status.startedAt ?? this.#now(),
        finishedAt: this.#now(),
      });
    } catch (err) {
      this.#set({
        state: "error",
        done,
        error: err instanceof Error ? err.message : String(err),
        ...(this.#status.source === undefined ? {} : { source: this.#status.source }),
      });
    }
  }

  #markSeen(docs: readonly SearchDoc[]): void {
    const db = this.#index.db;
    db.exec("CREATE TABLE IF NOT EXISTS search_backfill_seen (id TEXT PRIMARY KEY)");
    const insert = db.prepare("INSERT OR IGNORE INTO search_backfill_seen (id) VALUES (?)");
    db.transaction(() => {
      for (const d of docs) insert.run(d.id);
    })();
  }

  /** Drops rows from before the run that no source produced again (their store row is gone). */
  #sweep(below: number): void {
    const db = this.#index.db;
    db.exec("CREATE TABLE IF NOT EXISTS search_backfill_seen (id TEXT PRIMARY KEY)");
    const kinds = [...new Set(this.#sources.flatMap((s) => s.kinds))];
    if (kinds.length > 0) {
      db.prepare(
        `DELETE FROM search_docs WHERE rowid <= ? AND kind IN (${kinds.map(() => "?").join(", ")})
           AND id NOT IN (SELECT id FROM search_backfill_seen)`,
      ).run(below, ...kinds);
    }
    db.exec("DROP TABLE search_backfill_seen");
  }

  #set(status: BackfillStatus): void {
    this.#status = status;
    this.#onStatus?.({ ...status });
  }

  #meta(key: string): string | undefined {
    const row = this.#index.db.prepare("SELECT value FROM search_meta WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  }

  #setMeta(key: string, value: string | undefined): void {
    const db = this.#index.db;
    if (value === undefined) db.prepare("DELETE FROM search_meta WHERE key = ?").run(key);
    else
      db.prepare(
        "INSERT INTO search_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      ).run(key, value);
  }
}

/** Cursor value of a finished source within an unfinished pass. */
const DONE = "\u0000done";
