-- Memory recall log (owner: S07, packages/memory). docs/04-data-model.md §7; security §8
-- "One writer": dreaming promotes an agent inference only after it was recalled repeatedly by
-- different queries. Queries are stored as hashes, never as text.
-- Applied inside one transaction by src/migrate.ts; do not edit once merged, add a new file.

CREATE TABLE memory_recalls (
  id INTEGER PRIMARY KEY NOT NULL,
  chunk_id TEXT NOT NULL REFERENCES memory_chunks (id) ON DELETE CASCADE,
  query_hash TEXT NOT NULL,                        -- sha256 hex of the normalized query
  created_at TEXT NOT NULL
);
CREATE INDEX memory_recalls_chunk_idx ON memory_recalls (chunk_id, created_at);
