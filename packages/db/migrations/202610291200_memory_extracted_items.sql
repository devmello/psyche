-- Everything memory EM3: which items the extractor already read (docs/design/everything-memory-2026.md
-- §6.2). An unchanged item (same source_hash) is never extracted again. No text is kept here, only
-- the hash the offsets refer to.
-- Applied inside one transaction by src/migrate.ts; do not edit once merged, add a new file.

CREATE TABLE memory_extracted_items (
  source TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  run_id TEXT REFERENCES memory_runs (id) ON DELETE SET NULL,
  extracted_at TEXT NOT NULL,
  PRIMARY KEY (source, source_ref)
);
CREATE INDEX memory_extracted_items_time_idx ON memory_extracted_items (extracted_at);
