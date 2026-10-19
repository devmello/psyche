-- Memory index (owner: S07, packages/memory). docs/04-data-model.md §7, architecture §4.8,
-- security §8. The Markdown files in $PSYCHE_HOME/workspace are the source of truth; these
-- tables are a rebuildable index plus the claims ledger.
-- `memory_vec` (sqlite-vec vec0) is created at run time by packages/memory, because the
-- extension is loaded at run time and the vector width depends on the configured embedder.
-- Applied inside one transaction by src/migrate.ts; do not edit once merged, add a new file.

-- One row per indexed workspace file: lets the indexer skip unchanged files and records the
-- provenance of the content last written (external edits count as the owner's).
CREATE TABLE memory_files (
  path TEXT PRIMARY KEY NOT NULL,                  -- workspace-relative, e.g. "memory/2026-10-18.md"
  sha256 TEXT NOT NULL,                            -- hex digest of the file bytes (also the etag)
  bytes INTEGER NOT NULL CHECK (bytes >= 0),
  provenance TEXT NOT NULL CHECK (provenance IN ('owner', 'agent', 'untrusted', 'system')),
  mtime_ms INTEGER,
  indexed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE memory_claims (
  id TEXT PRIMARY KEY NOT NULL,
  text TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('fact', 'preference', 'relationship', 'directive', 'event')),
  provenance TEXT NOT NULL CHECK (provenance IN ('owner', 'agent', 'untrusted', 'system')),
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  sources TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(sources) AND json_type(sources) = 'array'),
  superseded_by TEXT REFERENCES memory_claims (id) ON DELETE SET NULL,
  retracted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX memory_claims_active_idx ON memory_claims (retracted_at, superseded_by);

-- Chunk ids are derived from (source, line_start, text), so an unchanged chunk keeps its id,
-- its embedding and its claim link across reindexes. `rowid` is declared explicitly so the
-- FTS5 external-content mapping survives VACUUM (implicit rowids may be renumbered).
CREATE TABLE memory_chunks (
  rowid INTEGER PRIMARY KEY NOT NULL,
  id TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL,                            -- workspace path
  line_start INTEGER NOT NULL CHECK (line_start >= 1),
  line_end INTEGER NOT NULL CHECK (line_end >= line_start),
  text TEXT NOT NULL,
  provenance TEXT NOT NULL CHECK (provenance IN ('owner', 'agent', 'untrusted', 'system')),
  claim_id TEXT REFERENCES memory_claims (id) ON DELETE SET NULL,
  token_count INTEGER NOT NULL CHECK (token_count >= 0),
  embedding BLOB,                                  -- little-endian float32 vector
  embedding_model TEXT,                            -- provider/model that produced `embedding`
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX memory_chunks_source_idx ON memory_chunks (source, line_start);
CREATE INDEX memory_chunks_claim_idx ON memory_chunks (claim_id) WHERE claim_id IS NOT NULL;

CREATE VIRTUAL TABLE memory_fts USING fts5(
  text,
  content = 'memory_chunks',
  content_rowid = 'rowid',
  tokenize = 'porter unicode61 remove_diacritics 2'
);
CREATE TRIGGER memory_chunks_fts_insert AFTER INSERT ON memory_chunks BEGIN
  INSERT INTO memory_fts (rowid, text) VALUES (new.rowid, new.text);
END;
CREATE TRIGGER memory_chunks_fts_delete AFTER DELETE ON memory_chunks BEGIN
  INSERT INTO memory_fts (memory_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
END;
CREATE TRIGGER memory_chunks_fts_update AFTER UPDATE OF text ON memory_chunks BEGIN
  INSERT INTO memory_fts (memory_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
  INSERT INTO memory_fts (rowid, text) VALUES (new.rowid, new.text);
END;

CREATE TABLE memory_jobs (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('flush', 'dreaming', 'reindex', 'import')),
  status TEXT NOT NULL CHECK (status IN ('running', 'ok', 'failed', 'skipped')),
  started_at TEXT NOT NULL,
  ended_at TEXT,
  summary TEXT,                                    -- counts and outcome; never remembered content
  created_at TEXT NOT NULL
);
CREATE INDEX memory_jobs_started_idx ON memory_jobs (started_at);

-- Small key/value state for the memory subsystem (pause flag, vector width).
CREATE TABLE memory_state (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL CHECK (json_valid(value)),
  updated_at TEXT NOT NULL
);
