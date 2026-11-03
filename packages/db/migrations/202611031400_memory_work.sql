-- Memory for everything: work (owner: S07, packages/memory). docs/design/memory-everything-2026.md
-- §2.2-2.6, §2.8, §8 MW2.
--
-- Widens graph_entities.kind (assignment) and adds project_type, work_status, last_signal_at and
-- private; widens graph_facts.attribute (progress, stopped_at, blocked_on, course_code, term,
-- meets), graph_edges.rel (assigned_by, teaches), graph_interactions.kind (file, reminder,
-- work), graph_citations.target_kind (interaction) and graph_suggestions.kind (assignment);
-- adds graph_interactions.gist, graph_suggestions.project_type / due_at, graph_anchors and
-- graph_interaction_subjects.
--
-- SQLite cannot change a CHECK in place, and with foreign keys on, DROP TABLE of a parent
-- cascades (or nulls) its children, so everything that references graph_entities, graph_facts
-- or graph_interactions is rebuilt in order as in 202610281200_memory_everything.sql: create
-- the v2 tables, copy every row, drop the old tables children first, rename. Existing rows keep
-- their meaning: a project stays a plain project, nothing is private, no interaction has a gist.
-- Applied inside one transaction by src/migrate.ts; do not edit once merged, add a new file.

CREATE TABLE graph_entities_v2 (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('person', 'org', 'project', 'place', 'event', 'topic', 'assignment')),
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
  updated_at TEXT NOT NULL,
  -- Cached from the work facts (§2.3); the facts stay the record.
  project_type TEXT NOT NULL DEFAULT 'project' CHECK (project_type IN ('project', 'course')),
  work_status TEXT CHECK (work_status IS NULL OR work_status IN ('not_started', 'in_progress',
    'submitted', 'done', 'dropped')),
  last_signal_at TEXT,
  private INTEGER NOT NULL DEFAULT 0 CHECK (private IN (0, 1)),
  CHECK (project_type = 'project' OR kind = 'project'),
  CHECK (work_status IS NULL OR kind = 'assignment')
);
INSERT INTO graph_entities_v2 (id, kind, name, sort_name, status, merged_into, is_owner, pinned,
  hidden, project_status, due_at, summary, summary_at, summary_hash, notes, last_interaction_at,
  card_path, created_at, updated_at)
SELECT id, kind, name, sort_name, status, merged_into, is_owner, pinned, hidden, project_status,
  due_at, summary, summary_at, summary_hash, notes, last_interaction_at, card_path, created_at,
  updated_at
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
INSERT INTO graph_identifiers_v2 (kind, value_norm, value_display, entity_id, source, linked_by,
  verified, shared, created_at)
SELECT kind, value_norm, value_display, entity_id, source, linked_by, verified, shared, created_at
FROM graph_identifiers;

CREATE TABLE graph_aliases_v2 (
  entity_id TEXT NOT NULL REFERENCES graph_entities_v2 (id) ON DELETE CASCADE,
  alias_norm TEXT NOT NULL,
  alias TEXT NOT NULL,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (entity_id, alias_norm)
);
INSERT INTO graph_aliases_v2 (entity_id, alias_norm, alias, source, created_at)
SELECT entity_id, alias_norm, alias, source, created_at FROM graph_aliases;

CREATE TABLE graph_facts_v2 (
  id TEXT PRIMARY KEY NOT NULL,
  entity_id TEXT NOT NULL REFERENCES graph_entities_v2 (id) ON DELETE CASCADE,
  attribute TEXT NOT NULL CHECK (attribute IN ('role', 'title', 'employer', 'team', 'email_pref',
    'timezone', 'city', 'birthday', 'relationship_to_owner', 'preference', 'note', 'status',
    'next_step', 'budget_note', 'deadline', 'anniversary', 'hometown', 'school', 'pronouns',
    'partner_name', 'children_names', 'pet_names', 'likes', 'dislikes', 'diet', 'gift_idea',
    'languages', 'contact_pref', 'life_event', 'progress', 'stopped_at', 'blocked_on',
    'course_code', 'term', 'meets')),
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
  CHECK (sensitivity NOT IN ('gov_id', 'account_numbers')),
  CHECK (NOT (provenance = 'untrusted' AND review = 'edited'))
);
INSERT INTO graph_facts_v2 (id, entity_id, attribute, value, provenance, confidence, sources,
  evidence, valid_from, valid_to, recorded_at, superseded_by, retracted_at, created_at,
  updated_at, subject_kind, sensitivity, review, first_seen_at, last_seen_at, run_id, extractor)
SELECT id, entity_id, attribute, value, provenance, confidence, sources, evidence, valid_from,
  valid_to, recorded_at, superseded_by, retracted_at, created_at, updated_at, subject_kind,
  sensitivity, review, first_seen_at, last_seen_at, run_id, extractor
