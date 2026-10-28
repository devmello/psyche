import { openDb } from "@psyche/db";
import type Database from "better-sqlite3";
import { SqliteSearchIndex, type SqliteSearchIndexOptions } from "./sqlite-index.ts";

export * from "./adapters.ts";
export * from "./backfill.ts";
export * from "./cards/index.ts";
export * from "./fake-embedder.ts";
export * from "./graph.ts";
export * from "./handlers.ts";
export * from "./highlight.ts";
export * from "./indexer.ts";
export * from "./lazy-embedder.ts";
export * from "./memory.ts";
export * from "./onnx-embedder.ts";
export * from "./query-parser.ts";
export * from "./ranking.ts";
export * from "./schema.ts";
export * from "./semantic.ts";
export * from "./sqlite-index.ts";
export * from "./types.ts";
export * from "./web/index.ts";

export interface CreateSearchIndexOptions extends SqliteSearchIndexOptions {
  /**
   * Index file, normally `$PSYCHE_HOME/state/search.sqlite` (derived data, safe to delete), or
   * `":memory:"`. Opened with `@psyche/db`'s hardened settings (0700 dir, 0600 file, WAL).
   */
  path?: string;
  /** Use an already open connection instead of `path`. */
  db?: Database.Database;
}

/** Opens (or creates) the search index. */
export function createSearchIndex(options: CreateSearchIndexOptions = {}): SqliteSearchIndex {
  const db = options.db ?? openDb(options.path ?? ":memory:", { migrate: false }).sqlite;
  return new SqliteSearchIndex(db, options);
}
