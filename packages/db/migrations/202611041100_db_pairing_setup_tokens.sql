-- Pairing links (remote Gateway R2): the single-use setup token behind a psyche-pair:v1 link.
-- Only the SHA-256 of the token is stored, never the token. A token lives 10 minutes and is
-- consumed by the first connect that presents it; a pairing request made with one is marked so the
-- owner's card says "expected via pairing link". The token never grants access: the owner still
-- approves the device and its scopes.
-- Applied inside one transaction by src/migrate.ts; do not edit once merged, add a new file.

CREATE TABLE pairing_setup_tokens (
  id TEXT NOT NULL PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  created_by_device_id TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  used_by_device_id TEXT
);

ALTER TABLE pairing_requests ADD COLUMN via_setup_token INTEGER NOT NULL DEFAULT 0;
