-- Event triggers for automations (docs/workflows/mail-and-meetings-2026.md §4.7, §8.2; #670 W3).
-- Owner of the change: S15 (W), on S04's scheduler tables.
--
-- `automations.kind` and `automation_runs.trigger` gain `event`. SQLite cannot change a CHECK
-- constraint in place, and with foreign keys on, `DROP TABLE automations` would cascade-delete
-- every run and watch. So the three tables are rebuilt in order: copy into new tables, drop the
-- children (nothing references them), drop the parent (nothing references it any more), then
-- rename; ALTER TABLE … RENAME updates the children's REFERENCES clauses. Every row is kept.
-- New columns: `automations.trigger` (the AutomationTrigger JSON of an event automation) and
-- `automation_runs.events` (the WorkflowEvent list an event run folded in).

CREATE TABLE automations_v2 (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL
    CHECK (kind IN ('cron', 'interval', 'watch', 'heartbeat', 'briefing', 'reminder', 'event')),
  title TEXT NOT NULL,
  schedule TEXT NOT NULL,
  timezone TEXT NOT NULL,
  session_target TEXT NOT NULL DEFAULT 'isolated',
  delivery TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(delivery) AND json_type(delivery) = 'object'),
  prompt TEXT NOT NULL,
  scratch TEXT,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  light_context INTEGER CHECK (light_context IS NULL OR light_context IN (0, 1)),
  system INTEGER NOT NULL DEFAULT 0 CHECK (system IN (0, 1)),
  next_run_at TEXT,
  last_run_at TEXT,
  last_status TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  trigger TEXT CHECK (trigger IS NULL OR (json_valid(trigger) AND json_type(trigger) = 'object')),
  CHECK ((kind = 'event') = (trigger IS NOT NULL))
);
INSERT INTO automations_v2 (id, kind, title, schedule, timezone, session_target, delivery, prompt,
  scratch, enabled, light_context, system, next_run_at, last_run_at, last_status, created_at,
  updated_at)
SELECT id, kind, title, schedule, timezone, session_target, delivery, prompt, scratch, enabled,
  light_context, system, next_run_at, last_run_at, last_status, created_at, updated_at
FROM automations;

CREATE TABLE automation_runs_v2 (
  id TEXT PRIMARY KEY NOT NULL,
  automation_id TEXT NOT NULL REFERENCES automations_v2 (id) ON DELETE CASCADE,
  thread_id TEXT REFERENCES threads (id) ON DELETE SET NULL,
  task_id TEXT,
  trigger TEXT NOT NULL CHECK (trigger IN ('schedule', 'manual', 'event')),
  scheduled_for TEXT NOT NULL,
  coalesced INTEGER NOT NULL DEFAULT 1 CHECK (coalesced >= 1),
  started_at TEXT NOT NULL,
  ended_at TEXT,
  status TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'done', 'no_reply', 'failed', 'cancelled', 'skipped')),
  summary TEXT,
  notification_id TEXT,
  created_at TEXT NOT NULL,
  events TEXT CHECK (events IS NULL OR (json_valid(events) AND json_type(events) = 'array'))
);
INSERT INTO automation_runs_v2 (id, automation_id, thread_id, task_id, trigger, scheduled_for,
  coalesced, started_at, ended_at, status, summary, notification_id, created_at)
SELECT id, automation_id, thread_id, task_id, trigger, scheduled_for, coalesced, started_at,
  ended_at, status, summary, notification_id, created_at
FROM automation_runs;

CREATE TABLE watches_v2 (
  id TEXT PRIMARY KEY NOT NULL,
  automation_id TEXT NOT NULL UNIQUE REFERENCES automations_v2 (id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('change', 'text_present', 'price_below', 'price_above')),
  selector TEXT,
  threshold TEXT CHECK (threshold IS NULL OR json_valid(threshold)),
  last_value TEXT,
  alerted_value TEXT,
  last_checked_at TEXT,
  failures INTEGER NOT NULL DEFAULT 0 CHECK (failures >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO watches_v2 SELECT * FROM watches;

DROP TABLE automation_runs;
DROP TABLE watches;
DROP TABLE automations;
ALTER TABLE automations_v2 RENAME TO automations;
ALTER TABLE automation_runs_v2 RENAME TO automation_runs;
ALTER TABLE watches_v2 RENAME TO watches;
CREATE INDEX automations_due_idx ON automations (enabled, next_run_at);
CREATE INDEX automations_kind_idx ON automations (kind, enabled);
CREATE INDEX automation_runs_automation_idx ON automation_runs (automation_id, started_at);
CREATE INDEX automation_runs_status_idx ON automation_runs (status);

-- Events seen per automation (dedupe: one run per source id, ever; pruned after 30 days).
CREATE TABLE automation_event_seen (
  automation_id TEXT NOT NULL REFERENCES automations (id) ON DELETE CASCADE,
  event_id TEXT NOT NULL,
  seen_at TEXT NOT NULL,
  PRIMARY KEY (automation_id, event_id)
);
-- Events waiting for their debounce window (survives a restart or sleep).
CREATE TABLE automation_event_queue (
  id TEXT PRIMARY KEY NOT NULL,
  automation_id TEXT NOT NULL REFERENCES automations (id) ON DELETE CASCADE,
  event TEXT NOT NULL CHECK (json_valid(event)),
  received_at TEXT NOT NULL
);
CREATE INDEX automation_event_queue_idx ON automation_event_queue (automation_id, received_at);
-- Durable cursors of event sources (a mail account's last poll), so nothing is replayed.
CREATE TABLE event_cursors (
  source TEXT NOT NULL,
  key TEXT NOT NULL,
  cursor TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (source, key)
);
