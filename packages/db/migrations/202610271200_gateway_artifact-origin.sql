-- Where an artifact came from, for "open in chat" from the Library. `run_id` is the agent run
-- that made it (set at creation). `message_id` is the transcript message holding its artifact
-- block in `thread_id` (the thread at creation, never a fork): it is filled the first time the
-- artifact is read after that message is committed, which also backfills older artifacts.
ALTER TABLE artifacts ADD COLUMN run_id TEXT;
ALTER TABLE artifacts ADD COLUMN message_id TEXT;