FROM graph_facts;

CREATE TABLE graph_edges_v2 (
  id TEXT PRIMARY KEY NOT NULL,
  src TEXT NOT NULL REFERENCES graph_entities_v2 (id) ON DELETE CASCADE,
  dst TEXT NOT NULL REFERENCES graph_entities_v2 (id) ON DELETE CASCADE,
  rel TEXT NOT NULL CHECK (rel IN ('works_at', 'member_of', 'stakeholder_of', 'located_at',
    'reports_to', 'related_to', 'part_of', 'family', 'friend', 'neighbour', 'classmate',
    'roommate', 'colleague', 'manager', 'client', 'vendor', 'mentor', 'studied_at', 'lives_in',
    'attended', 'about', 'assigned_by', 'teaches')),
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
  valid_from, valid_to, superseded_by, retracted_at, created_at, updated_at, role, review)
SELECT id, src, dst, rel, label, provenance, confidence, sources, valid_from, valid_to,
  superseded_by, retracted_at, created_at, updated_at, role, review
FROM graph_edges;

CREATE TABLE graph_interactions_v2 (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('mail', 'message', 'meeting', 'call', 'note', 'chat', 'task',
    'file', 'reminder', 'work')),
  source TEXT NOT NULL,
  external_ref TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('in', 'out', 'both', 'none')),
  subject TEXT,
  thread_key TEXT,
  link TEXT,
  project_id TEXT REFERENCES graph_entities_v2 (id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  -- One line on what a conversation was about (§2.6); written by the nightly pass.
  gist TEXT CHECK (gist IS NULL OR length(gist) <= 120),
  UNIQUE (source, external_ref)
);
INSERT INTO graph_interactions_v2 (id, kind, source, external_ref, occurred_at, direction,
  subject, thread_key, link, project_id, created_at)
SELECT id, kind, source, external_ref, occurred_at, direction, subject, thread_key, link,
  project_id, created_at
FROM graph_interactions;

CREATE TABLE graph_participants_v2 (
  interaction_id TEXT NOT NULL REFERENCES graph_interactions_v2 (id) ON DELETE CASCADE,
  entity_id TEXT NOT NULL REFERENCES graph_entities_v2 (id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('from', 'to', 'cc', 'attendee', 'organizer', 'mentioned')),
  PRIMARY KEY (interaction_id, entity_id, role)
);
INSERT INTO graph_participants_v2 (interaction_id, entity_id, role)
SELECT interaction_id, entity_id, role FROM graph_participants;

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
INSERT INTO graph_loops_v2 (id, direction, text, evidence, counterpart_id, project_id, due_at,
  status, source_interaction_id, provenance, confidence, detected_by, dedupe_key, created_at,
  updated_at, closed_at, closed_by)
SELECT id, direction, text, evidence, counterpart_id, project_id, due_at, status,
  source_interaction_id, provenance, confidence, detected_by, dedupe_key, created_at, updated_at,
  closed_at, closed_by
FROM graph_loops;

CREATE TABLE graph_citations_v2 (
  id TEXT PRIMARY KEY NOT NULL,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('fact', 'edge', 'event', 'entity', 'interaction')),
  target_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('mail', 'messages', 'notes', 'calendar', 'reminders',
    'chats', 'files', 'browser', 'transcripts', 'contacts')),
  doc_id TEXT,
  source_ref TEXT NOT NULL,
  quote TEXT NOT NULL CHECK (length(quote) <= 200),
  start INTEGER NOT NULL CHECK (start >= 0),
  "end" INTEGER NOT NULL CHECK ("end" >= start),
  source_hash TEXT NOT NULL,
  author_entity_id TEXT REFERENCES graph_entities_v2 (id) ON DELETE SET NULL,
  provenance TEXT NOT NULL CHECK (provenance IN ('owner', 'agent', 'untrusted', 'system')),
  observed_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
INSERT INTO graph_citations_v2 (id, target_kind, target_id, source, doc_id, source_ref, quote,
  start, "end", source_hash, author_entity_id, provenance, observed_at, created_at)
SELECT id, target_kind, target_id, source, doc_id, source_ref, quote, start, "end", source_hash,
  author_entity_id, provenance, observed_at, created_at
FROM graph_citations;

