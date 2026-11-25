-- Night shift (docs/design/night-shift-2026.md §6.1): overnight the agent records the changes it
-- would make as staged actions; the owner applies the ticked ones in the morning. Additive: two new
-- tables. `staged_actions.params` and `preview` are cleared (set NULL) when an item expires.
CREATE TABLE night_shift_nights (
  id TEXT PRIMARY KEY,
  night TEXT NOT NULL UNIQUE CHECK (night GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  status TEXT NOT NULL CHECK (status IN ('running', 'done', 'stopped', 'skipped', 'empty')),
  stop_reason TEXT,
  candidates TEXT CHECK (candidates IS NULL OR json_valid(candidates)),
  spent_usd REAL NOT NULL DEFAULT 0,
  tokens INTEGER NOT NULL DEFAULT 0,
  review_status TEXT NOT NULL DEFAULT 'none'
    CHECK (review_status IN ('none', 'ready', 'partial', 'applied', 'dismissed', 'expired')),
  expires_at TEXT,
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX night_shift_nights_review ON night_shift_nights (review_status, night);

CREATE TABLE staged_actions (
  id TEXT PRIMARY KEY,
  night_id TEXT NOT NULL REFERENCES night_shift_nights (id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  domain TEXT NOT NULL CHECK (domain IN ('mail', 'calendar', 'reminders', 'files')),
  target_key TEXT NOT NULL,
  tool TEXT NOT NULL,
  kind TEXT NOT NULL,
  side_effect TEXT NOT NULL,
  target TEXT CHECK (target IS NULL OR json_valid(target)),
  params TEXT CHECK (params IS NULL OR json_valid(params)),
  params_hash TEXT NOT NULL,
  binding_hash TEXT NOT NULL,
  summary TEXT NOT NULL,
  preview TEXT CHECK (preview IS NULL OR json_valid(preview)),
  why TEXT,
  precondition TEXT CHECK (precondition IS NULL OR json_valid(precondition)),
  inverse TEXT CHECK (inverse IS NULL OR json_valid(inverse)),
  -- JSON {recipients, contentHash}: set only on a draft that has a "Send it too" child.
  send TEXT CHECK (send IS NULL OR json_valid(send)),
  taint INTEGER NOT NULL DEFAULT 0,
  taint_sources TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(taint_sources)),
  status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN (
    'ready', 'stale', 'superseded', 'applied', 'failed', 'uncertain', 'skipped',
    'dismissed', 'expired', 'undone'
  )),
  -- JSON {receiptId, refs, error}
  result TEXT CHECK (result IS NULL OR json_valid(result)),
  approval_id TEXT,
  task_id TEXT,
  tool_call_id TEXT,
  applied_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX staged_actions_night ON staged_actions (night_id, seq);
-- One live item per target per night: a later call on the same target supersedes the earlier one.
CREATE UNIQUE INDEX staged_actions_live_target ON staged_actions (night_id, target_key)
  WHERE status IN ('ready', 'stale');
