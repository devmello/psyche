import type { PsycheDb } from "@psyche/db";
import { SqliteMemoryStore, type SqliteMemoryStoreOptions } from "./store.ts";

/**
 * `@psyche/memory` (S07): the workspace the owner can read plus the local index the agent
 * searches. See README.md for the file formats, provenance rules and public API.
 */

export * from "./chunker.ts";
export * from "./context.ts";
export * from "./daily.ts";
export * from "./dreaming.ts";
export * from "./export.ts";
export * from "./filters.ts";
export * from "./flush.ts";
export * from "./git-sync.ts";
export * from "./graph/cards.ts";
export * from "./graph/handlers.ts";
export * from "./graph/ingest.ts";
export * from "./graph/model-pass.ts";
export * from "./graph/normalize.ts";
export * from "./graph/projects.ts";
export * from "./graph/store.ts";
export * from "./graph/tools.ts";
export * from "./handlers.ts";
export * from "./importer.ts";
export * from "./layout.ts";
export * from "./nightly.ts";
export * from "./paths.ts";
export * from "./persona.ts";
export * from "./persona-edit.ts";
export * from "./provenance.ts";
export * from "./store.ts";
export * from "./support.ts";
export * from "./tools/index.ts";
export {
  type Embedder,
  type ProviderEmbedderOptions,
  providerEmbedder,
  type VectorMode,
} from "./vector.ts";

/**
 * Opens the memory store on the main database and the workspace folder and runs first-run
 * setup (templates, initial index). Call `watch()` to pick up edits made outside Psyche.
 */
export async function createMemoryStore(
  options: Omit<SqliteMemoryStoreOptions, "sqlite"> & { db: PsycheDb },
): Promise<SqliteMemoryStore> {
  const { db, ...rest } = options;
  const store = new SqliteMemoryStore({
    ...rest,
    sqlite: db.sqlite,
    newId: rest.newId ?? db.newId,
  });
  await store.init();
  return store;
}
export * from "./learned.ts";
