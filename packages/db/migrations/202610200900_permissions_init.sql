-- Permissions and receipts (owner: S05, packages/permissions and packages/audit).
-- docs/04-data-model.md §4 (approvals, grants, policy_rules) and §5 (receipts).
-- Answer tokens are stored hashed. request_input keeps the decided call and context so that
-- reissue() after a restart re-evaluates the same inputs, taint included (S23 design-09).
-- src/schema-permissions.ts mirrors these tables.

CREATE TABLE approvals (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL,
  summary TEXT NOT NULL,
  details TEXT NOT NULL CHECK (json_valid(details) AND json_type(details) = 'object'),
  binding_hash TEXT NOT NULL,
  grant_key TEXT NOT NULL,
  side_effect TEXT CHECK (side_effect IN ('none', 'read', 'write', 'destructive', 'financial')),
  target_kind TEXT,
  target TEXT CHECK (target IS NULL OR json_valid(target)),
  device_only INTEGER NOT NULL CHECK (device_only IN (0, 1)),
  requires_authentication INTEGER NOT NULL CHECK (requires_authentication IN (0, 1)),
  taint INTEGER NOT NULL CHECK (taint IN (0, 1)),
  requested_by_run_id TEXT,
  task_id TEXT,
  thread_id TEXT,
  tool_call_id TEXT,
  agent TEXT,
  surfaces TEXT NOT NULL CHECK (json_valid(surfaces) AND json_type(surfaces) = 'array'),
  scopes_offered TEXT NOT NULL CHECK (json_valid(scopes_offered) AND json_type(scopes_offered) = 'array'),
  answer_tokens TEXT NOT NULL CHECK (json_valid(answer_tokens) AND json_type(answer_tokens) = 'array'),
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'expired', 'invalidated')),
  scope_granted TEXT CHECK (scope_granted IN ('once', 'task', 'site', 'session', 'always')),
  decided_by TEXT CHECK (decided_by IS NULL OR json_valid(decided_by)),
  invalidated_reason TEXT,
  request_input TEXT NOT NULL CHECK (json_valid(request_input)),
  consumed_at TEXT,
  run_revoked INTEGER NOT NULL DEFAULT 0 CHECK (run_revoked IN (0, 1)),
  boot_id TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  decided_at TEXT,
  grant_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX approvals_status_idx ON approvals (status, expires_at);
CREATE INDEX approvals_run_idx ON approvals (requested_by_run_id);
CREATE INDEX approvals_task_idx ON approvals (task_id);

CREATE TABLE grants (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('task', 'site', 'session', 'always')),
  grant_key TEXT NOT NULL,
  subject TEXT NOT NULL CHECK (json_valid(subject) AND json_type(subject) = 'object'),
  binding TEXT CHECK (binding IS NULL OR json_valid(binding)),
  side_effect TEXT NOT NULL CHECK (side_effect IN ('none', 'read', 'write', 'destructive', 'financial')),
  task_id TEXT,
  session_id TEXT,
  thread_id TEXT,
  origin TEXT,
  expires_at TEXT,
  use_count INTEGER NOT NULL DEFAULT 0 CHECK (use_count >= 0),
  max_uses INTEGER CHECK (max_uses IS NULL OR max_uses > 0),
  last_used_at TEXT,
  last_used_binding_hash TEXT,
  created_from_approval_id TEXT REFERENCES approvals (id),
  created_by_device_id TEXT,
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  revoked_reason TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX grants_key_idx ON grants (grant_key) WHERE revoked_at IS NULL;
CREATE INDEX grants_device_idx ON grants (created_by_device_id);

-- User-authored allow / ask / deny rules (mirrors the permissions section of config.json).
CREATE TABLE policy_rules (
  id TEXT PRIMARY KEY NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  match TEXT NOT NULL CHECK (json_valid(match) AND json_type(match) = 'object'),
  effect TEXT NOT NULL CHECK (effect IN ('allow', 'ask', 'deny')),
  note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE receipts (
  id TEXT PRIMARY KEY NOT NULL,
  short_id TEXT,
  kind TEXT NOT NULL,
  task_id TEXT,
  tool_call_id TEXT,
  approval_id TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('ok', 'failed', 'uncertain')),
  summary TEXT NOT NULL,
  external_refs TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(external_refs) AND json_type(external_refs) = 'object'),
  payload TEXT CHECK (payload IS NULL OR json_valid(payload)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX receipts_task_idx ON receipts (task_id);
CREATE INDEX receipts_tool_call_idx ON receipts (tool_call_id);
CREATE INDEX receipts_approval_idx ON receipts (approval_id);
CREATE INDEX receipts_uncertain_idx ON receipts (outcome) WHERE outcome = 'uncertain';
