-- S15 proactive surfaces (data model §8; architecture §4.11; ADR-012). Owner: @psyche/proactive.
-- Additions to the data model, all owned by S15: feed_posts.exploration and batch_id (the brief
-- or briefing batch a post belongs to, for the bounded "that's it for today" marker);
-- ideas.pattern_key (dismissed patterns stop reappearing) and dismiss_reason (acceptance model);
-- goal_milestones.position (display order); goal_links.created_at.

CREATE TABLE feed_posts (
  id TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL,
  body_md TEXT NOT NULL,
  citations TEXT NOT NULL CHECK (json_valid(citations) AND json_type(citations) = 'array'),
  cluster TEXT CHECK (cluster IS NULL OR json_valid(cluster)),
  score REAL NOT NULL,
  reasons TEXT NOT NULL CHECK (json_valid(reasons) AND json_type(reasons) = 'array'),
  exploration INTEGER NOT NULL DEFAULT 0 CHECK (exploration IN (0, 1)),
  briefing_id TEXT,
  feedback TEXT CHECK (
    feedback IS NULL OR feedback IN ('like', 'save', 'not_interested', 'hide_source', 'follow_topic')
  ),
  batch_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX feed_posts_created_idx ON feed_posts (created_at, id);
CREATE INDEX feed_posts_batch_idx ON feed_posts (batch_id);

CREATE TABLE ideas (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('task', 'automation', 'skill', 'goal', 'connector')),
  title TEXT NOT NULL,
  body_md TEXT NOT NULL,
  evidence TEXT NOT NULL CHECK (json_valid(evidence) AND json_type(evidence) = 'array'),
  effort TEXT NOT NULL,
  acceptance_prob REAL NOT NULL CHECK (acceptance_prob >= 0 AND acceptance_prob <= 1),
  status TEXT NOT NULL CHECK (status IN ('proposed', 'accepted', 'edited', 'dismissed', 'expired')),
  result_ref TEXT,
  pattern_key TEXT,
  dismiss_reason TEXT CHECK (
    dismiss_reason IS NULL OR dismiss_reason IN ('not_now', 'not_interested', 'never_from_source')
  ),
  created_at TEXT NOT NULL,
  decided_at TEXT
);
CREATE INDEX ideas_status_idx ON ideas (status, created_at);
CREATE INDEX ideas_pattern_idx ON ideas (pattern_key);

CREATE TABLE goals (
  id TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL,
  category TEXT NOT NULL CHECK (
    category IN ('health', 'finance', 'career', 'relationships', 'productivity', 'learning', 'home', 'other')
  ),
  status TEXT NOT NULL CHECK (status IN ('candidate', 'active', 'paused', 'done', 'archived')),
  inferred INTEGER NOT NULL DEFAULT 0 CHECK (inferred IN (0, 1)),
  confirmed_at TEXT,
  plan TEXT CHECK (plan IS NULL OR (json_valid(plan) AND json_type(plan) = 'object')),
  cadence TEXT,
  next_checkin_at TEXT,
  archived_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX goals_status_idx ON goals (status, category);

CREATE TABLE goal_milestones (
  id TEXT PRIMARY KEY NOT NULL,
  goal_id TEXT NOT NULL REFERENCES goals (id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  due_at TEXT,
  done_at TEXT,
  position INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX goal_milestones_goal_idx ON goal_milestones (goal_id, position);

-- Exactly one of task_id, automation_id, watch_id is set. Tasks, automations and watches belong
-- to S04; plain TEXT so a deleted task leaves the link (the goal page shows it as gone).
CREATE TABLE goal_links (
  goal_id TEXT NOT NULL REFERENCES goals (id) ON DELETE CASCADE,
  task_id TEXT,
  automation_id TEXT,
  watch_id TEXT,
  created_at TEXT NOT NULL,
  CHECK (
    (task_id IS NOT NULL) + (automation_id IS NOT NULL) + (watch_id IS NOT NULL) = 1
  )
);
CREATE UNIQUE INDEX goal_links_unique_idx ON goal_links (
  goal_id, COALESCE(task_id, ''), COALESCE(automation_id, ''), COALESCE(watch_id, '')
);
