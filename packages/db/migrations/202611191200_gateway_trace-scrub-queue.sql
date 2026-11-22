-- Forget's pass over the run trace (run trace §4.3): one row per forgotten phrase, and a separate
-- state row with the worker's cursor, so a restart resumes the pass. The phrase lives only in
-- `trace_scrub_queue` and is written once; the cursor is saved after every batch in
-- `trace_scrub_state`, so no batch rewrites the page that holds the phrase.
-- State: `phase` is the table being scrubbed (0 step payloads, 1 tool payloads, 2 run steps,
-- 3 done); `cursor` is the last rowid done in that table. `started` marks that the pass began and
-- `watch_runs` (JSON array) holds the runs active at that moment: they may write the text back,
-- so a final pass (`final`) follows once they have ended, or at the latest after a day
-- (`final_since`).
CREATE TABLE trace_scrub_queue (
  id INTEGER PRIMARY KEY NOT NULL,
  subject TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE trace_scrub_state (
  queue_id INTEGER PRIMARY KEY NOT NULL,
  phase INTEGER NOT NULL DEFAULT 0 CHECK (phase BETWEEN 0 AND 3),
  cursor INTEGER NOT NULL DEFAULT 0,
  started INTEGER NOT NULL DEFAULT 0 CHECK (started IN (0, 1)),
  watch_runs TEXT NOT NULL DEFAULT '[]',
  final INTEGER NOT NULL DEFAULT 0 CHECK (final IN (0, 1)),
  final_since TEXT,
  rewritten INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0
);
