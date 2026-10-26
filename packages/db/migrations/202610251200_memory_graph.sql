-- People and projects memory graph (owner: S07, packages/memory). docs/memory/people-and-projects-2026.md
-- §4. Entities, identifiers (merge keys), aliases, facts and relations from allowlists with
-- provenance and validity, interactions as pointers (headers and links, never bodies), open
-- loops, suggestions, the owner's corrections, the forget blocklist and ingest cursors.
-- Applied inside one transaction by src/migrate.ts; do not edit once merged, add a new file.

CREATE TABLE graph_entities (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('person', 'org', 'project', 'place')),
  name TEXT NOT NULL,
  sort_name TEXT NOT NULL,                         -- lower-cased, accents folded
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived', 'merged')),
  merged_into TEXT REFERENCES graph_entities (id) ON DELETE SET NULL,
  is_owner INTEGER NOT NULL DEFAULT 0 CHECK (is_owner IN (0, 1)),
  pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
  hidden INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1)),
  project_status TEXT CHECK (project_status IS NULL OR project_status IN ('active', 'paused', 'done')),
  due_at TEXT,
  summary TEXT,                                    -- model-written, agent provenance
  summary_at TEXT,
  summary_hash TEXT,                               -- input hash of the last model pass (skip unchanged)
  notes TEXT,                                      -- the owner's Notes section, stored verbatim
  last_interaction_at TEXT,
  card_path TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX graph_entities_owner_idx ON graph_entities (is_owner) WHERE is_owner = 1;
CREATE INDEX graph_entities_kind_idx ON graph_entities (kind, status, sort_name);

CREATE TABLE graph_identifiers (
  kind TEXT NOT NULL CHECK (kind IN ('email', 'phone', 'contact', 'channel', 'domain', 'calendar', 'url')),
  value_norm TEXT NOT NULL,
  value_display TEXT NOT NULL,
  entity_id TEXT NOT NULL REFERENCES graph_entities (id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  linked_by TEXT NOT NULL CHECK (linked_by IN ('rule', 'owner', 'model')),
  verified INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0, 1)),
  shared INTEGER NOT NULL DEFAULT 0 CHECK (shared IN (0, 1)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (kind, value_norm)
);
CREATE INDEX graph_identifiers_entity_idx ON graph_identifiers (entity_id);

CREATE TABLE graph_aliases (
  entity_id TEXT NOT NULL REFERENCES graph_entities (id) ON DELETE CASCADE,
  alias_norm TEXT NOT NULL,
  alias TEXT NOT NULL,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (entity_id, alias_norm)
);
CREATE INDEX graph_aliases_norm_idx ON graph_aliases (alias_norm);

CREATE TABLE graph_facts (
  id TEXT PRIMARY KEY NOT NULL,
  entity_id TEXT NOT NULL REFERENCES graph_entities (id) ON DELETE CASCADE,
  attribute TEXT NOT NULL CHECK (attribute IN ('role', 'title', 'employer', 'team', 'email_pref',
    'timezone', 'city', 'birthday', 'relationship_to_owner', 'preference', 'note', 'status',
    'next_step', 'budget_note', 'deadline')),
  value TEXT NOT NULL,
  provenance TEXT NOT NULL CHECK (provenance IN ('owner', 'agent', 'untrusted', 'system')),
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  sources TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(sources) AND json_type(sources) = 'array'),
  evidence TEXT,
  valid_from TEXT NOT NULL,
  valid_to TEXT,
  recorded_at TEXT NOT NULL,
  superseded_by TEXT REFERENCES graph_facts (id) ON DELETE SET NULL,
  retracted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX graph_facts_entity_idx ON graph_facts (entity_id, attribute);

CREATE TABLE graph_edges (
  id TEXT PRIMARY KEY NOT NULL,
  src TEXT NOT NULL REFERENCES graph_entities (id) ON DELETE CASCADE,
  dst TEXT NOT NULL REFERENCES graph_entities (id) ON DELETE CASCADE,
  rel TEXT NOT NULL CHECK (rel IN ('works_at', 'member_of', 'stakeholder_of', 'located_at',
    'reports_to', 'related_to', 'part_of')),
  label TEXT CHECK (label IS NULL OR label IN ('partner', 'parent', 'child', 'sibling', 'friend',
    'colleague', 'manager', 'report', 'client', 'vendor', 'teacher', 'doctor', 'other')),
  provenance TEXT NOT NULL CHECK (provenance IN ('owner', 'agent', 'untrusted', 'system')),
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  sources TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(sources) AND json_type(sources) = 'array'),
  valid_from TEXT NOT NULL,
  valid_to TEXT,
  superseded_by TEXT REFERENCES graph_edges (id) ON DELETE SET NULL,
  retracted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX graph_edges_src_idx ON graph_edges (src, rel);
