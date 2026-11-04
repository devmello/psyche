-- Undo records for work lines the owner's chat wrote directly (MW7 follow-up). One row per
-- progress, stopped-at or next-step fact the Gateway offered Undo for in a chat note: the ids of
-- the fact and what the write moved besides it (a not-started to-do going in progress, and the
-- item's last signal time), so Undo can put those back too, but only if they have not changed
-- since. No text is kept here. No foreign keys: undoing deletes the fact and keeps this row so a
-- second Undo can say "already undone". Rows older than seven days are deleted by retention.
-- Applied inside one transaction by src/migrate.ts; do not edit once merged, add a new file.

CREATE TABLE memory_work_undo (
  fact_id TEXT PRIMARY KEY NOT NULL,
  entity_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  undone_at TEXT,
  status_before TEXT,
  status_after TEXT,
  status_fact_id TEXT,
  signal_before TEXT,
  signal_after TEXT
);
CREATE INDEX memory_work_undo_created_idx ON memory_work_undo (created_at);
