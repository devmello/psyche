-- Everything memory: the meaning of each fact, kept so Life search does not embed every fact
-- for every question (docs/design/everything-memory-2026.md §12.4). One row per fact and
-- embedding model; `text_hash` is the hash of the text that was embedded, so an edited fact is
-- embedded again. Facts in a sensitive class are never stored here. With encryption on this
-- table lives in the encrypted state/memory.sqlite like the rest of the graph (EM9b).
-- Applied inside one transaction by src/migrate.ts; do not edit once merged, add a new file.

CREATE TABLE graph_fact_vectors (
  fact_id TEXT NOT NULL REFERENCES graph_facts (id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  text_hash TEXT NOT NULL,
  dims INTEGER NOT NULL,
  vector BLOB NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (fact_id, model)
);
