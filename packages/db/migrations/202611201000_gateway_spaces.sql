-- Spaces (docs/design/spaces-2026.md §4.1): lasting workspaces that tie folders, links, chats,
-- automations and a tracker shelf together with one id. Additive: only new tables and two nullable
-- columns. A Space is a container, not a store.
CREATE TABLE spaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  description TEXT CHECK (description IS NULL OR length(description) <= 160),
  icon TEXT,
  instructions TEXT NOT NULL DEFAULT '' CHECK (length(instructions) <= 4000),
  entity_id TEXT,
  default_permission_mode TEXT,
  connector_scope TEXT,
  private INTEGER NOT NULL DEFAULT 0,
  sort INTEGER NOT NULL,
  archived_at TEXT,
  created_from TEXT NOT NULL CHECK (created_from IN ('owner', 'proposal', 'project', 'migration')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  instructions_rev INTEGER NOT NULL DEFAULT 1,
  -- Automations the archive paused (JSON array of ids), so restoring resumes only those.
  paused_automation_ids TEXT
);
CREATE UNIQUE INDEX spaces_entity ON spaces (entity_id) WHERE entity_id IS NOT NULL;

CREATE TABLE space_folders (
  space_id TEXT NOT NULL REFERENCES spaces (id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  real TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('ro', 'rw')),
  automations_write INTEGER NOT NULL DEFAULT 0,
  added_at TEXT NOT NULL,
  added_by_device TEXT,
  PRIMARY KEY (space_id, path)
);

CREATE TABLE space_links (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces (id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('url', 'library_item', 'note', 'mail_thread', 'file')),
  ref TEXT NOT NULL,
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 120),
  label_provenance TEXT NOT NULL CHECK (label_provenance IN ('owner', 'agent', 'untrusted')),
  added_by TEXT NOT NULL CHECK (added_by IN ('owner', 'agent')),
  created_at TEXT NOT NULL,
  UNIQUE (space_id, kind, ref)
);

CREATE TABLE space_trackers (
  space_id TEXT NOT NULL REFERENCES spaces (id) ON DELETE CASCADE,
  widget_id TEXT NOT NULL UNIQUE REFERENCES widgets (id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('bound', 'query', 'agent')),
  refresh TEXT,
  stale_after_s INTEGER,
  refreshed_at TEXT,
  added_by TEXT NOT NULL CHECK (added_by IN ('owner', 'agent', 'template')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (space_id, widget_id)
);

CREATE TABLE space_proposals (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  reason TEXT NOT NULL,
  entity_id TEXT,
  thread_ids TEXT NOT NULL,
  taint TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'accepted', 'dismissed')),
  created_at TEXT NOT NULL,
  decided_at TEXT
);

ALTER TABLE threads ADD COLUMN space_id TEXT REFERENCES spaces (id) ON DELETE SET NULL;
ALTER TABLE automations ADD COLUMN space_id TEXT REFERENCES spaces (id) ON DELETE SET NULL;
CREATE INDEX threads_space ON threads (space_id) WHERE space_id IS NOT NULL;
CREATE INDEX automations_space ON automations (space_id) WHERE space_id IS NOT NULL;
