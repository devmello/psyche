-- Forget's pass over the run trace (run trace §4.3): one row per forgotten phrase, with the
-- worker's cursor, so a restart resumes the pass. `phase` is the table being scrubbed (0 step
-- payloads, 1 tool payloads, 2 run steps, 3 done); `cursor` is the last rowid done in that table.
-- `watch` marks a pass that began while a run was active; `final` is the pass after those runs.
CREATE TABLE trace_scrub_queue (
  subject TEXT PRIMARY KEY NOT NULL,
  phase INTEGER NOT NULL DEFAULT 0 CHECK (phase BETWEEN 0 AND 3),
  cursor INTEGER NOT NULL DEFAULT 0,
  watch INTEGER NOT NULL DEFAULT 0 CHECK (watch IN (0, 1)),
  final INTEGER NOT NULL DEFAULT 0 CHECK (final IN (0, 1)),
  rewritten INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
