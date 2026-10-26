import { join } from "node:path";
import { getThread, openDb, type PsycheDb } from "@psyche/db";
import type { DeviceScope, MemoryStore, Task } from "@psyche/protocol";
import { createSearchHandlers, OWNER, SearchIndexer, SqliteSearchIndex } from "@psyche/search";
import type { HandlerDef } from "../context.ts";
import type { Logger } from "../log.ts";
import type { Gateway } from "../server.ts";
import type { ComposedPart } from "./services.ts";

/**
 * Unified search (feature S1, architecture §4.12, docs/design/search-2026.md): the main index in
 * its own file, `$PSYCHE_HOME/state/search.sqlite` (derived data, safe to delete), kept current
 * from the Gateway's events by `SearchIndexer`, and the `search.query` method. Every paired
 * operator device is the owner, so the method searches every scope; delegated viewers (a
 * designated person's agent) go through `index.search` with their own `scopeKey`.
 */
export interface ComposedSearch extends ComposedPart {
  readonly index: SqliteSearchIndex;
  readonly indexer: SearchIndexer;
  /** Resolves once every event seen so far is indexed (tests, the backfill). */
  idle(): Promise<void>;
}

export interface SearchDeps {
  db: PsycheDb;
  home: string;
  memory: MemoryStore;
  tasks: { get(taskId: string): Promise<Task | undefined> };
  now: () => number;
  logger?: Logger;
  /** Index file; defaults to `<home>/state/search.sqlite`. */
  path?: string;
}

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
  // Events are indexed one at a time in publish order (a thread before its messages).
  let queue: Promise<void> = Promise.resolve();
  let unsubscribe: (() => void) | undefined;
  const handlers: Record<string, HandlerDef> = {
    "search.query": {
      run: (_call, params: never) => api["search.query"](params, { viewer: OWNER }),
    },
  };
  return {
    index,
    indexer,
    handlers,
    idle: () => queue,
    start(gw: Gateway) {
      unsubscribe = gw.bus.subscribe(ALL_SCOPES, (frame) => {
        const f = JSON.parse(frame) as { event?: string; payload?: unknown };
        const event = f.event;
        if (event === undefined) return;
        queue = queue.then(() => indexer.handle(event, f.payload));
      });
    },
    async stop() {
      unsubscribe?.();
      unsubscribe = undefined;
      await queue;
      file.sqlite.close();
    },
  };
}
