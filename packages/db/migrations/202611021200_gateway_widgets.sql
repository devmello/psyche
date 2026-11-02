-- Generative UI widgets (docs/design/generative-ui-2026.md §5.1). Only the latest snapshot is kept
-- (D7); the transcript holds a `ui` block that points here by id.
CREATE TABLE widgets (
  id TEXT PRIMARY KEY NOT NULL,
  thread_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  rev INTEGER NOT NULL CHECK (rev >= 1),
  spec TEXT NOT NULL CHECK (json_valid(spec) AND json_type(spec) = 'object'),
  taint TEXT NOT NULL CHECK (json_valid(taint) AND json_type(taint) = 'array'),
  owner TEXT NOT NULL CHECK (json_valid(owner) AND json_type(owner) = 'object'),
  state TEXT NOT NULL CHECK (state IN ('live', 'frozen')),
  pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX widgets_thread_idx ON widgets (thread_id, updated_at);
CREATE INDEX widgets_message_idx ON widgets (message_id);
CREATE INDEX widgets_pinned_idx ON widgets (updated_at) WHERE pinned = 1;
