import { Type } from "@sinclair/typebox";
import { Id, IsoDateTime, JsonObject, Nullable, StringEnum } from "../common.ts";
import {
  FeedFeedback,
  FeedPost,
  Goal,
  GoalCategory,
  GoalLink,
  GoalMilestone,
  Idea,
  IdeaDismissReason,
  IdeaStatus,
} from "../schemas/surfaces.ts";
import { defineMethod, nextCursor, OkResult, pageParams } from "./define.ts";

/**
 * `feed.*`, `ideas.*`, `goals.*` (architecture §4.11, data model §8, UI §3.9–3.11; owner S15).
 * Proactive output is bounded and confirmable (ADR-012): nothing here sends anything to a third
 * party; accepting an idea or confirming a goal only creates local work.
 */

const GoalDetail = Type.Object({
  goal: Goal,
  milestones: Type.Array(GoalMilestone),
  links: Type.Array(GoalLink),
});

export const FeedMethods = {
  "feed.list": defineMethod({
    params: Type.Object({
      briefingId: Type.Optional(Id),
      /** `YYYY-MM-DD` in the owner's timezone; default: the latest brief. */
      date: Type.Optional(Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" })),
      ...pageParams,
    }),
    result: Type.Object({ posts: Type.Array(FeedPost), ...nextCursor }),
    scope: "operator.read",
    description: "Lists Feed posts, newest brief first, in ranked order within a brief.",
  }),
  "feed.feedback": defineMethod({
    params: Type.Object({
      postId: Id,
      /** `null` undoes the previous feedback (the undo toast). */
      feedback: Nullable(FeedFeedback),
    }),
    result: Type.Object({ post: FeedPost, ledgerChanges: Type.Array(Type.String()) }),
    scope: "operator.write",
    sideEffecting: true,
    description:
      "Records Discover-style feedback on a post and applies it to the interest ledger at once. Side-effecting.",
  }),
  "feed.generate": defineMethod({
    params: Type.Object({ briefingId: Type.Optional(Id) }),
    result: Type.Object({ posts: Type.Array(FeedPost) }),
    scope: "operator.write",
    sideEffecting: true,
    description:
      "Generates the daily brief (or one briefing) now instead of at its schedule. Side-effecting.",
  }),
} as const;

export const IdeasMethods = {
  "ideas.list": defineMethod({
    params: Type.Object({ status: Type.Optional(IdeaStatus), ...pageParams }),
    result: Type.Object({ ideas: Type.Array(Idea), ...nextCursor }),
    scope: "operator.read",
    description: "Lists ideas, newest batch first.",
  }),
  "ideas.accept": defineMethod({
    params: Type.Object({
      ideaId: Id,
      /** The "Make recurring" toggle: create an automation instead of a one-off task. */
      recurring: Type.Optional(
        Type.Object({ schedule: Type.String(), timezone: Type.Optional(Type.String()) }),
      ),
      threadId: Type.Optional(Id),
    }),
    result: Type.Object({
      idea: Idea,
      taskId: Nullable(Id),
      automationId: Nullable(Id),
    }),
    scope: "operator.write",
    sideEffecting: true,
    description:
      "Let's do it: turns an idea into a Task (or an automation when recurring). Skill drafts stay drafts. Side-effecting.",
  }),
  "ideas.edit": defineMethod({
    params: Type.Object({
      ideaId: Id,
      title: Type.Optional(Type.String({ minLength: 1 })),
      bodyMd: Type.Optional(Type.String()),
    }),
    result: Type.Object({ idea: Idea }),
    scope: "operator.write",
    sideEffecting: true,
    description: "Edits an idea's brief before accepting it (status `edited`). Side-effecting.",
  }),
  "ideas.dismiss": defineMethod({
    params: Type.Object({ ideaId: Id, reason: IdeaDismissReason }),
    result: Type.Object({ idea: Idea }),
    scope: "operator.write",
    sideEffecting: true,
    description:
      "Dismisses an idea; the reason feeds the acceptance model and pattern suppression. Side-effecting.",
  }),
} as const;

export const GoalsMethods = {
  "goals.list": defineMethod({
    params: Type.Object({
      status: Type.Optional(Type.Array(Goal.properties.status)),
      category: Type.Optional(GoalCategory),
    }),
    result: Type.Object({ goals: Type.Array(Goal) }),
    scope: "operator.read",
    description: "Lists goals; inferred candidates have status `candidate`.",
  }),
  "goals.get": defineMethod({
    params: Type.Object({ goalId: Id }),
    result: GoalDetail,
    scope: "operator.read",
    description: "Returns a goal with its milestones and linked tasks, automations and watches.",
  }),
  "goals.create": defineMethod({
    params: Type.Object({
      title: Type.String({ minLength: 1 }),
      category: GoalCategory,
      plan: Type.Optional(Nullable(JsonObject)),
      cadence: Type.Optional(Nullable(Type.String())),
      timezone: Type.Optional(Type.String()),
      milestones: Type.Optional(
        Type.Array(
          Type.Object({
            title: Type.String({ minLength: 1 }),
            dueAt: Type.Optional(Nullable(IsoDateTime)),
          }),
        ),
      ),
    }),
    result: GoalDetail,
    scope: "operator.write",
    sideEffecting: true,
    description:
      "Creates a stated goal (active at once); a cadence schedules check-ins. Side-effecting.",
  }),
  "goals.update": defineMethod({
    params: Type.Object({
      goalId: Id,
      title: Type.Optional(Type.String({ minLength: 1 })),
      category: Type.Optional(GoalCategory),
      status: Type.Optional(StringEnum(["active", "paused", "done"])),
      plan: Type.Optional(Nullable(JsonObject)),
      cadence: Type.Optional(Nullable(Type.String())),
    }),
    result: GoalDetail,
    scope: "operator.write",
    sideEffecting: true,
    description: "Edits a goal; changing the cadence reschedules its check-ins. Side-effecting.",
  }),
  "goals.confirm": defineMethod({
    params: Type.Object({ goalId: Id }),
    result: GoalDetail,
    scope: "operator.write",
    sideEffecting: true,
    description:
      "Confirms an inferred candidate (the only way an inferred goal becomes active). Side-effecting.",
  }),
  "goals.reject": defineMethod({
    params: Type.Object({ goalId: Id, reason: StringEnum(["not_a_goal", "later"]) }),
    result: Type.Object({ goal: Goal }),
    scope: "operator.write",
    sideEffecting: true,
    description:
      "Not a goal (archived, never proposed again) or Later (re-proposed after a while). Side-effecting.",
  }),
  "goals.archive": defineMethod({
    params: Type.Object({ goalId: Id }),
    result: Type.Object({ goal: Goal }),
    scope: "operator.write",
    sideEffecting: true,
    description: "Archives a goal and disables its check-ins. Side-effecting.",
  }),
  "goals.milestone": defineMethod({
    params: Type.Object({
      goalId: Id,
      milestoneId: Type.Optional(Id),
      title: Type.Optional(Type.String({ minLength: 1 })),
      dueAt: Type.Optional(Nullable(IsoDateTime)),
      done: Type.Optional(Type.Boolean()),
      remove: Type.Optional(Type.Boolean()),
    }),
    result: GoalDetail,
    scope: "operator.write",
    sideEffecting: true,
    description: "Adds (no milestoneId), edits, completes or removes a milestone. Side-effecting.",
  }),
  "goals.link": defineMethod({
    params: Type.Object({
      goalId: Id,
      taskId: Type.Optional(Id),
      automationId: Type.Optional(Id),
      watchId: Type.Optional(Id),
      unlink: Type.Optional(Type.Boolean()),
    }),
    result: OkResult,
    scope: "operator.write",
    sideEffecting: true,
    description: "Links (or unlinks) a task, automation or watch to a goal. Side-effecting.",
  }),
} as const;