CREATE TABLE memory_quarantine_v2 (
  id TEXT PRIMARY KEY NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('mail', 'messages', 'notes', 'calendar', 'reminders',
    'chats', 'files', 'browser', 'transcripts', 'contacts')),
  source_ref TEXT NOT NULL,
  sender_entity_id TEXT REFERENCES graph_entities_v2 (id) ON DELETE SET NULL,
  reasons TEXT NOT NULL CHECK (json_valid(reasons) AND json_type(reasons) = 'array'
    AND json_array_length(reasons) >= 1),
  excerpt TEXT NOT NULL CHECK (length(excerpt) <= 300),
  created_at TEXT NOT NULL,
  decided TEXT CHECK (decided IS NULL OR decided IN ('released', 'discarded', 'blocked')),
  decided_at TEXT,
  UNIQUE (source, source_ref)
);
INSERT INTO memory_quarantine_v2 (id, source, source_ref, sender_entity_id, reasons, excerpt,
  created_at, decided, decided_at)
SELECT id, source, source_ref, sender_entity_id, reasons, excerpt, created_at, decided, decided_at
FROM memory_quarantine;

CREATE TABLE memory_claim_subjects_v2 (
  claim_id TEXT NOT NULL REFERENCES memory_claims (id) ON DELETE CASCADE,
  entity_id TEXT NOT NULL REFERENCES graph_entities_v2 (id) ON DELETE CASCADE,
  PRIMARY KEY (claim_id, entity_id)
);
INSERT INTO memory_claim_subjects_v2 (claim_id, entity_id)
SELECT claim_id, entity_id FROM memory_claim_subjects;

CREATE TABLE memory_never_rules_v2 (
  kind TEXT NOT NULL CHECK (kind IN ('attribute_for_entity', 'attribute_from_sender')),
  entity_id TEXT NOT NULL REFERENCES graph_entities_v2 (id) ON DELETE CASCADE,
  attribute TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (kind, entity_id, attribute)
);
INSERT INTO memory_never_rules_v2 (kind, entity_id, attribute, created_at)
SELECT kind, entity_id, attribute, created_at FROM memory_never_rules;

CREATE TABLE memory_trusted_senders_v2 (
  entity_id TEXT PRIMARY KEY NOT NULL REFERENCES graph_entities_v2 (id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN ('trusted', 'declined')),
  decided_at TEXT NOT NULL
);
INSERT INTO memory_trusted_senders_v2 (entity_id, state, decided_at)
SELECT entity_id, state, decided_at FROM memory_trusted_senders;

CREATE TABLE graph_fact_vectors_v2 (
  fact_id TEXT NOT NULL REFERENCES graph_facts_v2 (id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  text_hash TEXT NOT NULL,
  dims INTEGER NOT NULL,
  vector BLOB NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (fact_id, model)
);
INSERT INTO graph_fact_vectors_v2 (fact_id, model, text_hash, dims, vector, created_at)
SELECT fact_id, model, text_hash, dims, vector, created_at FROM graph_fact_vectors;

-- Suggestions reference no table; a course is a project suggestion with a type, and an
-- assignment suggestion carries the due date it was read from (untrusted text, §3.2).
CREATE TABLE graph_suggestions_v2 (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('merge', 'project', 'assignment')),
  entity_ids TEXT NOT NULL CHECK (json_valid(entity_ids) AND json_type(entity_ids) = 'array'),
  name TEXT,
  reason TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'rejected', 'later')),
  key_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  project_type TEXT CHECK (project_type IS NULL OR project_type IN ('project', 'course')),
  due_at TEXT
);
INSERT INTO graph_suggestions_v2 (id, kind, entity_ids, name, reason, status, key_hash,
  created_at, updated_at)
SELECT id, kind, entity_ids, name, reason, status, key_hash, created_at, updated_at
FROM graph_suggestions;

DROP TABLE graph_fact_vectors;
DROP TABLE memory_trusted_senders;
DROP TABLE memory_never_rules;
DROP TABLE memory_claim_subjects;
DROP TABLE memory_quarantine;
DROP TABLE graph_citations;
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
DROP TABLE graph_suggestions;

ALTER TABLE graph_entities_v2 RENAME TO graph_entities;
ALTER TABLE graph_identifiers_v2 RENAME TO graph_identifiers;
ALTER TABLE graph_aliases_v2 RENAME TO graph_aliases;
ALTER TABLE graph_facts_v2 RENAME TO graph_facts;
ALTER TABLE graph_edges_v2 RENAME TO graph_edges;
ALTER TABLE graph_interactions_v2 RENAME TO graph_interactions;
ALTER TABLE graph_participants_v2 RENAME TO graph_participants;
ALTER TABLE graph_loops_v2 RENAME TO graph_loops;
ALTER TABLE graph_citations_v2 RENAME TO graph_citations;
ALTER TABLE memory_quarantine_v2 RENAME TO memory_quarantine;
ALTER TABLE memory_claim_subjects_v2 RENAME TO memory_claim_subjects;
ALTER TABLE memory_never_rules_v2 RENAME TO memory_never_rules;
ALTER TABLE memory_trusted_senders_v2 RENAME TO memory_trusted_senders;
ALTER TABLE graph_fact_vectors_v2 RENAME TO graph_fact_vectors;
ALTER TABLE graph_suggestions_v2 RENAME TO graph_suggestions;

