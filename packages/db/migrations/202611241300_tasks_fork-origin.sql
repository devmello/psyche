-- migrate: foreign_keys=off
-- Fork a plan F1 (docs/design/fork-a-plan-2026.md §2.2, §11): a branch's task is created with
-- `created_from = 'fork'`. SQLite cannot alter a CHECK, so `tasks` is rebuilt (the runner turns
-- foreign keys off around this file and runs `foreign_key_check` before it commits, as for
-- 202611191400). Columns, order, defaults, checks and indexes are unchanged except the one new
-- value in the `created_from` list.
-- Applied inside one transaction by src/migrate.ts; do not edit once merged, add a new file.

CREATE TABLE tasks_new (
  id TEXT PRIMARY KEY NOT NULL,
  thread_id TEXT NOT NULL REFERENCES threads (id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  goal TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (
    status IN (
      'queued', 'running', 'awaiting_input', 'awaiting_approval', 'paused', 'done', 'failed',
      'cancelled'
    )
  ),
  created_from TEXT NOT NULL
    CHECK (created_from IN ('chat', 'automation', 'idea', 'goal', 'channel', 'subagent', 'fork')),
  plan TEXT CHECK (plan IS NULL OR (json_valid(plan) AND json_type(plan) = 'object')),
  checklist TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(checklist) AND json_type(checklist) = 'array'),
  current_step_id TEXT,
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  lease_owner TEXT,
  lease_until TEXT,
  lease_token TEXT,
  run_mode TEXT NOT NULL DEFAULT 'attended' CHECK (run_mode IN ('attended', 'unattended')),
  budget TEXT CHECK (budget IS NULL OR (json_valid(budget) AND json_type(budget) = 'object')),
  resume TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(resume) AND json_type(resume) = 'array'),
  awaiting TEXT
    CHECK (awaiting IS NULL OR (json_valid(awaiting) AND json_type(awaiting) = 'object')),
  browser_session_id TEXT,
  sandbox_id TEXT,
  summary TEXT,
  outcome TEXT CHECK (outcome IS NULL OR (json_valid(outcome) AND json_type(outcome) = 'object')),
  taint INTEGER CHECK (taint IS NULL OR taint IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  taint_sources TEXT
    CHECK (taint_sources IS NULL OR (json_valid(taint_sources) AND json_type(taint_sources) = 'array')),
  workspace TEXT CHECK (workspace IS NULL OR workspace IN ('sandbox', 'vm')),
  specialist TEXT,
  lessons_applied TEXT,
  staging TEXT CHECK (staging IS NULL OR json_valid(staging)),
  CHECK ((lease_owner IS NULL) = (lease_until IS NULL)),
  CHECK ((lease_owner IS NULL) = (lease_token IS NULL))
);
INSERT INTO tasks_new (
  id, thread_id, title, goal, status, created_from, plan, checklist, current_step_id, attempt,
  lease_owner, lease_until, lease_token, run_mode, budget, resume, awaiting, browser_session_id,
  sandbox_id, summary, outcome, taint, created_at, updated_at, completed_at, taint_sources,
  workspace, specialist, lessons_applied, staging
)
SELECT
  id, thread_id, title, goal, status, created_from, plan, checklist, current_step_id, attempt,
  lease_owner, lease_until, lease_token, run_mode, budget, resume, awaiting, browser_session_id,
  sandbox_id, summary, outcome, taint, created_at, updated_at, completed_at, taint_sources,
  workspace, specialist, lessons_applied, staging
FROM tasks;
DROP TABLE tasks;
ALTER TABLE tasks_new RENAME TO tasks;
CREATE INDEX tasks_claim_idx ON tasks (status, lease_until, created_at);
CREATE INDEX tasks_thread_id_idx ON tasks (thread_id, updated_at);
CREATE INDEX tasks_updated_at_idx ON tasks (updated_at);
