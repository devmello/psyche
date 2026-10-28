-- Everything memory store (owner: S07, packages/memory). docs/design/everything-memory-2026.md
-- §4.3-4.7, §5.6, §6.7, §10.1, §13 EM1.
--
-- Widens graph_entities.kind (event, topic), graph_facts.attribute (life group) and
-- graph_edges.rel (family, friend, ...); adds the fact columns (subject_kind, sensitivity,
-- review, first_seen_at, last_seen_at, run_id, extractor) and the edge columns (role, review);
-- adds graph_citations, memory_runs, memory_quarantine, graph_exclusions and
-- memory_claim_subjects.
--
-- SQLite cannot change a CHECK in place, and with foreign keys on, DROP TABLE of a parent
-- cascades (or nulls) its children, so the whole graph is rebuilt in order as in
-- 202610252000_scheduler_event-triggers.sql: create the v2 tables, copy every row, drop the old
-- tables children first, rename. Existing rows keep their meaning: review = 'accepted',
-- sensitivity = 'none', subject_kind from provenance.
-- Applied inside one transaction by src/migrate.ts; do not edit once merged, add a new file.

CREATE TABLE memory_runs (
  id TEXT PRIMARY KEY NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  model TEXT,
  sources TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(sources) AND json_type(sources) = 'array'),
  items_read INTEGER NOT NULL DEFAULT 0 CHECK (items_read >= 0),
  items_filtered INTEGER NOT NULL DEFAULT 0 CHECK (items_filtered >= 0),
  batches INTEGER NOT NULL DEFAULT 0 CHECK (batches >= 0),
  tokens_in INTEGER NOT NULL DEFAULT 0 CHECK (tokens_in >= 0),
  tokens_out INTEGER NOT NULL DEFAULT 0 CHECK (tokens_out >= 0),
  facts_proposed INTEGER NOT NULL DEFAULT 0 CHECK (facts_proposed >= 0),
  facts_dropped TEXT NOT NULL DEFAULT '{}'         -- counts by reason; never text
    CHECK (json_valid(facts_dropped) AND json_type(facts_dropped) = 'object'),
  quarantined INTEGER NOT NULL DEFAULT 0 CHECK (quarantined >= 0),
  deferred INTEGER NOT NULL DEFAULT 0 CHECK (deferred >= 0),
  error TEXT
);
CREATE INDEX memory_runs_started_idx ON memory_runs (started_at);

CREATE TABLE graph_entities_v2 (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('person', 'org', 'project', 'place', 'event', 'topic')),
  name TEXT NOT NULL,
  sort_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived', 'merged')),
  merged_into TEXT REFERENCES graph_entities_v2 (id) ON DELETE SET NULL,
  is_owner INTEGER NOT NULL DEFAULT 0 CHECK (is_owner IN (0, 1)),
  pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
  hidden INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1)),
  project_status TEXT CHECK (project_status IS NULL OR project_status IN ('active', 'paused', 'done')),
  due_at TEXT,
  summary TEXT,
  summary_at TEXT,
  summary_hash TEXT,
  notes TEXT,
  last_interaction_at TEXT,
  card_path TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO graph_entities_v2 SELECT id, kind, name, sort_name, status, merged_into, is_owner,
  pinned, hidden, project_status, due_at, summary, summary_at, summary_hash, notes,
  last_interaction_at, card_path, created_at, updated_at
FROM graph_entities;

CREATE TABLE graph_identifiers_v2 (
  kind TEXT NOT NULL CHECK (kind IN ('email', 'phone', 'contact', 'channel', 'domain', 'calendar', 'url')),
  value_norm TEXT NOT NULL,
  value_display TEXT NOT NULL,
  entity_id TEXT NOT NULL REFERENCES graph_entities_v2 (id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  linked_by TEXT NOT NULL CHECK (linked_by IN ('rule', 'owner', 'model')),
  verified INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0, 1)),
  shared INTEGER NOT NULL DEFAULT 0 CHECK (shared IN (0, 1)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (kind, value_norm)
);
INSERT INTO graph_identifiers_v2 SELECT kind, value_norm, value_display, entity_id, source,
  linked_by, verified, shared, created_at
FROM graph_identifiers;

CREATE TABLE graph_aliases_v2 (
  entity_id TEXT NOT NULL REFERENCES graph_entities_v2 (id) ON DELETE CASCADE,
  alias_norm TEXT NOT NULL,
  alias TEXT NOT NULL,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (entity_id, alias_norm)
);
INSERT INTO graph_aliases_v2 SELECT entity_id, alias_norm, alias, source, created_at
FROM graph_aliases;

