-- S01 (issue #52): the agent loop's per-thread state (provider-native messages after compaction,
-- compaction summary, pinned checklist, carried taint), so a Gateway restart keeps the model-side
-- history. One JSON row per thread id. No FK: subagent threads live only here. Placeholders only,
-- never resolved secrets (the Gateway's store masks any value the vault registered).
CREATE TABLE agent_thread_state (
  thread_id TEXT PRIMARY KEY NOT NULL,
  state TEXT NOT NULL CHECK (json_valid(state) AND json_type(state) = 'object'),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
