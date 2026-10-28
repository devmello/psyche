-- Chats the owner opened with "New chat" (feature: empty chats are not kept). Only these may be
-- reused when empty and swept away unused; threads made by a task, an automation, a channel, a
-- specialist, a fork or "Ask about" never carry the flag, whatever their transcript holds.
ALTER TABLE threads ADD COLUMN user_created INTEGER NOT NULL DEFAULT 0;

-- Empty chats that piled up before the flag existed: a side or incognito thread of the owner
-- with no message, no title, no parent and no fork point is what "New chat" made.
UPDATE threads SET user_created = 1
WHERE kind IN ('side', 'incognito')
  AND title = ''
  AND parent_thread_id IS NULL
  AND forked_from_message_id IS NULL
  AND session_key LIKE 'owner:%'
  AND NOT EXISTS (SELECT 1 FROM messages WHERE messages.thread_id = threads.id)
  AND NOT EXISTS (SELECT 1 FROM runs WHERE runs.thread_id = threads.id);
