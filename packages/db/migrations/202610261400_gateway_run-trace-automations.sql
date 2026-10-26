-- S01 run trace, part 3 (docs/design/run-trace-2026.md §4.2): an automation run names the agent
-- run that did its work and what that run used, so Activity shows durations and cost per run.
ALTER TABLE automation_runs ADD COLUMN run_id TEXT;
ALTER TABLE automation_runs ADD COLUMN usage TEXT CHECK (usage IS NULL OR json_valid(usage));
CREATE INDEX automation_runs_run_id_idx ON automation_runs (run_id) WHERE run_id IS NOT NULL;
