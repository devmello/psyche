import type Database from "better-sqlite3";

/**
 * Schema of the search index. The index is derived data: it can be deleted and rebuilt from the
 * Gateway's stores at any time, so it lives in its own file (`state/search.sqlite`) and manages
 * its own schema instead of adding FTS5 shadow tables to `psyche.sqlite` (see README).
 *
 * `search_docs` holds one row per document; `search_fts` is an external-content FTS5 table over
 * it kept in sync by triggers; `search_flags` records `has:` facts (an approval on a task) that
 * may arrive before the document they describe.
 */
export const SEARCH_SCHEMA_VERSION = 1;

const DDL = `
CREATE TABLE IF NOT EXISTS search_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS search_docs (
  rowid INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  grp TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  extra TEXT NOT NULL,
  provenance TEXT NOT NULL CHECK (provenance IN ('owner', 'agent', 'untrusted', 'system')),
  thread_id TEXT,
  parent_id TEXT,
  collapse_key TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  sender TEXT,
  mime TEXT,
  tags TEXT NOT NULL CHECK (json_valid(tags)),
  source TEXT,
  created_ms INTEGER NOT NULL,
  updated_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS search_docs_thread_idx ON search_docs (thread_id);
CREATE INDEX IF NOT EXISTS search_docs_parent_idx ON search_docs (parent_id);
CREATE INDEX IF NOT EXISTS search_docs_source_idx ON search_docs (source);
CREATE INDEX IF NOT EXISTS search_docs_created_idx ON search_docs (created_ms);
CREATE TABLE IF NOT EXISTS search_flags (
  target_id TEXT NOT NULL,
  flag TEXT NOT NULL,
  PRIMARY KEY (target_id, flag)
) WITHOUT ROWID;
CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(
  title, body, extra,
  content='search_docs', content_rowid='rowid',
  tokenize='porter unicode61 remove_diacritics 2',
  prefix='2 3'
);
CREATE TRIGGER IF NOT EXISTS search_docs_ai AFTER INSERT ON search_docs BEGIN
  INSERT INTO search_fts (rowid, title, body, extra) VALUES (new.rowid, new.title, new.body, new.extra);
END;
CREATE TRIGGER IF NOT EXISTS search_docs_ad AFTER DELETE ON search_docs BEGIN
  INSERT INTO search_fts (search_fts, rowid, title, body, extra)
    VALUES ('delete', old.rowid, old.title, old.body, old.extra);
END;
CREATE TRIGGER IF NOT EXISTS search_docs_au AFTER UPDATE ON search_docs BEGIN
  INSERT INTO search_fts (search_fts, rowid, title, body, extra)
    VALUES ('delete', old.rowid, old.title, old.body, old.extra);
  INSERT INTO search_fts (rowid, title, body, extra) VALUES (new.rowid, new.title, new.body, new.extra);
END;
`;

/** Creates the tables if missing; throws when the file holds a newer schema. */
export function ensureSearchSchema(db: Database.Database): void {
  db.exec(DDL);
  const row = db.prepare("SELECT value FROM search_meta WHERE key = 'schema_version'").get() as
    | { value: string }
    | undefined;
  if (row === undefined) {
    db.prepare("INSERT INTO search_meta (key, value) VALUES ('schema_version', ?)").run(
      String(SEARCH_SCHEMA_VERSION),
    );
  } else if (Number(row.value) > SEARCH_SCHEMA_VERSION) {
    throw new Error(
      `search index schema ${row.value} is newer than this build (${SEARCH_SCHEMA_VERSION}); delete the index file to rebuild it`,
    );
  }
}
