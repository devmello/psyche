-- S01 (issue #79): WebAuthn passkeys for the server-mode web client, per device. A passkey
-- assertion is the web client's fresh user presence (security §3.7, §10). Revoking or deleting a
-- device ends its passkeys (the verifier also ignores revoked devices).
CREATE TABLE passkeys (
  id TEXT PRIMARY KEY NOT NULL,
  device_id TEXT NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
  credential_id TEXT NOT NULL UNIQUE,             -- base64url credential id
  public_key BLOB NOT NULL,                       -- COSE public key
  counter INTEGER NOT NULL DEFAULT 0 CHECK (counter >= 0),
  transports TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(transports) AND json_type(transports) = 'array'),
  name TEXT NOT NULL,
  backed_up INTEGER NOT NULL DEFAULT 0 CHECK (backed_up IN (0, 1)),
  created_at TEXT NOT NULL,
  last_used_at TEXT
);
CREATE INDEX passkeys_device_id_idx ON passkeys (device_id);
