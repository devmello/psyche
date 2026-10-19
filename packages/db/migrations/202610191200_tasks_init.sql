-- S04 tasks (data model §3; architecture §4.5). Owner: @psyche/tasks.
-- Additions to the data model, all owned by S04: tasks.lease_token (changes on every claim so a
-- stale lease holder cannot renew or release), tasks.run_mode (attended | unattended),
-- tasks.budget (per-task limits), tasks.resume (what the next turn must be told: answers,
-- approval outcomes, recovery notes), tasks.awaiting (the approval or input request a parked
-- task waits on), tasks.taint.

CREATE TABLE tasks (
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
    CHECK (created_from IN ('chat', 'automation', 'idea', 'goal', 'channel', 'subagent')),
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
  CHECK ((lease_owner IS NULL) = (lease_until IS NULL)),
  CHECK ((lease_owner IS NULL) = (lease_token IS NULL))
);
CREATE INDEX tasks_claim_idx ON tasks (status, lease_until, created_at);
CREATE INDEX tasks_thread_id_idx ON tasks (thread_id, updated_at);
CREATE INDEX tasks_updated_at_idx ON tasks (updated_at);

CREATE TABLE task_checkpoints (
  id TEXT PRIMARY KEY NOT NULL,
  task_id TEXT NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  step_id TEXT NOT NULL,
  idx INTEGER NOT NULL CHECK (idx >= 0),
  replay_safe INTEGER NOT NULL CHECK (replay_safe IN (0, 1)),
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'done', 'failed', 'uncertain')),
  payload TEXT CHECK (payload IS NULL OR (json_valid(payload) AND json_type(payload) = 'object')),
  -- receipts belong to S05 (permissions); plain TEXT until that table exists.
  receipt_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (task_id, step_id),
  UNIQUE (task_id, idx)
);

CREATE TABLE task_actions (
  id TEXT PRIMARY KEY NOT NULL,
  task_id TEXT NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  idx INTEGER NOT NULL CHECK (idx >= 0),
  tool_call_id TEXT,
  level1 TEXT NOT NULL,
  level2 TEXT NOT NULL CHECK (json_valid(level2) AND json_type(level2) = 'object'),
  level3_ref TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (task_id, idx)
);

CREATE TABLE input_requests (
  id TEXT PRIMARY KEY NOT NULL,
  task_id TEXT REFERENCES tasks (id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL REFERENCES threads (id) ON DELETE CASCADE,
  question TEXT NOT NULL CHECK (json_valid(question) AND json_type(question) = 'array'),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'answered', 'cancelled')),
  answer TEXT CHECK (answer IS NULL OR (json_valid(answer) AND json_type(answer) = 'object')),
  created_at TEXT NOT NULL,
  answered_at TEXT,
  answered_by_device_id TEXT
);
CREATE INDEX input_requests_task_id_idx ON input_requests (task_id, status);
CREATE INDEX input_requests_open_idx ON input_requests (status, created_at);
