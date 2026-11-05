-- A setup token made for a pairing link on the local network (psyche-pair:v2) remembers the LAN
-- certificate pin its link carries. Replacing the certificate revokes every live token that
-- names one, so a link that went with the old certificate cannot be used by whoever kept it.
-- NULL for a token made for an address (psyche-pair:v1).
-- Applied inside one transaction by src/migrate.ts; do not edit once merged, add a new file.

ALTER TABLE setup_tokens ADD COLUMN cert_pin TEXT;
