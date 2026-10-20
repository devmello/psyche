-- S15 Feed read state (feature O6; the agent's `feed.mark_read` tool). Owner: @psyche/proactive.
ALTER TABLE feed_posts ADD COLUMN read_at TEXT;
