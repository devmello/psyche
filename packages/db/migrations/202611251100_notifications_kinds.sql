-- migrate: foreign_keys=off
-- Promise ledger W4 (docs/design/promise-ledger-2026.md section 5.1): the Gateway notifies with
-- kind `promise_due`, and `specialist_result` was already a protocol kind the table refused.
-- SQLite cannot alter a CHECK, so `notifications` is rebuilt (the runner turns foreign keys off
-- around this file and runs `foreign_key_check` before it commits, as for 202611241300). Columns,
-- order, defaults and indexes are unchanged; only the `kind` list grows by those two values.
-- Applied inside one transaction by src/migrate.ts; do not edit once merged, add a new file.

CREATE TABLE notifications_new (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('approval', 'input_needed', 'task_done', 'task_failed', 'proactive', 'briefing', 'reminder', 'system', 'specialist_result', 'promise_due')),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  task_id TEXT,
  approval_id TEXT,
  route TEXT,
  actions TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(actions)),
  surfaces TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(surfaces)),
  delivered TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(delivered)),
  read_at TEXT,
  resolved_at TEXT,
  stale_at TEXT,
  stale_reason TEXT,
  dedupe_key TEXT,
  seq INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  message TEXT CHECK (message IS NULL OR json_valid(message))
);
INSERT INTO notifications_new (
  id, kind, title, body, task_id, approval_id, route, actions, surfaces, delivered, read_at,
  resolved_at, stale_at, stale_reason, dedupe_key, seq, created_at, updated_at, message
)
SELECT
  id, kind, title, body, task_id, approval_id, route, actions, surfaces, delivered, read_at,
  resolved_at, stale_at, stale_reason, dedupe_key, seq, created_at, updated_at, message
FROM notifications;
DROP TABLE notifications;
ALTER TABLE notifications_new RENAME TO notifications;
CREATE INDEX notifications_seq_idx ON notifications (seq);
CREATE UNIQUE INDEX notifications_open_dedupe_idx ON notifications (dedupe_key)
  WHERE dedupe_key IS NOT NULL AND resolved_at IS NULL;
CREATE INDEX notifications_open_task_idx ON notifications (task_id) WHERE resolved_at IS NULL;