CREATE UNIQUE INDEX graph_entities_owner_idx ON graph_entities (is_owner) WHERE is_owner = 1;
CREATE INDEX graph_entities_kind_idx ON graph_entities (kind, status, sort_name);
-- Catch-up reads open work by due date and by last signal (§2.8); nothing is held in memory.
CREATE INDEX graph_entities_due_idx ON graph_entities (due_at) WHERE due_at IS NOT NULL;
CREATE INDEX graph_entities_signal_idx ON graph_entities (last_signal_at)
  WHERE last_signal_at IS NOT NULL;
CREATE INDEX graph_identifiers_entity_idx ON graph_identifiers (entity_id);
CREATE INDEX graph_aliases_norm_idx ON graph_aliases (alias_norm);
CREATE INDEX graph_facts_entity_idx ON graph_facts (entity_id, attribute);
CREATE INDEX graph_facts_review_idx ON graph_facts (review, last_seen_at);
CREATE INDEX graph_edges_src_idx ON graph_edges (src, rel);
CREATE INDEX graph_edges_dst_idx ON graph_edges (dst, rel);
CREATE INDEX graph_interactions_time_idx ON graph_interactions (occurred_at);
CREATE INDEX graph_interactions_thread_idx ON graph_interactions (thread_key);
CREATE INDEX graph_interactions_project_idx ON graph_interactions (project_id, occurred_at);
CREATE INDEX graph_participants_entity_idx ON graph_participants (entity_id);
CREATE INDEX graph_loops_status_idx ON graph_loops (status, direction);
CREATE INDEX graph_loops_counterpart_idx ON graph_loops (counterpart_id);
CREATE INDEX graph_loops_dedupe_idx ON graph_loops (dedupe_key);
CREATE INDEX graph_citations_target_idx ON graph_citations (target_kind, target_id);
CREATE INDEX graph_citations_source_idx ON graph_citations (source, source_ref);
CREATE INDEX graph_citations_author_idx ON graph_citations (author_entity_id);
CREATE INDEX memory_quarantine_created_idx ON memory_quarantine (created_at);
CREATE INDEX memory_claim_subjects_entity_idx ON memory_claim_subjects (entity_id);

-- Citations are polymorphic, so a deleted target takes its citations with it (§4.4).
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
CREATE TRIGGER graph_interactions_citations_cleanup AFTER DELETE ON graph_interactions BEGIN
  DELETE FROM graph_citations WHERE target_kind = 'interaction' AND target_id = old.id;
END;

-- Anchors (§2.5): "signals from here belong to this item". Not identifiers: one source may
-- anchor several items, and the most specific wins. Only owner and rule anchors route signals;
-- a model anchor is a suggestion until the owner confirms it.
CREATE TABLE graph_anchors (
  id TEXT PRIMARY KEY NOT NULL,
  entity_id TEXT NOT NULL REFERENCES graph_entities (id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('folder', 'file', 'mail_thread', 'calendar_series',
    'calendar', 'reminder_list', 'reminder', 'note', 'note_folder', 'chat_thread', 'library_item',
    'repo')),
  ref TEXT NOT NULL CHECK (length(ref) >= 1 AND length(ref) <= 1024),
  label TEXT NOT NULL DEFAULT '' CHECK (length(label) <= 200),
  added_by TEXT NOT NULL CHECK (added_by IN ('owner', 'rule', 'model')),
  confirmed INTEGER NOT NULL DEFAULT 0 CHECK (confirmed IN (0, 1)),
  created_at TEXT NOT NULL,
  UNIQUE (entity_id, kind, ref),
  CHECK (added_by = 'model' OR confirmed = 1)
);
CREATE INDEX graph_anchors_ref_idx ON graph_anchors (kind, ref);

-- One interaction can belong to several items, e.g. a mail to both the course and the
-- assignment (§2.6). graph_interactions.project_id stays and is still written for projects.
CREATE TABLE graph_interaction_subjects (
  interaction_id TEXT NOT NULL REFERENCES graph_interactions (id) ON DELETE CASCADE,
  entity_id TEXT NOT NULL REFERENCES graph_entities (id) ON DELETE CASCADE,
  linked_by TEXT NOT NULL CHECK (linked_by IN ('rule', 'owner', 'model')),
  confidence REAL NOT NULL DEFAULT 1 CHECK (confidence >= 0 AND confidence <= 1),
  created_at TEXT NOT NULL,
  PRIMARY KEY (interaction_id, entity_id)
);
CREATE INDEX graph_interaction_subjects_entity_idx ON graph_interaction_subjects (entity_id);
