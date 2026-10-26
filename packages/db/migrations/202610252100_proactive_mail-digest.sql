-- S15 mail digest (docs/workflows/mail-and-meetings-2026.md §4.1, §4.2; #670 W4). Owner: @psyche/proactive.
-- `mail_senders`: every sender a digest has seen, so a first-time sender lands under Screen.
-- `digest_loops`: how many digests showed a graph loop (at most twice, then it goes quiet).
CREATE TABLE mail_senders (
  address TEXT PRIMARY KEY NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  messages INTEGER NOT NULL DEFAULT 1 CHECK (messages >= 1)
);
CREATE TABLE digest_loops (
  loop_id TEXT PRIMARY KEY NOT NULL,
  shown_count INTEGER NOT NULL DEFAULT 0 CHECK (shown_count >= 0),
  last_shown_at TEXT
);
-- FeedPost.kind / refs / card (protocol, #710): workflow cards (digest, meeting prep, notes).
ALTER TABLE feed_posts ADD COLUMN kind TEXT;
ALTER TABLE feed_posts ADD COLUMN refs TEXT CHECK (refs IS NULL OR json_valid(refs));
ALTER TABLE feed_posts ADD COLUMN card TEXT CHECK (card IS NULL OR json_valid(card));
