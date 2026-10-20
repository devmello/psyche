-- Receipt short ids from the store (issue #66; owner: S05, packages/audit). `short_seq` is the
-- number in `R<n>`; `Receipts.record` assigns MAX(short_seq) + 1 in the INSERT itself, so ids
-- continue across Gateway restarts instead of starting again at R1. Existing `R<n>` ids are
-- backfilled (duplicates from before this fix stay as they are; the next id follows the highest).
ALTER TABLE receipts ADD COLUMN short_seq INTEGER;
UPDATE receipts SET short_seq = CAST(substr(short_id, 2) AS INTEGER)
  WHERE short_id GLOB 'R[0-9]*' AND substr(short_id, 2) NOT GLOB '*[^0-9]*';
CREATE INDEX receipts_short_seq_idx ON receipts (short_seq);
