-- One-time setup tokens for pairing links (remote Gateway R2; remote-gateway design §3.4).
-- A token lets a computer that already verified the Gateway's identity pair without a second
-- approval, with the scopes the owner chose when the token was made. Only the SHA-256 of the
-- token is stored (the token itself is 256 random bits, so a plain hash is enough); it lives
-- ten minutes, is used once and can be revoked. `used_at` is set by one conditional UPDATE, so two
-- connections racing on the same token cannot both win.
-- Applied inside one transaction by src/migrate.ts; do not edit once merged, add a new file.

CREATE TABLE setup_tokens (
  id TEXT PRIMARY KEY NOT NULL,
  token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  scopes TEXT NOT NULL CHECK (json_valid(scopes) AND json_type(scopes) = 'array'),
  created_by_device_id TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  used_by_device_id TEXT,
  revoked_at TEXT
);
CREATE INDEX setup_tokens_created_idx ON setup_tokens (created_at);
