-- migrate: foreign_keys=off
-- Promise ledger (docs/design/promise-ledger-2026.md section 8.1; wave W0).
--   * graph_loops is the ledger. Rebuilt (v2): `status` gains 'broken' and 'released';
--     `closed_by` gains 'auto', 'aged_out' and 'released'; new columns for the basis, the action
--     class, due-date confidence, renegotiation, snooze, warning and nudge bookkeeping, the
--     thread, the source kind, the counterpart label as written, and `remote_visible`
--     (fail-closed: 0 means hidden from every non-desktop-shell caller).
--   * graph_citations.target_kind gains 'loop' (citations attach to loops); the polymorphic
--     cleanup trigger for loops is created here.
--   * graph_feedback.kind gains 'not_promise' and 'confirmed_promise'.
--   * graph_loop_events is the history of one promise.
-- SQLite cannot change a CHECK, so the three tables are rebuilt: create new, copy, drop, rename,
-- recreate indexes. The runner turns foreign keys off around this file (as for
-- 202611031400_memory_work.sql). Existing rows keep their id, text, status and every other value.
-- Backfill of `basis`: a rule `waiting_on` loop (the owner asked and got no answer) is an 'ask';
-- a model-written loop or one from a meeting is a 'promise'; every other loop is a 'request'.
-- Applied inside one transaction by src/migrate.ts; do not edit once merged, add a new file.

CREATE TABLE graph_loops_v3 (
  id TEXT PRIMARY KEY NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('i_owe', 'waiting_on')),
  text TEXT NOT NULL,
  evidence TEXT,
  counterpart_id TEXT REFERENCES graph_entities (id) ON DELETE SET NULL,
  project_id TEXT REFERENCES graph_entities (id) ON DELETE SET NULL,
  due_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('suggested', 'open', 'snoozed', 'done', 'broken',
    'released', 'dismissed')),
  source_interaction_id TEXT REFERENCES graph_interactions (id) ON DELETE SET NULL,
  provenance TEXT NOT NULL CHECK (provenance IN ('owner', 'agent', 'untrusted', 'system')),
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  detected_by TEXT NOT NULL CHECK (detected_by IN ('rule', 'model', 'owner')),
  dedupe_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT,
  closed_by TEXT CHECK (closed_by IS NULL OR closed_by IN ('owner', 'reply_seen', 'due_passed',
    'auto', 'aged_out', 'released')),
  basis TEXT NOT NULL DEFAULT 'request' CHECK (basis IN ('promise', 'ask', 'request')),
  what_action TEXT CHECK (what_action IS NULL OR what_action IN ('send', 'reply', 'meet', 'do')),
  due_text TEXT CHECK (due_text IS NULL OR length(due_text) <= 120),
  due_kind TEXT NOT NULL DEFAULT 'none' CHECK (due_kind IN ('explicit', 'inferred', 'none')),
  due_confidence REAL CHECK (due_confidence IS NULL OR (due_confidence >= 0 AND due_confidence <= 1)),
  proposed_due_at TEXT,
  snoozed_until TEXT,
  broken_at TEXT,
  warned_at TEXT,
  nudge_count INTEGER NOT NULL DEFAULT 0 CHECK (nudge_count >= 0),
  last_nudge_at TEXT,
  thread_key TEXT,
  source_kind TEXT CHECK (source_kind IS NULL OR source_kind IN ('mail', 'messages', 'meeting',
    'chat', 'manual')),
  counterpart_label TEXT CHECK (counterpart_label IS NULL OR length(counterpart_label) <= 200),
  remote_visible INTEGER NOT NULL DEFAULT 0 CHECK (remote_visible IN (0, 1)),
  -- A promise with a Messages source is never remote-visible (design section 7.2).
  CHECK (source_kind IS NOT 'messages' OR remote_visible = 0)
);
INSERT INTO graph_loops_v3 (id, direction, text, evidence, counterpart_id, project_id, due_at,
  status, source_interaction_id, provenance, confidence, detected_by, dedupe_key, created_at,
  updated_at, closed_at, closed_by, basis, due_kind, due_confidence, thread_key, source_kind)
