import { Type } from "@sinclair/typebox";
import { Id, Nullable } from "../common.ts";
import {
  NightShiftApplyItem,
  NightShiftApplySend,
  NightShiftNight,
  NightShiftRefused,
  NightShiftSummary,
  StagedAction,
} from "../schemas/night-shift.ts";
import { ApprovalRequest } from "../schemas/permissions.ts";
import { SurfaceAnswerToken } from "./approvals.ts";
import { defineMethod } from "./define.ts";

/** `nightShift.*` (docs/design/night-shift-2026.md §6.2). */
export const NightShiftMethods = {
  "nightShift.status": defineMethod({
    params: Type.Object({}),
    result: Type.Object({
      enabled: Type.Boolean(),
      /** Start of the next window, ISO time in the owner's live zone; null while off. */
      nextWindowAt: Nullable(Type.String({ maxLength: 40 })),
      latest: Nullable(NightShiftSummary),
      /** The night id of a review in `ready` or `partial`, if there is one. */
      readyReviewId: Nullable(Id),
    }),
    scope: "operator.read",
    description:
      "Night shift state: whether it is on, when the next window starts, the latest night's counts and the review waiting for the owner, if any.",
  }),
  "nightShift.review.get": defineMethod({
    params: Type.Object({ reviewId: Id }),
    result: Type.Object({
      night: NightShiftNight,
      items: Type.Array(StagedAction, { maxItems: 200 }),
    }),
    scope: "operator.read",
    description:
      "One night's review: the night and its prepared items. Why lines that cite owner-only sources are removed for callers that are not the desktop shell. Mail-derived text is untrusted.",
  }),
  "nightShift.apply": defineMethod({
    params: Type.Object({
      reviewId: Id,
      items: Type.Array(NightShiftApplyItem, { maxItems: 50 }),
      /** Sends are separate from `items`: selecting every item never sends. */
      sends: Type.Array(NightShiftApplySend, { maxItems: 50 }),
    }),
    result: Type.Object({
      approval: Type.Optional(ApprovalRequest),
      answerToken: Type.Optional(SurfaceAnswerToken),
      refused: Type.Array(NightShiftRefused),
    }),
    scope: "operator.approvals",
    sideEffecting: true,
    description:
      "Requests the one staged_apply approval for the ticked items, bound to their binding hashes. Every item is re-checked and re-decided; refused ones come back in refused. The client must check the approval's item hashes equal its selection before approvals.answer. Side-effecting: requires idempotencyKey; a replay returns the same approval and token.",
  }),
  "nightShift.undo": defineMethod({
    params: Type.Object({ itemIds: Type.Array(Id, { minItems: 1, maxItems: 50 }) }),
    result: Type.Object({
      approval: Type.Optional(ApprovalRequest),
      answerToken: Type.Optional(SurfaceAnswerToken),
      refused: Type.Array(NightShiftRefused),
    }),
    scope: "operator.approvals",
    sideEffecting: true,
    description:
      "Requests a staged_apply approval for the inverse of applied items (within 24 hours, target unchanged since). Side-effecting: requires idempotencyKey.",
  }),
  "nightShift.dismiss": defineMethod({
    params: Type.Object({
      reviewId: Id,
      itemIds: Type.Optional(Type.Array(Id, { maxItems: 200 })),
    }),
    result: Type.Object({ dismissed: Type.Integer({ minimum: 0 }) }),
    scope: "operator.write",
    sideEffecting: true,
    description:
      "Dismisses the given items, or every item still ready when itemIds is absent. Runs nothing. Side-effecting: requires idempotencyKey.",
  }),
  "nightShift.runNow": defineMethod({
    params: Type.Object({}),
    result: Type.Object({
      started: Type.Boolean(),
      /**
       * What the run did if it settled within a moment: `already` (a night is running), `skipped`
       * (a gate: see reason), `no_candidates` (nothing to do tonight), `off`, or `empty`, `done`,
       * `stopped`. Absent while the run is still going. The UI words it, localised.
       */
      outcome: Type.Optional(
        Type.Union([
          Type.Literal("off"),
          Type.Literal("already"),
          Type.Literal("skipped"),
          Type.Literal("no_candidates"),
          Type.Literal("empty"),
          Type.Literal("done"),
          Type.Literal("stopped"),
        ]),
      ),
      reason: Type.Optional(Type.String({ maxLength: 200 })),
    }),
    scope: "operator.admin",
    sideEffecting: true,
    callsModel: true,
    description:
      "Settings 'Try it now': prepares a night outside the window under the same gates except the window and idle, and counts against the night's budget. Side-effecting: requires idempotencyKey.",
  }),
};
