-- S15 notifications inbox (data model §8 `notifications`, plus routing state).
-- Shipped in @psyche/notifications until S01 registers it under packages/db/migrations
-- (adding it there needs a matching drizzle table in @psyche/db's schema.ts; see docs/status/s15.md).
CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('approval', 'input_needed', 'task_done', 'task_failed', 'proactive', 'briefing', 'reminder', 'system')),
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
  updated_at TEXT NOT NULL
);
CREATE INDEX notifications_seq_idx ON notifications (seq);
CREATE UNIQUE INDEX notifications_open_dedupe_idx ON notifications (dedupe_key)
  WHERE dedupe_key IS NOT NULL AND resolved_at IS NULL;
CREATE INDEX notifications_open_task_idx ON notifications (task_id) WHERE resolved_at IS NULL;

CREATE TABLE notification_deliveries (
  notification_id TEXT NOT NULL REFERENCES notifications (id) ON DELETE CASCADE,
  surface TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'deferred', 'delivered', 'failed', 'suppressed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  due_at TEXT,
  delivered_at TEXT,
  detail TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (notification_id, surface)
);
CREATE INDEX notification_deliveries_due_idx ON notification_deliveries (due_at)
  WHERE status IN ('pending', 'deferred');
