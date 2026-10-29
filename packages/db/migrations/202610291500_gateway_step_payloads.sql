-- Model-call steps have no tool call, so their input and output could not live in tool_payloads
-- (its tool_call_id references tool_calls): that is why the Timeline showed "No input recorded"
-- on every model call. They get their own table, gzip-compressed and capped by the writer.
CREATE TABLE step_payloads (
  id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('input', 'output')),
  data BLOB NOT NULL,
  truncated INTEGER NOT NULL DEFAULT 0 CHECK (truncated IN (0, 1)),
  created_at TEXT NOT NULL
);
CREATE INDEX step_payloads_step_idx ON step_payloads (step_id);
CREATE INDEX step_payloads_run_idx ON step_payloads (run_id);
CREATE INDEX step_payloads_created_at_idx ON step_payloads (created_at);

-- A declined approval, and the call it blocked, are `denied`: the status CHECK on run_steps
-- must allow it (SQLite cannot alter a CHECK, so the table is rebuilt; nothing references it).
CREATE TABLE run_steps_new (
  run_id TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  seq INTEGER NOT NULL CHECK (seq >= 1),
  kind TEXT NOT NULL CHECK (
    kind IN ('thinking', 'model', 'tool', 'approval', 'question', 'subagent', 'text', 'memory',
             'artifact', 'note')
  ),
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'running', 'ok', 'failed', 'waiting', 'cancelled', 'skipped', 'denied')
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
INSERT INTO run_steps_new SELECT * FROM run_steps;
DROP TABLE run_steps;
ALTER TABLE run_steps_new RENAME TO run_steps;
CREATE INDEX run_steps_tool_call_idx ON run_steps (tool_call_id) WHERE tool_call_id IS NOT NULL;
CREATE INDEX run_steps_text_expires_idx ON run_steps (text_expires_at)
  WHERE text_expires_at IS NOT NULL;