CREATE TABLE graph_facts_v2 (
  id TEXT PRIMARY KEY NOT NULL,
  entity_id TEXT NOT NULL REFERENCES graph_entities_v2 (id) ON DELETE CASCADE,
  attribute TEXT NOT NULL CHECK (attribute IN ('role', 'title', 'employer', 'team', 'email_pref',
    'timezone', 'city', 'birthday', 'relationship_to_owner', 'preference', 'note', 'status',
    'next_step', 'budget_note', 'deadline', 'anniversary', 'hometown', 'school', 'pronouns',
    'partner_name', 'children_names', 'pet_names', 'likes', 'dislikes', 'diet', 'gift_idea',
    'languages', 'contact_pref', 'life_event')),
  value TEXT NOT NULL,
  provenance TEXT NOT NULL CHECK (provenance IN ('owner', 'agent', 'untrusted', 'system')),
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  sources TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(sources) AND json_type(sources) = 'array'),
  evidence TEXT,
  valid_from TEXT NOT NULL,
  valid_to TEXT,
  recorded_at TEXT NOT NULL,
  superseded_by TEXT REFERENCES graph_facts_v2 (id) ON DELETE SET NULL,
  retracted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  subject_kind TEXT NOT NULL DEFAULT 'owner_stated'
    CHECK (subject_kind IN ('self_disclosure', 'about_other', 'owner_stated', 'deterministic')),
  sensitivity TEXT NOT NULL DEFAULT 'none' CHECK (sensitivity IN ('none', 'health', 'finance',
    'sexuality', 'religion', 'politics', 'ethnicity', 'legal', 'precise_location', 'gov_id',
    'account_numbers')),
  review TEXT NOT NULL DEFAULT 'accepted' CHECK (review IN ('pending', 'accepted',
    'auto_accepted', 'edited', 'discarded', 'quarantined')),
  first_seen_at TEXT,
  last_seen_at TEXT,
  run_id TEXT REFERENCES memory_runs (id) ON DELETE SET NULL,
  extractor TEXT,
  -- Government ids and account numbers are never stored (decision 5); untrusted text never
  -- becomes a trusted fact without the owner (§3.3): an untrusted row is never owner-reviewed
  -- as 'edited' (an edit rewrites provenance to owner first).
  CHECK (sensitivity NOT IN ('gov_id', 'account_numbers')),
  CHECK (NOT (provenance = 'untrusted' AND review = 'edited'))
);
INSERT INTO graph_facts_v2 (id, entity_id, attribute, value, provenance, confidence, sources,
  evidence, valid_from, valid_to, recorded_at, superseded_by, retracted_at, created_at,
  updated_at, subject_kind, first_seen_at, last_seen_at)
SELECT id, entity_id, attribute, value, provenance, confidence, sources, evidence, valid_from,
  valid_to, recorded_at, superseded_by, retracted_at, created_at, updated_at,
  CASE provenance WHEN 'untrusted' THEN 'about_other' WHEN 'system' THEN 'deterministic'
    ELSE 'owner_stated' END,
  recorded_at, updated_at
FROM graph_facts;

CREATE TABLE graph_edges_v2 (
  id TEXT PRIMARY KEY NOT NULL,
  src TEXT NOT NULL REFERENCES graph_entities_v2 (id) ON DELETE CASCADE,
  dst TEXT NOT NULL REFERENCES graph_entities_v2 (id) ON DELETE CASCADE,
  rel TEXT NOT NULL CHECK (rel IN ('works_at', 'member_of', 'stakeholder_of', 'located_at',
    'reports_to', 'related_to', 'part_of', 'family', 'friend', 'neighbour', 'classmate',
    'roommate', 'colleague', 'manager', 'client', 'vendor', 'mentor', 'studied_at', 'lives_in',
    'attended', 'about')),
  label TEXT CHECK (label IS NULL OR label IN ('partner', 'parent', 'child', 'sibling', 'friend',
    'colleague', 'manager', 'report', 'client', 'vendor', 'teacher', 'doctor', 'other')),
  provenance TEXT NOT NULL CHECK (provenance IN ('owner', 'agent', 'untrusted', 'system')),
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  sources TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(sources) AND json_type(sources) = 'array'),
  valid_from TEXT NOT NULL,
  valid_to TEXT,
  superseded_by TEXT REFERENCES graph_edges_v2 (id) ON DELETE SET NULL,
  retracted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  role TEXT CHECK (role IS NULL OR role IN ('parent', 'child', 'sibling', 'partner', 'spouse',
    'grandparent', 'grandchild', 'cousin', 'in_law', 'other')),
  review TEXT NOT NULL DEFAULT 'accepted' CHECK (review IN ('pending', 'accepted',
    'auto_accepted', 'edited', 'discarded', 'quarantined'))
);
INSERT INTO graph_edges_v2 (id, src, dst, rel, label, provenance, confidence, sources,
  valid_from, valid_to, superseded_by, retracted_at, created_at, updated_at)
