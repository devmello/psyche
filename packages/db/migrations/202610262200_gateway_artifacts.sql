-- Canvas artifacts and their versions (docs/design/chat-experience-2026.md §4.3, §4.4). `content`
-- is the latest version's full content (text, `ArtifactTable` JSON, or a Library path for
-- images); older versions are rebuilt from the nearest snapshot plus the ops after it. Version 1
-- is always a snapshot. History is never deleted: there is no delete for either table.
-- `library_item_id` is the Library row the latest content is mirrored to (kind 'artifact').
CREATE TABLE artifacts (
  id TEXT PRIMARY KEY NOT NULL,
  library_item_id TEXT NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  name_slug TEXT NOT NULL,
  language TEXT,
  thread_id TEXT,
  untrusted INTEGER NOT NULL DEFAULT 0 CHECK (untrusted IN (0, 1)),
  version INTEGER NOT NULL CHECK (version >= 1),
  content TEXT NOT NULL,
  view TEXT CHECK (view IS NULL OR json_valid(view)),
  bytes INTEGER NOT NULL CHECK (bytes >= 0),
  hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX artifacts_updated_idx ON artifacts (updated_at DESC, id DESC);
CREATE INDEX artifacts_thread_idx ON artifacts (thread_id, updated_at DESC);

CREATE TABLE artifact_versions (
  artifact_id TEXT NOT NULL REFERENCES artifacts (id),
  version INTEGER NOT NULL CHECK (version >= 1),
  author TEXT NOT NULL CHECK (author IN ('agent', 'user', 'specialist')),
  kind TEXT NOT NULL CHECK (kind IN ('snapshot', 'ops')),
  ops TEXT CHECK (ops IS NULL OR (json_valid(ops) AND json_type(ops) = 'array')),
  snapshot TEXT,
  view TEXT CHECK (view IS NULL OR json_valid(view)),
  bytes INTEGER NOT NULL CHECK (bytes >= 0),
  hash TEXT NOT NULL,
  summary TEXT NOT NULL,
  run_id TEXT,
  tool_call_id TEXT,
  restored_from INTEGER,
  created_at TEXT NOT NULL,
  PRIMARY KEY (artifact_id, version),
  CHECK (kind = 'ops' OR snapshot IS NOT NULL)
);
