-- S15 meeting prep (docs/workflows/mail-and-meetings-2026.md §4.5; #670 W6). Owner: @psyche/proactive.
-- One row per calendar event the prep planner has seen: its two one-shot automations (prep at
-- T - 2 h, delivery at T - 60 min), what it decided, and the Feed post it made.
CREATE TABLE meeting_preps (
  event_id TEXT PRIMARY KEY NOT NULL,
  series_key TEXT NOT NULL,
  title TEXT NOT NULL,
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  event TEXT NOT NULL CHECK (json_valid(event)),
  status TEXT NOT NULL CHECK (status IN ('planned', 'prepared', 'nothing_new', 'cancelled')),
  prep_automation_id TEXT,
  notify_automation_id TEXT,
  post_id TEXT,
  thin INTEGER NOT NULL DEFAULT 0 CHECK (thin IN (0, 1)),
  taint INTEGER NOT NULL DEFAULT 0 CHECK (taint IN (0, 1)),
  notified_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX meeting_preps_series ON meeting_preps (series_key, start_at);
CREATE INDEX meeting_preps_notified ON meeting_preps (notified_at);