SELECT l.id, l.direction, l.text, l.evidence, l.counterpart_id, l.project_id, l.due_at, l.status,
  l.source_interaction_id, l.provenance, l.confidence, l.detected_by, l.dedupe_key, l.created_at,
  l.updated_at, l.closed_at, l.closed_by,
  CASE
    WHEN l.direction = 'waiting_on' AND l.detected_by = 'rule' THEN 'ask'
    WHEN l.detected_by = 'model' OR i.kind = 'meeting' THEN 'promise'
    ELSE 'request'
  END,
  CASE WHEN l.due_at IS NULL THEN 'none' ELSE 'explicit' END,
  CASE WHEN l.due_at IS NULL THEN NULL ELSE 0.8 END,
  i.thread_key,
  CASE i.kind WHEN 'mail' THEN 'mail' WHEN 'message' THEN 'messages' WHEN 'meeting' THEN 'meeting'
    WHEN 'chat' THEN 'chat' ELSE NULL END
FROM graph_loops l
LEFT JOIN graph_interactions i ON i.id = l.source_interaction_id;

CREATE TABLE graph_citations_v3 (
  id TEXT PRIMARY KEY NOT NULL,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('fact', 'edge', 'event', 'entity', 'interaction',
    'loop')),
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
INSERT INTO graph_citations_v3 (id, target_kind, target_id, source, doc_id, source_ref, quote,
  start, "end", source_hash, author_entity_id, provenance, observed_at, created_at)
SELECT id, target_kind, target_id, source, doc_id, source_ref, quote, start, "end", source_hash,
  author_entity_id, provenance, observed_at, created_at
FROM graph_citations;

CREATE TABLE graph_feedback_v3 (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('wrong_fact', 'wrong_edge', 'merge', 'do_not_merge',
    'not_project', 'dismissed_loop', 'rename', 'not_promise', 'confirmed_promise')),
  entity_id TEXT,
  other_id TEXT,
  key_hash TEXT,
  created_at TEXT NOT NULL
);
INSERT INTO graph_feedback_v3 (id, kind, entity_id, other_id, key_hash, created_at)
SELECT id, kind, entity_id, other_id, key_hash, created_at FROM graph_feedback;

-- The polymorphic cleanup triggers name graph_citations; SQLite refuses the rename while they
-- point at a missing table, so they go first and are recreated below, unchanged.
DROP TRIGGER graph_facts_citations_cleanup;
DROP TRIGGER graph_edges_citations_cleanup;
DROP TRIGGER graph_entities_citations_cleanup;
DROP TRIGGER graph_interactions_citations_cleanup;
DROP TABLE graph_citations;
DROP TABLE graph_loops;
DROP TABLE graph_feedback;

ALTER TABLE graph_loops_v3 RENAME TO graph_loops;
ALTER TABLE graph_citations_v3 RENAME TO graph_citations;
ALTER TABLE graph_feedback_v3 RENAME TO graph_feedback;

CREATE INDEX graph_loops_status_idx ON graph_loops (status, direction);
CREATE INDEX graph_loops_counterpart_idx ON graph_loops (counterpart_id);
CREATE INDEX graph_loops_dedupe_idx ON graph_loops (dedupe_key);
CREATE INDEX graph_loops_due_idx ON graph_loops (status, due_at);
CREATE INDEX graph_loops_person_status_idx ON graph_loops (counterpart_id, status);
CREATE INDEX graph_citations_target_idx ON graph_citations (target_kind, target_id);
CREATE INDEX graph_citations_source_idx ON graph_citations (source, source_ref);
CREATE INDEX graph_citations_author_idx ON graph_citations (author_entity_id);
CREATE INDEX graph_feedback_entity_idx ON graph_feedback (entity_id, kind);

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
-- Citations are polymorphic, so a deleted loop takes its citations with it (as for facts).
CREATE TRIGGER graph_loops_citations_cleanup AFTER DELETE ON graph_loops BEGIN
  DELETE FROM graph_citations WHERE target_kind = 'loop' AND target_id = old.id;
END;

CREATE TABLE graph_loop_events (
  id TEXT PRIMARY KEY NOT NULL,
  loop_id TEXT NOT NULL REFERENCES graph_loops (id) ON DELETE CASCADE,
  at TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('created', 'confirmed', 'source_added', 'due_changed',
    'due_proposed', 'status', 'warned', 'asked', 'nudge_drafted', 'nudge_sent', 'auto_done',
    'undo')),
  from_value TEXT,
  to_value TEXT,
  by TEXT NOT NULL CHECK (by IN ('owner', 'auto', 'model', 'rule')),
  citation_id TEXT
);
CREATE INDEX graph_loop_events_loop_idx ON graph_loop_events (loop_id, at);
