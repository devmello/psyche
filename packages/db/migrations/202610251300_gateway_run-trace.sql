-- S01 run trace (docs/design/run-trace-2026.md §4.2–§4.5; data model §2, §12). Additive: the
-- steps of every run, the frames Psyche saw, and the links from runs, tool calls, usage and tool
-- payloads to them. Every text column is redacted by the Gateway before it is written.

-- §4.2 New Run fields. Helper and specialist runs are child runs (parent_run_id, root_run_id).
ALTER TABLE runs ADD COLUMN kind TEXT
  CHECK (kind IS NULL OR kind IN ('chat', 'task', 'automation', 'subagent'));
ALTER TABLE runs ADD COLUMN title TEXT;
ALTER TABLE runs ADD COLUMN parent_run_id TEXT REFERENCES runs (id) ON DELETE SET NULL;
ALTER TABLE runs ADD COLUMN root_run_id TEXT;
ALTER TABLE runs ADD COLUMN task_id TEXT;
ALTER TABLE runs ADD COLUMN automation_run_id TEXT;
ALTER TABLE runs ADD COLUMN origin TEXT
  CHECK (origin IS NULL OR origin IN ('owner', 'automation', 'channel', 'subagent'));
ALTER TABLE runs ADD COLUMN budget TEXT CHECK (budget IS NULL OR json_valid(budget));
ALTER TABLE runs ADD COLUMN deadline TEXT;
ALTER TABLE runs ADD COLUMN specialist TEXT CHECK (specialist IS NULL OR json_valid(specialist));
ALTER TABLE runs ADD COLUMN note TEXT;
ALTER TABLE runs ADD COLUMN step_count INTEGER NOT NULL DEFAULT 0 CHECK (step_count >= 0);
ALTER TABLE runs ADD COLUMN current_step_id TEXT;
ALTER TABLE runs ADD COLUMN last_step_at TEXT;
CREATE INDEX runs_parent_run_id_idx ON runs (parent_run_id) WHERE parent_run_id IS NOT NULL;
CREATE INDEX runs_task_id_idx ON runs (task_id) WHERE task_id IS NOT NULL;
CREATE INDEX runs_started_at_idx ON runs (started_at);

-- The step that shows a tool call, and the model step a usage row belongs to.
ALTER TABLE tool_calls ADD COLUMN step_id TEXT;
ALTER TABLE usage ADD COLUMN step_id TEXT;

-- §4.2 One append-only list of steps per run, in seq order. `data` is the whole RunStep except
-- the retained thinking text, which lives in `text_full` until `text_expires_at` (§4.3).
CREATE TABLE run_steps (
  run_id TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  seq INTEGER NOT NULL CHECK (seq >= 1),
  kind TEXT NOT NULL CHECK (
    kind IN ('thinking', 'model', 'tool', 'approval', 'question', 'subagent', 'text', 'memory',
             'artifact', 'note')
  ),
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'running', 'ok', 'failed', 'waiting', 'cancelled', 'skipped')
  ),
  tool_call_id TEXT,
  data TEXT NOT NULL CHECK (json_valid(data) AND json_type(data) = 'object'),
  text_full TEXT,
  text_expires_at TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (run_id, id),
  UNIQUE (run_id, seq)
);
CREATE INDEX run_steps_tool_call_idx ON run_steps (tool_call_id) WHERE tool_call_id IS NOT NULL;
CREATE INDEX run_steps_text_expires_idx ON run_steps (text_expires_at)
  WHERE text_expires_at IS NOT NULL;

-- §4.2 Frames Psyche saw (computer use, browser), in seq order per run. The JPEG lives at
-- `path` under $PSYCHE_HOME/library/recordings/<runId>/ until `data.replayRetentionDays`;
-- `expired_at` is set when the retention sweep removed it (the row stays).
CREATE TABLE run_frames (
  run_id TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  seq INTEGER NOT NULL CHECK (seq >= 1),
  at TEXT NOT NULL,
  step_id TEXT,
  width INTEGER NOT NULL CHECK (width >= 1),
  height INTEGER NOT NULL CHECK (height >= 1),
  path TEXT,
  expired_at TEXT,
  PRIMARY KEY (run_id, seq)
);
CREATE INDEX run_frames_at_idx ON run_frames (at) WHERE expired_at IS NULL;

-- §4.5 Payloads link to their step and say whether the head and tail were kept.
ALTER TABLE tool_payloads ADD COLUMN step_id TEXT;
ALTER TABLE tool_payloads ADD COLUMN truncated INTEGER NOT NULL DEFAULT 0
  CHECK (truncated IN (0, 1));
