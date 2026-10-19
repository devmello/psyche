-- Per-sender grants for designated persons (owner: S05; security §9). A grant made for a
-- request by a designated person or another sender carries that requester; the owner's grants
-- have NULL. Matching never crosses requesters.
ALTER TABLE grants ADD COLUMN requester_id TEXT;
CREATE INDEX grants_requester_idx ON grants (requester_id) WHERE requester_id IS NOT NULL;
