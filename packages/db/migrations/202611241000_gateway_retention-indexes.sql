-- Retention walks these partial indexes by age, so a prune batch reads only rows still to do:
-- a row leaves its index once its bulky column is trimmed.
CREATE INDEX IF NOT EXISTS task_checkpoints_bulky_idx ON task_checkpoints (updated_at)
  WHERE payload IS NOT NULL AND length(payload) > 512;
CREATE INDEX IF NOT EXISTS task_actions_bulky_idx ON task_actions (created_at)
  WHERE length(level2) > 512;
CREATE INDEX IF NOT EXISTS automation_runs_events_idx ON automation_runs (started_at)
  WHERE events IS NOT NULL;

-- Small key/value state of the retention job (the last cutoff it used per prune).
CREATE TABLE IF NOT EXISTS retention_state (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
);
