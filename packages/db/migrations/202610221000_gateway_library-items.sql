-- P4: the Library index (data model §9). Files live under `$PSYCHE_HOME/library`; `path` is
-- relative to that folder (unique: one row per stored file or recording folder). Writers (channel
-- attachments, browser downloads and recordings, read-aloud clips and voice memos) insert a row
-- for everything they save; `library.delete` removes the file and the row. `thread_id` and
-- `task_id` are plain TEXT: an item outlives the thread or task that produced it. `source` is
-- the writer's provenance detail (channel message, download URL), never shown to the model.
CREATE TABLE library_items (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('document', 'image', 'audio', 'video', 'artifact', 'download', 'recording', 'system')),
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE CHECK (path <> '' AND substr(path, 1, 1) <> '/'),
  size INTEGER NOT NULL CHECK (size >= 0),
  sha256 TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('upload', 'agent', 'download', 'connector', 'channel')),
  thread_id TEXT,
  task_id TEXT,
  tags TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags) AND json_type(tags) = 'array'),
  text_extract_ref TEXT,
  quarantined INTEGER NOT NULL DEFAULT 0 CHECK (quarantined IN (0, 1)),
  source TEXT CHECK (source IS NULL OR json_valid(source)),
  created_at TEXT NOT NULL
);
CREATE INDEX library_items_created_idx ON library_items (created_at DESC, id DESC);
CREATE INDEX library_items_thread_idx ON library_items (thread_id);
CREATE INDEX library_items_task_idx ON library_items (task_id);
