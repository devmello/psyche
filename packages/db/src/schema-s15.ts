/**
 * drizzle mirror of the proactive tables (owner S15, `packages/proactive`;
 * `migrations/202610201700_proactive_init.sql`); see the header of `schema.ts` for the
 * conventions.
 */
import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

// §8 Proactive surfaces (feed, ideas, goals) ---------------------------------------------------

export const feedPosts = sqliteTable("feed_posts", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  bodyMd: text("body_md").notNull(),
  citations: text("citations").notNull(),
  cluster: text("cluster"),
  score: real("score").notNull(),
  reasons: text("reasons").notNull(),
  exploration: integer("exploration").notNull(),
  briefingId: text("briefing_id"),
  feedback: text("feedback"),
  batchId: text("batch_id").notNull(),
  createdAt: text("created_at").notNull(),
  // 202610211100_proactive_feed-read
  readAt: text("read_at"),
  // 202610252100_proactive_mail-digest
  kind: text("kind"),
  refs: text("refs"),
  card: text("card"),
});

export const ideas = sqliteTable("ideas", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  title: text("title").notNull(),
  bodyMd: text("body_md").notNull(),
  evidence: text("evidence").notNull(),
  effort: text("effort").notNull(),
  acceptanceProb: real("acceptance_prob").notNull(),
  status: text("status").notNull(),
  resultRef: text("result_ref"),
  patternKey: text("pattern_key"),
  dismissReason: text("dismiss_reason"),
  createdAt: text("created_at").notNull(),
  decidedAt: text("decided_at"),
  // 202610210900_proactive_ideas-delivery
  source: text("source").notNull(),
  action: text("action"),
  untrusted: integer("untrusted").notNull(),
  deliveredAt: text("delivered_at"),
});

export const goals = sqliteTable("goals", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  category: text("category").notNull(),
  status: text("status").notNull(),
  inferred: integer("inferred").notNull(),
  confirmedAt: text("confirmed_at"),
  plan: text("plan"),
  cadence: text("cadence"),
  nextCheckinAt: text("next_checkin_at"),
  archivedAt: text("archived_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const goalMilestones = sqliteTable("goal_milestones", {
  id: text("id").primaryKey(),
  goalId: text("goal_id").notNull(),
  title: text("title").notNull(),
  dueAt: text("due_at"),
  doneAt: text("done_at"),
  position: integer("position").notNull(),
});

export const goalLinks = sqliteTable("goal_links", {
  goalId: text("goal_id").notNull(),
  taskId: text("task_id"),
  automationId: text("automation_id"),
  watchId: text("watch_id"),
  createdAt: text("created_at").notNull(),
});

// 202610251900_proactive_proposals
export const actionProposals = sqliteTable("action_proposals", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  calls: text("calls").notNull(),
  status: text("status").notNull(),
  createdBy: text("created_by").notNull(),
  threadId: text("thread_id"),
  postId: text("post_id"),
  approvalId: text("approval_id"),
  taint: integer("taint").notNull(),
  taintSources: text("taint_sources"),
  results: text("results"),
  undoOf: text("undo_of"),
  finishedAt: text("finished_at"),
  createdAt: text("created_at").notNull(),
  expiresAt: text("expires_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

// 202610252100_proactive_mail-digest
export const mailSenders = sqliteTable("mail_senders", {
  address: text("address").primaryKey(),
  firstSeenAt: text("first_seen_at").notNull(),
  lastSeenAt: text("last_seen_at").notNull(),
  messages: integer("messages").notNull(),
});

export const digestLoops = sqliteTable("digest_loops", {
  loopId: text("loop_id").primaryKey(),
  shownCount: integer("shown_count").notNull(),
  lastShownAt: text("last_shown_at"),
});

export const s15Schema = {
  feedPosts,
  ideas,
  goals,
  goalMilestones,
  goalLinks,
  actionProposals,
  mailSenders,
  digestLoops,
};

export type FeedPostRow = typeof feedPosts.$inferSelect;
export type IdeaRow = typeof ideas.$inferSelect;
export type GoalRow = typeof goals.$inferSelect;
export type GoalMilestoneRow = typeof goalMilestones.$inferSelect;
export type GoalLinkRow = typeof goalLinks.$inferSelect;
