-- S15 Ideas delivery (feature O7; architecture §4.11; ADR-012). Owner: @psyche/proactive.
-- Mining stores candidates; a delivery window later shows the best of them. `delivered_at` is
-- NULL while a candidate waits for its window. `source` names where it came from (`tools`,
-- `memory`, `goals`, `connector:<id>`) for "never from this source"; `action` is what accepting
-- does (a task goal or an automation schedule and prompt), built only from template text.
ALTER TABLE ideas ADD COLUMN source TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE ideas ADD COLUMN action TEXT CHECK (action IS NULL OR (json_valid(action) AND json_type(action) = 'object'));
ALTER TABLE ideas ADD COLUMN untrusted INTEGER NOT NULL DEFAULT 0 CHECK (untrusted IN (0, 1));
ALTER TABLE ideas ADD COLUMN delivered_at TEXT;
CREATE INDEX ideas_delivery_idx ON ideas (status, delivered_at);