CREATE INDEX graph_edges_dst_idx ON graph_edges (dst, rel);

CREATE TABLE graph_interactions (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('mail', 'message', 'meeting', 'call', 'note', 'chat', 'task')),
  source TEXT NOT NULL,                            -- connector id
  external_ref TEXT NOT NULL,                      -- Message-ID, event id, chat guid + day
  occurred_at TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('in', 'out', 'both', 'none')),
  subject TEXT,                                    -- untrusted, ≤ 200 characters
  thread_key TEXT,
  link TEXT,
  project_id TEXT REFERENCES graph_entities (id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  UNIQUE (source, external_ref)
);
CREATE INDEX graph_interactions_time_idx ON graph_interactions (occurred_at);
CREATE INDEX graph_interactions_thread_idx ON graph_interactions (thread_key);

CREATE TABLE graph_participants (
  interaction_id TEXT NOT NULL REFERENCES graph_interactions (id) ON DELETE CASCADE,
  entity_id TEXT NOT NULL REFERENCES graph_entities (id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('from', 'to', 'cc', 'attendee', 'organizer', 'mentioned')),
  PRIMARY KEY (interaction_id, entity_id, role)
);
CREATE INDEX graph_participants_entity_idx ON graph_participants (entity_id);

CREATE TABLE graph_loops (
  id TEXT PRIMARY KEY NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('i_owe', 'waiting_on')),
  text TEXT NOT NULL,
  evidence TEXT,
  counterpart_id TEXT REFERENCES graph_entities (id) ON DELETE SET NULL,
  project_id TEXT REFERENCES graph_entities (id) ON DELETE SET NULL,
  due_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('suggested', 'open', 'snoozed', 'done', 'dismissed')),
  source_interaction_id TEXT REFERENCES graph_interactions (id) ON DELETE SET NULL,
  provenance TEXT NOT NULL CHECK (provenance IN ('owner', 'agent', 'untrusted', 'system')),
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  detected_by TEXT NOT NULL CHECK (detected_by IN ('rule', 'model', 'owner')),
  dedupe_key TEXT NOT NULL,                        -- direction + counterpart + normalized text
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT,
  closed_by TEXT CHECK (closed_by IS NULL OR closed_by IN ('owner', 'reply_seen', 'due_passed'))
);
CREATE INDEX graph_loops_status_idx ON graph_loops (status, direction);
CREATE INDEX graph_loops_counterpart_idx ON graph_loops (counterpart_id);
CREATE INDEX graph_loops_dedupe_idx ON graph_loops (dedupe_key);

CREATE TABLE graph_suggestions (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('merge', 'project')),
  entity_ids TEXT NOT NULL CHECK (json_valid(entity_ids) AND json_type(entity_ids) = 'array'),
  name TEXT,
  reason TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'rejected', 'later')),
  key_hash TEXT NOT NULL UNIQUE,                   -- the same suggestion is never made twice
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- The owner's corrections (§5.4). key_hash never holds third-party text.
CREATE TABLE graph_feedback (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('wrong_fact', 'wrong_edge', 'merge', 'do_not_merge',
    'not_project', 'dismissed_loop', 'rename')),
  entity_id TEXT,
  other_id TEXT,
  key_hash TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX graph_feedback_entity_idx ON graph_feedback (entity_id, kind);

-- Forgotten or hidden identifiers, stored as hashes; ingest never recreates them.
CREATE TABLE graph_blocklist (
  kind TEXT NOT NULL,
  value_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (kind, value_hash)
);

CREATE TABLE graph_cursors (
  source TEXT PRIMARY KEY NOT NULL,
  cursor TEXT NOT NULL CHECK (json_valid(cursor)),
  updated_at TEXT NOT NULL
);

CREATE VIRTUAL TABLE graph_fts USING fts5(
  entity_id UNINDEXED,
  name,
  aliases,
  facts,
  summary,
  tokenize = 'unicode61 remove_diacritics 2'
);
