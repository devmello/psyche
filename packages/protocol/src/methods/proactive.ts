import { type Static, Type } from "@sinclair/typebox";
import { Id, IsoDateTime, Nullable, StringEnum } from "../common.ts";
import { FeedFeedback, FeedPost, Goal, GoalCategory, Idea } from "../schemas/surfaces.ts";
import { defineMethod, nextCursor, pageParams } from "./define.ts";

/** `feed.*`, `ideas.*`, `goals.*` (architecture §4.11; UI design §3.9–§3.11). */

export const IdeaStatus = StringEnum(["proposed", "accepted", "edited", "dismissed", "expired"], {
  $id: "IdeaStatus",
});

export const GoalStatus = StringEnum(["candidate", "active", "paused", "done", "archived"], {
  $id: "GoalStatus",
});

/** Why an idea was dismissed; feeds the acceptance model (UI design §3.10). */
export const IdeaDismissReason = StringEnum(["not_now", "not_interested", "never_from_source"], {
  $id: "IdeaDismissReason",
});
export type IdeaDismissReason = Static<typeof IdeaDismissReason>;

export const FeedMethods = {
  "feed.list": defineMethod({
    params: Type.Object({
      since: Type.Optional(IsoDateTime),
      briefingId: Type.Optional(Id),
      ...pageParams,
    }),
    result: Type.Object({
      posts: Type.Array(FeedPost),
      nextBriefAt: Nullable(IsoDateTime),
      ...nextCursor,
    }),
    scope: "operator.read",
    description: "Lists feed posts, newest batch first, with the time of the next brief.",
  }),
  "feed.feedback": defineMethod({
    params: Type.Object({
      postId: Id,
      feedback: Nullable(FeedFeedback),
      topic: Type.Optional(Type.String({ maxLength: 200 })),
    }),
    result: Type.Object({ post: FeedPost }),
    scope: "operator.write",
    description:
      "Records feedback on a post in the interest ledger (null clears it, which is how undo works).",
  }),
} as const;

export const IdeasMethods = {
  "ideas.list": defineMethod({
    params: Type.Object({ status: Type.Optional(Type.Array(IdeaStatus)), ...pageParams }),
    result: Type.Object({ ideas: Type.Array(Idea), ...nextCursor }),
    scope: "operator.read",
    description: "Lists ideas (default: proposed), newest first.",
  }),
  "ideas.accept": defineMethod({
    params: Type.Object({
      ideaId: Id,
      recurring: Type.Optional(Type.Boolean()),
      brief: Type.Optional(Type.String({ minLength: 1, maxLength: 20_000 })),
    }),
    result: Type.Object({ idea: Idea, taskId: Nullable(Id), automationId: Nullable(Id) }),
    scope: "operator.write",
    sideEffecting: true,
    description:
      "Accepts an idea (optionally with an edited brief or as a recurring automation); it becomes a Task or an Automation. Side-effecting.",
  }),
  "ideas.dismiss": defineMethod({
    params: Type.Object({ ideaId: Id, reason: IdeaDismissReason }),
    result: Type.Object({ idea: Idea }),
    scope: "operator.write",
    description: "Dismisses an idea with a reason that feeds the acceptance model.",
  }),
} as const;

export const GoalsMethods = {
  "goals.list": defineMethod({
    params: Type.Object({
      status: Type.Optional(Type.Array(GoalStatus)),
      category: Type.Optional(GoalCategory),
    }),
    result: Type.Object({ goals: Type.Array(Goal) }),
    scope: "operator.read",
    description: "Lists goals (default: active and candidate), grouped client-side by category.",
  }),
  "goals.get": defineMethod({
    params: Type.Object({ goalId: Id }),
    result: Type.Object({ goal: Goal, taskIds: Type.Array(Id) }),
    scope: "operator.read",
    description: "Returns one goal with the ids of its linked tasks.",
  }),
  "goals.decide": defineMethod({
    params: Type.Object({
      goalId: Id,
      decision: StringEnum(["confirm", "reject", "later"], { $id: "GoalDecision" }),
    }),
    result: Type.Object({ goal: Goal }),
    scope: "operator.write",
    description:
      "Confirms, rejects or defers an inferred candidate goal; nothing is created before confirm.",
  }),
} as const;
