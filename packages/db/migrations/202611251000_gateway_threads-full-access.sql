-- Full access (owner, 2026-11-25): a chat the owner turned Full access on in. Kept beside
-- `permission_mode` (whose CHECK predates the mode) so no table rebuild is needed: the thread
-- reads as `permissionMode: "full"` while this is 1, and any other mode written clears it.
ALTER TABLE threads ADD COLUMN full_access INTEGER NOT NULL DEFAULT 0 CHECK (full_access IN (0, 1));
