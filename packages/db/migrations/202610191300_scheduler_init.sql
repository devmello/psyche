-- S04 scheduler (data model §8; architecture §4.11). Owner: @psyche/scheduler.
-- Additions to the data model, all owned by S04: automations.light_context (heartbeat, O2) and
-- automations.system (system-owned automations such as the heartbeat); automation_runs gains
-- task_id, trigger, scheduled_for and coalesced (catch-up after sleep); watches gains
-- alerted_value (dedupe: the value last alerted on) and created_at / updated_at.

CREATE TABLE automations (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL
    CHECK (kind IN ('cron', 'interval', 'watch', 'heartbeat', 'briefing', 'reminder')),
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
  updated_at TEXT NOT NULL
);
CREATE INDEX automations_due_idx ON automations (enabled, next_run_at);

CREATE TABLE automation_runs (
  id TEXT PRIMARY KEY NOT NULL,
  automation_id TEXT NOT NULL REFERENCES automations (id) ON DELETE CASCADE,
  thread_id TEXT REFERENCES threads (id) ON DELETE SET NULL,
  -- the launcher's run id (a task id with the default task launcher); plain TEXT so any
  -- RunLauncher works.
  task_id TEXT,
  trigger TEXT NOT NULL CHECK (trigger IN ('schedule', 'manual')),
  scheduled_for TEXT NOT NULL,
  coalesced INTEGER NOT NULL DEFAULT 1 CHECK (coalesced >= 1),
  started_at TEXT NOT NULL,
  ended_at TEXT,
  status TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'done', 'no_reply', 'failed', 'cancelled', 'skipped')),
  summary TEXT,
  -- notifications belong to S15; plain TEXT until that table exists.
  notification_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX automation_runs_automation_idx ON automation_runs (automation_id, started_at);
CREATE INDEX automation_runs_status_idx ON automation_runs (status);

CREATE TABLE watches (
  id TEXT PRIMARY KEY NOT NULL,
  automation_id TEXT NOT NULL UNIQUE REFERENCES automations (id) ON DELETE CASCADE,
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
