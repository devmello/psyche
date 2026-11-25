-- Fork a plan (docs/design/fork-a-plan-2026.md §7.1): a fork hangs off one message of a chat; each
-- option is a hidden branch thread plus one premise. Additive: two new tables and a trigger.
-- `staged_actions` (Night shift) has a `fork_branch_id` with no FK, so the trigger below deletes a
-- branch's staged items whenever the branch row goes, however it goes (direct delete, fork delete
-- or the cascade from its thread).
CREATE TABLE plan_forks (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads (id) ON DELETE CASCADE,
  fork_message_id TEXT REFERENCES messages (id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN (
    'running', 'comparing', 'ready', 'taken', 'dismissed', 'expired', 'cancelled', 'failed'
  )),
  error TEXT,
  budget_usd REAL NOT NULL DEFAULT 1 CHECK (budget_usd >= 0.1 AND budget_usd <= 5),
  spent_usd REAL NOT NULL DEFAULT 0,
  tokens INTEGER NOT NULL DEFAULT 0,
  comparison TEXT CHECK (comparison IS NULL OR json_valid(comparison)),
  taken_branch_id TEXT,
  take_approval_id TEXT,
  created_by_device_id TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX plan_forks_thread ON plan_forks (thread_id, created_at);
-- One running fork per thread.
CREATE UNIQUE INDEX plan_forks_one_live ON plan_forks (thread_id)
  WHERE status IN ('running', 'comparing');

CREATE TABLE plan_fork_branches (
  id TEXT PRIMARY KEY,
  fork_id TEXT NOT NULL REFERENCES plan_forks (id) ON DELETE CASCADE,
  ord INTEGER NOT NULL CHECK (ord >= 0 AND ord <= 3),
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 40),
  premise TEXT NOT NULL CHECK (length(premise) BETWEEN 1 AND 280),
  thread_id TEXT NOT NULL REFERENCES threads (id) ON DELETE CASCADE,
  task_id TEXT,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN (
    'queued', 'running', 'reported', 'failed', 'cancelled', 'budget_stopped'
  )),
  error TEXT,
  report TEXT CHECK (report IS NULL OR json_valid(report)),
  read_owner_only INTEGER NOT NULL DEFAULT 0 CHECK (read_owner_only IN (0, 1)),
  taint INTEGER NOT NULL DEFAULT 0 CHECK (taint IN (0, 1)),
  taint_sources TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(taint_sources)),
  spent_usd REAL NOT NULL DEFAULT 0,
  tokens INTEGER NOT NULL DEFAULT 0,
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (fork_id, ord)
);
CREATE INDEX plan_fork_branches_thread ON plan_fork_branches (thread_id);

CREATE TRIGGER plan_fork_branches_staged_delete AFTER DELETE ON plan_fork_branches BEGIN
  DELETE FROM staged_actions WHERE fork_branch_id = OLD.id;
END;
