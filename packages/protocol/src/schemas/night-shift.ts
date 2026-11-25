import { type Static, Type } from "@sinclair/typebox";
import { Id, IsoDateTime, Nullable, StringEnum } from "../common.ts";
import { TaintSource } from "./permissions.ts";

/**
 * Night shift (docs/design/night-shift-2026.md §6): overnight the agent records the changes it
 * would make (reply drafts, calendar fixes, filed documents, reminders) as staged actions, and the
 * owner applies the ones they tick in the morning. Nothing here runs a tool; applying goes
 * through one `staged_apply` approval.
 */
export const NightShiftNightStatus = StringEnum(
  ["running", "done", "stopped", "skipped", "empty"],
  { $id: "NightShiftNightStatus" },
);
export type NightShiftNightStatus = Static<typeof NightShiftNightStatus>;

export const NightShiftReviewStatus = StringEnum(
  ["none", "ready", "partial", "applied", "dismissed", "expired"],
  { $id: "NightShiftReviewStatus" },
);
export type NightShiftReviewStatus = Static<typeof NightShiftReviewStatus>;

export const StagedActionDomain = StringEnum(["mail", "calendar", "reminders", "files"], {
  $id: "StagedActionDomain",
});
export type StagedActionDomain = Static<typeof StagedActionDomain>;

export const StagedActionStatus = StringEnum(
  [
    "ready",
    "stale",
    "superseded",
    "applied",
    "failed",
    "uncertain",
    "skipped",
    "dismissed",
    "expired",
    "undone",
  ],
  { $id: "StagedActionStatus" },
);
export type StagedActionStatus = Static<typeof StagedActionStatus>;

/**
 * One row of a preview, exactly what the Night shift adapters produce (`Preview` in
 * `@psyche/proactive`). Plain text only: control characters are removed before storing, and clients
 * render it as text. `truncated: true` means `value` is a shortened form of the real text;
 * `badge: "new_recipient"` marks an address the owner has never written to (§3.4) and
 * `"reply_all"` a reply-all draft.
 */
export const StagedPreviewRow = Type.Object(
  {
    label: Type.String({ maxLength: 60 }),
    value: Type.String(),
    truncated: Type.Optional(Type.Literal(true)),
    badge: Type.Optional(StringEnum(["new_recipient", "reply_all"])),
  },
  { $id: "StagedPreviewRow" },
);
export type StagedPreviewRow = Static<typeof StagedPreviewRow>;

/**
 * The review's wire preview (the only preview shape; clients render `rows` in order). Sendable
 * fields (recipients, subject, body) are carried whole; if any row was shortened anyway, the
 * top-level `truncated` is true and the UI must expand the full text before enabling a send tick.
 */
export const StagedPreview = Type.Object(
  {
    kind: StringEnum(["mail", "calendar", "reminder", "file"]),
    title: Type.String({ maxLength: 200 }),
    rows: Type.Array(StagedPreviewRow, { maxItems: 40 }),
    truncated: Type.Boolean(),
  },
  { $id: "StagedPreview" },
);
export type StagedPreview = Static<typeof StagedPreview>;

/** A send is its own checkbox under its draft; `contentHash` binds the saved draft's content. */
export const StagedActionSend = Type.Object(
  {
    recipients: Type.Array(Type.String({ maxLength: 320 }), { maxItems: 50 }),
    contentHash: Type.String({ maxLength: 128 }),
  },
  { $id: "StagedActionSend" },
);
export type StagedActionSend = Static<typeof StagedActionSend>;

export const StagedActionResult = Type.Object(
  {
    receiptId: Type.Optional(Id),
    refs: Type.Optional(Type.Array(Type.String({ maxLength: 500 }), { maxItems: 20 })),
    error: Type.Optional(Type.String({ maxLength: 500 })),
  },
  { $id: "StagedActionResult" },
);
export type StagedActionResult = Static<typeof StagedActionResult>;

