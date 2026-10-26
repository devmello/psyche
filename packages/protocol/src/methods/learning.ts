import { Type } from "@sinclair/typebox";
import { Id, IsoDateTime, Nullable, StringEnum } from "../common.ts";
import {
  FeedbackEvent,
  FeedbackKind,
  FeedbackReason,
  FeedbackScope,
  FeedbackTarget,
  FeedbackTargetType,
  GrowthSummary,
  GrowthWindow,
  Lesson,
  LessonKind,
  LessonStatus,
} from "../schemas/learning.ts";
import { ApprovalRequest } from "../schemas/permissions.ts";
import { defineMethod, nextCursor, OkResult, pageParams } from "./define.ts";

/**
 * The teaching loop (docs/agent/teaching-loop-2026.md §7, epic #676): `feedback.*`,
 * `memory.lessons.*` and `growth.summary`. Owner-only by scope: a device paired below
 * `operator.write` can read but not teach. Implicit feedback (draft edits, undo, approval edits,
 * dismissals, redo) is recorded by the Gateway where it happens, never claimed by a client.
 */

/** Explicit kinds a client may send; the rest are implicit and recorded by the Gateway. */
export const ExplicitFeedbackKind = StringEnum(["helpful", "not_helpful", "correction"], {
  $id: "ExplicitFeedbackKind",
});

export const FeedbackMethods = {
  "feedback.give": defineMethod({
    params: Type.Object({
      target: FeedbackTarget,
      kind: ExplicitFeedbackKind,
      text: Type.Optional(
        Type.String({
          minLength: 1,
          maxLength: 500,
          description: 'The owner\'s one-line correction ("What should I do instead?")',
        }),
      ),
      reason: Type.Optional(FeedbackReason),
      scope: Type.Optional(FeedbackScope),
    }),
    result: Type.Object({
      event: FeedbackEvent,
      /** The lesson made from it, or null when Psyche only noted it. */
      lesson: Nullable(Lesson),
      /** A protected-write card to approve first (SOUL.md, AGENTS.md, boundaries), when needed. */
      approval: Nullable(ApprovalRequest),
    }),
    scope: "operator.write",
    sideEffecting: true,
    description:
      "Records the owner's feedback on an answer or action and runs the lesson router: a correction may write a lesson (or stage a card for a protected file); helpful never creates one. Refused for delegated or group senders and incognito threads. Side-effecting.",
  }),
  "feedback.list": defineMethod({
    params: Type.Object({
      since: Type.Optional(IsoDateTime),
      kind: Type.Optional(FeedbackKind),
      targetType: Type.Optional(FeedbackTargetType),
      ...pageParams,
    }),
    result: Type.Object({ events: Type.Array(FeedbackEvent), ...nextCursor }),
    scope: "operator.read",
    description: "Feedback events newest first (kept 180 days).",
  }),
  "feedback.delete": defineMethod({
    params: Type.Object({ eventId: Id }),
    result: OkResult,
    scope: "operator.write",
    sideEffecting: true,
    description:
      "Deletes one feedback event; lessons made from it keep their other sources (a lesson left with none is forgotten). Side-effecting.",
  }),
} as const;

export const LessonsMethods = {
  "memory.lessons.list": defineMethod({
    params: Type.Object({
      status: Type.Optional(Type.Array(LessonStatus, { maxItems: 6 })),
      kind: Type.Optional(LessonKind),
      /** Only lessons written to this destination type. */
      destination: Type.Optional(StringEnum(["file", "graph", "skill", "automation"])),
      since: Type.Optional(IsoDateTime),
      ...pageParams,
    }),
    result: Type.Object({ lessons: Type.Array(Lesson), ...nextCursor }),
    scope: "operator.read",
    description: "Lessons newest first; forgotten ones only when asked by status.",
  }),
  "memory.lessons.get": defineMethod({
    params: Type.Object({ lessonId: Id }),
    result: Type.Object({
      lesson: Lesson,
      sources: Type.Array(FeedbackEvent),
      /** The destination before and after the lesson, for the Diff view. */
      diff: Type.Object({ before: Nullable(Type.String()), after: Type.String() }),
      /** Earlier lessons it superseded, newest first. */
      history: Type.Array(Lesson),
    }),
    scope: "operator.read",
    description: "One lesson with the feedback it came from, its diff and what it superseded.",
  }),
  "memory.lessons.confirm": defineMethod({
    params: Type.Object({ lessonId: Id }),
    result: Type.Object({ lesson: Lesson }),
    scope: "operator.write",
    sideEffecting: true,
    description:
      "The owner keeps a lesson (weekly card Keep, the mark's Keep): confidence 1, status confirmed. Side-effecting.",
  }),
  "memory.lessons.edit": defineMethod({
    params: Type.Object({
      lessonId: Id,
      value: Type.String({ minLength: 1, maxLength: 4000, description: "The new line or value" }),
    }),
    result: Type.Object({ lesson: Lesson, approval: Nullable(ApprovalRequest) }),
    scope: "operator.write",
    sideEffecting: true,
    description:
      "Rewrites a lesson's line or value at its destination (a protected file stages a card first). Side-effecting.",
  }),
  "memory.lessons.forget": defineMethod({
    params: Type.Object({
      lessonId: Id,
      /** Also delete the feedback events it came from. */
      purgeSources: Type.Optional(Type.Boolean()),
    }),
    result: Type.Object({ lesson: Lesson }),
    scope: "operator.write",
    sideEffecting: true,
    description:
      "Forgets a lesson: removes its line (restoring the previous value) and what dreaming derived from it, and keeps a tombstone so the same evidence cannot recreate it. Side-effecting.",
  }),
  "memory.lessons.forgetAll": defineMethod({
    params: Type.Object({
      dryRun: Type.Optional(Type.Boolean()),
      /** Fresh presence: the approved `policy_change` card from a first `approval_required` call. */
      approvalId: Type.Optional(Id),
    }),
    result: Type.Object({
      lessons: Type.Integer({ minimum: 0 }),
      events: Type.Integer({ minimum: 0 }),
      dryRun: Type.Boolean(),
    }),
    scope: "operator.admin",
    sideEffecting: true,
    description:
      "Forget everything I learned: forgets every lesson and deletes every feedback event; what the owner wrote stays. Presence-gated like memory.reset. Side-effecting.",
  }),
} as const;

export const GrowthMethods = {
  "growth.summary": defineMethod({
    params: Type.Object({ window: GrowthWindow }),
    result: Type.Object({ summary: GrowthSummary }),
    scope: "operator.read",
    description:
      "How the agent has grown for the owner: lessons, outcome metrics against the agent's own previous window (counts with every rate; null rates while history is thin), milestones and the timeline.",
  }),
} as const;
