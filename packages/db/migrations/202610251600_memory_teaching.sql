-- The teaching loop (owner: T1, packages/memory/src/teaching). docs/agent/teaching-loop-2026.md §3.
-- Feedback events are the owner's signals (evidence only, kept 180 days); lessons are what the
-- agent concluded from them and where it wrote them; weekly counts survive the events' deletion
-- for the Growth view. Nothing here holds content the owner didn't write: feedback text is the
-- owner's own words, implicit signals keep hashes and distances, never the drafts.
-- Applied inside one transaction by src/migrate.ts; do not edit once merged, add a new file.

CREATE TABLE feedback_events (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('helpful', 'not_helpful', 'correction', 'undo', 'draft_edited',
    'approval_edited', 'approval_denied', 'dismissed', 'regenerated', 'feed', 'idea')),
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  target TEXT NOT NULL,                            -- FeedbackTarget JSON
  thread_id TEXT,
  text TEXT,                                       -- the owner's correction (<= 500 chars)
  reason TEXT,
  scope TEXT,
  detail TEXT,                                     -- JSON: hashes and distances, never texts
  surface TEXT NOT NULL,
  lesson_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX feedback_events_created_idx ON feedback_events (created_at);
CREATE INDEX feedback_events_target_idx ON feedback_events (target_type, target_id);
CREATE INDEX feedback_events_lesson_idx ON feedback_events (lesson_id);

CREATE TABLE lessons (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('style', 'fact', 'entity', 'approach', 'parameter', 'boundary')),
  origin TEXT NOT NULL CHECK (origin IN ('stated', 'inferred')),
  statement TEXT NOT NULL,
  scope TEXT NOT NULL,                             -- LessonScope JSON
  destination TEXT NOT NULL,                       -- LessonDestination JSON
  destination_key TEXT NOT NULL,                   -- what "the same destination" means for supersede
  previous TEXT,
  value TEXT NOT NULL,
  sources TEXT NOT NULL,                           -- feedback event ids, oldest first
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  status TEXT NOT NULL CHECK (status IN ('proposed', 'active', 'confirmed', 'dormant', 'superseded', 'forgotten')),
  refined_count INTEGER NOT NULL DEFAULT 0,
  supersedes TEXT REFERENCES lessons (id) ON DELETE SET NULL,
  approval_id TEXT,                                -- the card a proposed lesson waits on
  fingerprint TEXT NOT NULL,                       -- hash of kind + destination + normalised value: tombstones
  last_applied_at TEXT,
  last_confirmed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  confirmed_at TEXT,
  forgotten_at TEXT
);
CREATE INDEX lessons_status_idx ON lessons (status, created_at);
CREATE INDEX lessons_destination_idx ON lessons (destination_key, status);
CREATE INDEX lessons_fingerprint_idx ON lessons (fingerprint);
CREATE INDEX lessons_approval_idx ON lessons (approval_id);

-- Weekly counts per feedback kind, kept after the events are deleted (§3.5).
CREATE TABLE feedback_weekly (
  week TEXT NOT NULL,                              -- the Monday, YYYY-MM-DD
  kind TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (week, kind)
);