SELECT id, src, dst, rel, label, provenance, confidence, sources, valid_from, valid_to,
  superseded_by, retracted_at, created_at, updated_at
FROM graph_edges;

CREATE TABLE graph_interactions_v2 (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('mail', 'message', 'meeting', 'call', 'note', 'chat', 'task')),
  source TEXT NOT NULL,
  external_ref TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('in', 'out', 'both', 'none')),
  subject TEXT,
  thread_key TEXT,
  link TEXT,
  project_id TEXT REFERENCES graph_entities_v2 (id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  UNIQUE (source, external_ref)
);
INSERT INTO graph_interactions_v2 SELECT id, kind, source, external_ref, occurred_at, direction,
  subject, thread_key, link, project_id, created_at
FROM graph_interactions;

CREATE TABLE graph_participants_v2 (
  interaction_id TEXT NOT NULL REFERENCES graph_interactions_v2 (id) ON DELETE CASCADE,
  entity_id TEXT NOT NULL REFERENCES graph_entities_v2 (id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('from', 'to', 'cc', 'attendee', 'organizer', 'mentioned')),
  PRIMARY KEY (interaction_id, entity_id, role)
);
INSERT INTO graph_participants_v2 SELECT interaction_id, entity_id, role FROM graph_participants;

CREATE TABLE graph_loops_v2 (
  id TEXT PRIMARY KEY NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('i_owe', 'waiting_on')),
  text TEXT NOT NULL,
  evidence TEXT,
  counterpart_id TEXT REFERENCES graph_entities_v2 (id) ON DELETE SET NULL,
  project_id TEXT REFERENCES graph_entities_v2 (id) ON DELETE SET NULL,
  due_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('suggested', 'open', 'snoozed', 'done', 'dismissed')),
  source_interaction_id TEXT REFERENCES graph_interactions_v2 (id) ON DELETE SET NULL,
  provenance TEXT NOT NULL CHECK (provenance IN ('owner', 'agent', 'untrusted', 'system')),
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  detected_by TEXT NOT NULL CHECK (detected_by IN ('rule', 'model', 'owner')),
  dedupe_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT,
  closed_by TEXT CHECK (closed_by IS NULL OR closed_by IN ('owner', 'reply_seen', 'due_passed'))
);
INSERT INTO graph_loops_v2 SELECT id, direction, text, evidence, counterpart_id, project_id,
  due_at, status, source_interaction_id, provenance, confidence, detected_by, dedupe_key,
  created_at, updated_at, closed_at, closed_by
FROM graph_loops;

DROP TABLE graph_loops;
DROP TABLE graph_participants;
DROP TABLE graph_interactions;
DROP TABLE graph_edges;
DROP TABLE graph_facts;
DROP TABLE graph_aliases;
DROP TABLE graph_identifiers;
DROP INDEX IF EXISTS graph_entities_owner_idx;
DROP INDEX IF EXISTS graph_entities_kind_idx;
DROP TABLE graph_entities;

ALTER TABLE graph_entities_v2 RENAME TO graph_entities;
ALTER TABLE graph_identifiers_v2 RENAME TO graph_identifiers;
ALTER TABLE graph_aliases_v2 RENAME TO graph_aliases;
ALTER TABLE graph_facts_v2 RENAME TO graph_facts;
ALTER TABLE graph_edges_v2 RENAME TO graph_edges;
ALTER TABLE graph_interactions_v2 RENAME TO graph_interactions;
ALTER TABLE graph_participants_v2 RENAME TO graph_participants;
ALTER TABLE graph_loops_v2 RENAME TO graph_loops;

CREATE UNIQUE INDEX graph_entities_owner_idx ON graph_entities (is_owner) WHERE is_owner = 1;
CREATE INDEX graph_entities_kind_idx ON graph_entities (kind, status, sort_name);
CREATE INDEX graph_identifiers_entity_idx ON graph_identifiers (entity_id);
CREATE INDEX graph_aliases_norm_idx ON graph_aliases (alias_norm);
CREATE INDEX graph_facts_entity_idx ON graph_facts (entity_id, attribute);
CREATE INDEX graph_facts_review_idx ON graph_facts (review, last_seen_at);
CREATE INDEX graph_edges_src_idx ON graph_edges (src, rel);
CREATE INDEX graph_edges_dst_idx ON graph_edges (dst, rel);
CREATE INDEX graph_interactions_time_idx ON graph_interactions (occurred_at);
CREATE INDEX graph_interactions_thread_idx ON graph_interactions (thread_key);
CREATE INDEX graph_participants_entity_idx ON graph_participants (entity_id);
CREATE INDEX graph_loops_status_idx ON graph_loops (status, direction);
CREATE INDEX graph_loops_counterpart_idx ON graph_loops (counterpart_id);
CREATE INDEX graph_loops_dedupe_idx ON graph_loops (dedupe_key);

