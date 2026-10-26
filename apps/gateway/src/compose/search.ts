import { join } from "node:path";
import { getLibraryItem, getThread, openDb } from "@psyche/db";
import type { DeviceScope, MemoryStore, SearchIndexStatus } from "@psyche/protocol";
import {
  Backfill,
  type BackfillStatus,
  createSearchHandlers,
  libraryDoc,
  OWNER,
  SearchIndexer,
  SqliteSearchIndex,
} from "@psyche/search";
import type { HandlerDef } from "../context.ts";
import type { Logger } from "../log.ts";
import type { Gateway } from "../server.ts";
import { libraryText, type SearchSourceDeps, searchSources } from "./search-sources.ts";
import type { ComposedPart } from "./services.ts";

/**
 * Unified search (feature S1, architecture §4.12, docs/design/search-2026.md): the main index in
 * its own file, `$PSYCHE_HOME/state/search.sqlite` (derived data, safe to delete), kept current
 * from the Gateway's events by `SearchIndexer`, and the `search.query` method. Every paired
 * operator device is the owner, so the method searches every scope; delegated viewers (a
 * designated person's agent) go through `index.search` with their own `scopeKey`.
 *
 * S2: a resumable, throttled backfill from the stores runs at start when the index is new or the
 * adapters changed, and on `search.reindex` (a full rebuild that also drops vanished rows).
 * Library items have no events, so new and removed items are reconciled every minute.
 * `search.status` and `search.status.updated` report progress.
 */
export interface ComposedSearch extends ComposedPart {
  readonly index: SqliteSearchIndex;
  readonly indexer: SearchIndexer;
  readonly backfill: Backfill;
  /** Resolves once every event seen so far is indexed (tests, the backfill). */
  idle(): Promise<void>;
  status(): Promise<SearchIndexStatus>;
  /** Indexes Library items added since the last sync and drops removed ones. */
  syncLibrary(): Promise<void>;
}

export interface SearchDeps extends Omit<SearchSourceDeps, "pageSize"> {
  memory: MemoryStore;
  now: () => number;
  logger?: Logger;
  /** Index file; defaults to `<home>/state/search.sqlite`. */
  path?: string;
  /** Library reconcile interval (default 60 s; 0 = only after a backfill and on demand). */
  librarySyncMs?: number;
  /** Pause between backfill pages (default 10 ms). */
  backfillPauseMs?: number;
}

/** At most one `search.status.updated` per this many ms while a backfill runs. */
const STATUS_EVERY_MS = 500;

/** Every scope, so the indexer sees each event whatever scope it is published under. */
const ALL_SCOPES: DeviceScope[] = [
  "operator.read",
  "operator.write",
  "operator.approvals",
  "operator.admin",
  "node",
];

export function composeSearch(deps: SearchDeps): ComposedSearch {
  // Its own file, not psyche.sqlite: it can be rebuilt any time and its writes never contend
  // with the transcript writer.
  const file = openDb(deps.path ?? join(deps.home, "state", "search.sqlite"), { migrate: false });
  const index = new SqliteSearchIndex(file.sqlite, { memory: deps.memory, now: deps.now });
  const indexer = new SearchIndexer(index, {
    lookupThread: async (id) => getThread(deps.db, id),
    lookupTask: (id) => deps.tasks.get(id),
    onError: (err, event) =>
      deps.logger?.log("warn", "search: indexing an event failed", { event, err: String(err) }),
  });
  const api = createSearchHandlers(index);
  let gateway: Gateway | undefined;
  let lastStatusAt = 0;
  const statusOf = async (backfill: BackfillStatus): Promise<SearchIndexStatus> => ({
    docs: await index.count(),
    backfill,
  });
  const backfill: Backfill = new Backfill(index, searchSources(deps), {
    now: deps.now,
    ...(deps.backfillPauseMs === undefined ? {} : { pauseMs: deps.backfillPauseMs }),
    onStatus: (b) => {
      const now = Date.now();
      if (b.state === "running" && now - lastStatusAt < STATUS_EVERY_MS) return;
      lastStatusAt = now;
      void statusOf(b).then((st) => gateway?.bus.publish("search.status.updated", st));
    },
  });
  const syncLibrary = async () => {
    const have = new Set(
      (deps.db.sqlite.prepare("SELECT id FROM library_items").all() as { id: string }[]).map(
        (r) => r.id,
      ),
    );
    const indexed = new Set(
      (
        index.db.prepare("SELECT id FROM search_docs WHERE kind = 'library'").all() as {
          id: string;
        }[]
      ).map((r) => r.id),
    );
    for (const id of indexed) if (!have.has(id)) await index.remove(id);
    for (const id of have) {
      if (indexed.has(id)) continue;
      const item = getLibraryItem(deps.db, id);
      if (item !== undefined)
        await index.index(libraryDoc(item, await libraryText(deps.home, item)));
    }
  };
  const runBackfill = (full: boolean) => {
    const run = backfill.start({ full });
    void run.done
      .then(() => syncLibrary())
      .catch((err) => deps.logger?.log("warn", "search: backfill failed", { err: String(err) }));
    return run.started;
  };
  let libraryTimer: ReturnType<typeof setInterval> | undefined;
  // Events are indexed one at a time in publish order (a thread before its messages).
  let queue: Promise<void> = Promise.resolve();
  let unsubscribe: (() => void) | undefined;
  const handlers: Record<string, HandlerDef> = {
    "search.query": {
      run: (_call, params: never) => api["search.query"](params, { viewer: OWNER }),
    },
    "search.status": { run: () => statusOf(backfill.status()) },
    "search.reindex": { run: () => ({ started: runBackfill(true) }) },
  };
  return {
    index,
    indexer,
    backfill,
    handlers,
    idle: () => queue,
    status: () => statusOf(backfill.status()),
    syncLibrary,
    start(gw: Gateway) {
      gateway = gw;
      unsubscribe = gw.bus.subscribe(ALL_SCOPES, (frame) => {
        const f = JSON.parse(frame) as { event?: string; payload?: unknown };
        const event = f.event;
        if (event === undefined) return;
        queue = queue.then(() => indexer.handle(event, f.payload));
      });
      // A new index (or new adapters) fills from the stores; an interrupted pass resumes.
      if (backfill.needed()) runBackfill(false);
      const every = deps.librarySyncMs ?? 60_000;
      if (every > 0) {
        libraryTimer = setInterval(() => {
          if (!backfill.running) void syncLibrary().catch(() => undefined);
        }, every);
        libraryTimer.unref?.();
      }
    },
    async stop() {
      unsubscribe?.();
      unsubscribe = undefined;
      if (libraryTimer !== undefined) clearInterval(libraryTimer);
      gateway = undefined;
      await backfill.stop();
      await queue;
      file.sqlite.close();
    },
  };
}