/** One prepared change. `params` and `preview` are cleared (null) once the item expires. */
export const StagedAction = Type.Object(
  {
    id: Id,
    /** Origin: exactly one of `nightId` (Night shift) or `forkBranchId` (Fork a plan) is set. */
    nightId: Nullable(Id),
    forkBranchId: Nullable(Id),
    seq: Type.Integer({ minimum: 0 }),
    domain: StagedActionDomain,
    /** Thread id, event id, reminder id or file `dev:ino`: one live item per target per night. */
    targetKey: Type.String({ maxLength: 500 }),
    tool: Type.String({ maxLength: 120 }),
    kind: Type.String({ maxLength: 60 }),
    sideEffect: Type.String({ maxLength: 30 }),
    target: Nullable(Type.Unknown()),
    params: Nullable(Type.Unknown()),
    paramsHash: Type.String({ maxLength: 128 }),
    /** The call's binding hash: what the `staged_apply` approval's children are bound to. */
    bindingHash: Type.String({ maxLength: 128 }),
    summary: Type.String({ maxLength: 500 }),
    preview: Nullable(StagedPreview),
    /** One sentence, redacted then truncated; never an instruction. */
    why: Nullable(Type.String({ maxLength: 500 })),
    precondition: Nullable(Type.Unknown()),
    inverse: Nullable(Type.Unknown()),
    send: Nullable(StagedActionSend),
    taint: Type.Boolean(),
    taintSources: Type.Array(TaintSource, { maxItems: 20 }),
    /**
     * Set for a caller that may not see the item's source: `messages` means it was made from the
     * owner's Messages, which only this Mac's desktop app shows. The summary, preview, params and
     * why are withheld; clients render their own localized line (the English `summary` is only a
     * fallback for older clients).
     */
    withheld: Type.Optional(StringEnum(["messages"])),
    status: StagedActionStatus,
    result: Nullable(StagedActionResult),
    approvalId: Nullable(Id),
    taskId: Nullable(Id),
    toolCallId: Nullable(Id),
    appliedAt: Nullable(IsoDateTime),
    createdAt: IsoDateTime,
    updatedAt: IsoDateTime,
  },
  { $id: "StagedAction" },
);
export type StagedAction = Static<typeof StagedAction>;

export const NightShiftNight = Type.Object(
  {
    id: Id,
    /** Local date, `YYYY-MM-DD`. */
    night: Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }),
    status: NightShiftNightStatus,
    stopReason: Nullable(Type.String({ maxLength: 120 })),
    candidates: Nullable(Type.Unknown()),
    spentUsd: Type.Number({ minimum: 0 }),
    tokens: Type.Integer({ minimum: 0 }),
    reviewStatus: NightShiftReviewStatus,
    expiresAt: Nullable(IsoDateTime),
    startedAt: Nullable(IsoDateTime),
    finishedAt: Nullable(IsoDateTime),
    createdAt: IsoDateTime,
    updatedAt: IsoDateTime,
  },
  { $id: "NightShiftNight" },
);
export type NightShiftNight = Static<typeof NightShiftNight>;

/** Counts per domain for the Home card and the brief line. */
export const NightShiftSummary = Type.Object(
  {
    id: Id,
    night: Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }),
    status: NightShiftNightStatus,
    reviewStatus: NightShiftReviewStatus,
    counts: Type.Object({
      mail: Type.Integer({ minimum: 0 }),
      calendar: Type.Integer({ minimum: 0 }),
      reminders: Type.Integer({ minimum: 0 }),
      files: Type.Integer({ minimum: 0 }),
    }),
    expiresAt: Nullable(IsoDateTime),
  },
  { $id: "NightShiftSummary" },
);
export type NightShiftSummary = Static<typeof NightShiftSummary>;

/** An item the owner ticked: bound to the exact call they saw. */
export const NightShiftApplyItem = Type.Object(
  { itemId: Id, bindingHash: Type.String({ minLength: 1, maxLength: 128 }) },
  { $id: "NightShiftApplyItem" },
);
export const NightShiftApplySend = Type.Object(
  { itemId: Id, sendHash: Type.String({ minLength: 1, maxLength: 128 }) },
  { $id: "NightShiftApplySend" },
);

export const NightShiftRefused = Type.Object(
  { itemId: Id, reason: Type.String({ maxLength: 300 }) },
  { $id: "NightShiftRefused" },
);
export type NightShiftRefused = Static<typeof NightShiftRefused>;