-- Citations (§4.4): every fact, relation and event has at least one verbatim span. `target_id`
-- is polymorphic, so the triggers below delete a target's citations with it.
CREATE TABLE graph_citations (
  id TEXT PRIMARY KEY NOT NULL,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('fact', 'edge', 'event', 'entity')),
  target_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('mail', 'messages', 'notes', 'calendar', 'reminders',
    'chats', 'files', 'browser', 'transcripts', 'contacts')),
  doc_id TEXT,
  source_ref TEXT NOT NULL,
  quote TEXT NOT NULL CHECK (length(quote) <= 200),
  start INTEGER NOT NULL CHECK (start >= 0),
  "end" INTEGER NOT NULL CHECK ("end" >= start),
  source_hash TEXT NOT NULL,
  author_entity_id TEXT REFERENCES graph_entities (id) ON DELETE SET NULL,
  provenance TEXT NOT NULL CHECK (provenance IN ('owner', 'agent', 'untrusted', 'system')),
  observed_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX graph_citations_target_idx ON graph_citations (target_kind, target_id);
CREATE INDEX graph_citations_source_idx ON graph_citations (source, source_ref);
CREATE INDEX graph_citations_author_idx ON graph_citations (author_entity_id);

CREATE TRIGGER graph_facts_citations_cleanup AFTER DELETE ON graph_facts BEGIN
  DELETE FROM graph_citations WHERE target_kind = 'fact' AND target_id = old.id;
END;
CREATE TRIGGER graph_edges_citations_cleanup AFTER DELETE ON graph_edges BEGIN
  DELETE FROM graph_citations WHERE target_kind = 'edge' AND target_id = old.id;
END;
CREATE TRIGGER graph_entities_citations_cleanup AFTER DELETE ON graph_entities BEGIN
  DELETE FROM graph_citations
  WHERE (target_kind IN ('entity', 'event') AND target_id = old.id);
END;

-- Items held back from extraction (§5.6). `excerpt` is untrusted text, truncated.
CREATE TABLE memory_quarantine (
  id TEXT PRIMARY KEY NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('mail', 'messages', 'notes', 'calendar', 'reminders',
    'chats', 'files', 'browser', 'transcripts', 'contacts')),
  source_ref TEXT NOT NULL,
  sender_entity_id TEXT REFERENCES graph_entities (id) ON DELETE SET NULL,
  reasons TEXT NOT NULL CHECK (json_valid(reasons) AND json_type(reasons) = 'array'
    AND json_array_length(reasons) >= 1),
  excerpt TEXT NOT NULL CHECK (length(excerpt) <= 300),
  created_at TEXT NOT NULL,
  decided TEXT CHECK (decided IS NULL OR decided IN ('released', 'discarded', 'blocked')),
  decided_at TEXT,
  UNIQUE (source, source_ref)
);
CREATE INDEX memory_quarantine_created_idx ON memory_quarantine (created_at);

-- Per-contact exclusion (§10.1). Hashes only, like graph_blocklist: `mode` 'exclude' reads no
-- body and learns no facts but keeps headers; 'forget' also removes what was learned.
CREATE TABLE graph_exclusions (
  kind TEXT NOT NULL CHECK (kind IN ('email', 'phone', 'contact', 'channel', 'domain', 'calendar', 'url')),
  value_hash TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('exclude', 'forget')),
  hint TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (kind, value_hash)
);

-- Free-text claims linked to the entities they are about (§4.6).
CREATE TABLE memory_claim_subjects (
  claim_id TEXT NOT NULL REFERENCES memory_claims (id) ON DELETE CASCADE,
  entity_id TEXT NOT NULL REFERENCES graph_entities (id) ON DELETE CASCADE,
  PRIMARY KEY (claim_id, entity_id)
);
CREATE INDEX memory_claim_subjects_entity_idx ON memory_claim_subjects (entity_id);

-- "Never learn this" (§7.1): an attribute for one person, or from one sender. `entity_id` is the
-- person (attribute_for_entity) or the sender (attribute_from_sender).
CREATE TABLE memory_never_rules (
  kind TEXT NOT NULL CHECK (kind IN ('attribute_for_entity', 'attribute_from_sender')),
  entity_id TEXT NOT NULL REFERENCES graph_entities (id) ON DELETE CASCADE,
  attribute TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (kind, entity_id, attribute)
);
