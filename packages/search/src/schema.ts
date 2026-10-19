import type Database from "better-sqlite3";

/**
 * Schema of the search index (unstemmed `unicode61` tokens with diacritics folded; prefix
 * queries do the work stemming would). The index is derived data: it can be deleted and rebuilt from the
 * Gateway's stores at any time, so it lives in its own file (`state/search.sqlite`) and manages
 * its own schema instead of adding FTS5 shadow tables to `psyche.sqlite` (see README).
 *
 * `search_docs` holds one row per document; `search_fts` is an external-content FTS5 table over
 * it kept in sync by triggers; `search_flags` records `has:` facts (an approval on a task) that
 * may arrive before the document they describe.
 */
export const SEARCH_SCHEMA_VERSION = 2;

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
  sender_key TEXT,                                 -- NFC + Unicode lower case, for from:
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
  tokenize='unicode61 remove_diacritics 2',
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

const DROP = `
DROP TRIGGER IF EXISTS search_docs_ai;
DROP TRIGGER IF EXISTS search_docs_ad;
DROP TRIGGER IF EXISTS search_docs_au;
DROP TABLE IF EXISTS search_fts;
DROP TABLE IF EXISTS search_flags;
DROP TABLE IF EXISTS search_docs;
DROP TABLE IF EXISTS search_meta;
`;

/**
 * Creates the tables if missing. An index from an older build is dropped and recreated (it is
 * derived data; the caller backfills); a newer one is refused.
 */
export function ensureSearchSchema(db: Database.Database): void {
  const hasMeta = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'search_meta'")
    .get();
  const row = hasMeta
    ? (db.prepare("SELECT value FROM search_meta WHERE key = 'schema_version'").get() as
        | { value: string }
        | undefined)
    : undefined;
  const version = row === undefined ? undefined : Number(row.value);
  if (version !== undefined && version > SEARCH_SCHEMA_VERSION) {
    throw new Error(
      `search index schema ${version} is newer than this build (${SEARCH_SCHEMA_VERSION}); delete the index file to rebuild it`,
    );
  }
  if (version !== undefined && version < SEARCH_SCHEMA_VERSION) db.exec(DROP);
  db.exec(DDL);
  db.prepare(
    "INSERT INTO search_meta (key, value) VALUES ('schema_version', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
  ).run(String(SEARCH_SCHEMA_VERSION));
}

/** True when the index was just created or rebuilt and the caller should backfill it. */
export function searchIndexIsEmpty(db: Database.Database): boolean {
  return db.prepare("SELECT 1 FROM search_docs LIMIT 1").get() === undefined;
}
