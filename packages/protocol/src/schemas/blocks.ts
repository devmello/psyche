import { type Static, Type } from "@sinclair/typebox";
import { Id, IsoDateTime, Nullable, StringEnum } from "../common.ts";
import { CompactionSummary } from "./context.ts";
import { LearnedFact } from "./memory.ts";

/** Message content blocks (data model §9.1). Discriminated on `type`. */

export const ToolCallStatus = StringEnum(
  ["pending", "running", "ok", "failed", "uncertain", "blocked"],
  {
    $id: "ToolCallStatus",
  },
);
export type ToolCallStatus = Static<typeof ToolCallStatus>;

export const ChecklistItemStatus = StringEnum(["pending", "in_progress", "completed"], {
  $id: "ChecklistItemStatus",
});
export type ChecklistItemStatus = Static<typeof ChecklistItemStatus>;

export const ChecklistItem = Type.Object(
  { text: Type.String(), status: ChecklistItemStatus },
  { $id: "ChecklistItem" },
);
export type ChecklistItem = Static<typeof ChecklistItem>;

export const WrapUpAction = Type.Object(
  { label: Type.String(), message: Type.Optional(Type.String()) },
  { $id: "WrapUpAction" },
);

export const TextBlock = Type.Object(
  { type: Type.Literal("text"), md: Type.String() },
  { $id: "TextBlock" },
);
export const ToolCallBlock = Type.Object(
  {
    type: Type.Literal("tool_call"),
    toolCallId: Id,
    tool: Type.String(),
    status: ToolCallStatus,
    level1: Type.String({ description: "One-line status shown in the transcript" }),
  },
  { $id: "ToolCallBlock" },
);
export const PlanBlock = Type.Object(
  { type: Type.Literal("plan"), planId: Id },
  { $id: "PlanBlock" },
);
export const ChecklistBlock = Type.Object(
  { type: Type.Literal("checklist"), items: Type.Array(ChecklistItem) },
  { $id: "ChecklistBlock" },
);
export const ApprovalBlock = Type.Object(
  { type: Type.Literal("approval"), approvalId: Id },
  { $id: "ApprovalBlock" },
);
export const QuestionBlock = Type.Object(
  { type: Type.Literal("question"), inputRequestId: Id },
  { $id: "QuestionBlock" },
);
export const ArtifactBlock = Type.Object(
  { type: Type.Literal("artifact"), artifactId: Id, preview: Type.Optional(Type.String()) },
  { $id: "ArtifactBlock" },
);
export const FileBlock = Type.Object(
  { type: Type.Literal("file"), libraryItemId: Id },
  { $id: "FileBlock" },
);
/**
 * What a user message was about (Feed "Ask about this"), shown as a compact quoted card. The title
 * and host come from fetched web content (untrusted): render them as plain text.
 */
export const ContextBlock = Type.Object(
  {
    type: Type.Literal("context"),
    kind: Type.Literal("feed_item"),
    id: Id,
    title: Type.String({ maxLength: 300 }),
    url: Type.Optional(Type.String({ maxLength: 2000 })),
    source: Type.Optional(Type.String({ maxLength: 200 })),
  },
  { $id: "ContextBlock" },
);
export const ReceiptBlock = Type.Object(
  { type: Type.Literal("receipt"), receiptId: Id },
  { $id: "ReceiptBlock" },
);
export const TaskBlock = Type.Object(
  { type: Type.Literal("task"), taskId: Id },
  { $id: "TaskBlock" },
);
export const WrapUpBlock = Type.Object(
  {
    type: Type.Literal("wrap_up"),
    recap: Type.String(),
    ask: Type.Optional(Type.String()),
    actions: Type.Optional(Type.Array(WrapUpAction, { maxItems: 2 })),
  },
  { $id: "WrapUpBlock" },
);

/**
 * Feature E12 (cross-thread awareness): which of the owner's other chats the turn drew on, shown
 * as a collapsible "From your other chats" block in the reply. Titles and snippets come from
 * those chats' digests (untrusted data): render them as plain text, never as Markdown.
 */
export const RelatedThread = Type.Object(
  {
    threadId: Id,
    title: Type.String({ maxLength: 200 }),
    snippet: Type.String({ maxLength: 500 }),
    lastMessageAt: Nullable(IsoDateTime),
  },
  { $id: "RelatedThread" },
);

export const RelatedThreadsBlock = Type.Object(
  {
    type: Type.Literal("related_threads"),
    items: Type.Array(RelatedThread, { minItems: 1, maxItems: 5 }),
  },
  { $id: "RelatedThreadsBlock" },
);

/**
 * Features B7 / C2: a compaction of the thread's earlier turns, kept as a `system` message where
 * it happened. The turns it replaced stay in the transcript (recoverable); the model reads this
 * summary instead of them. Summary text is the utility model's: plain text, never Markdown.
 */
export const CompactionBlock = Type.Object(
  {
    type: Type.Literal("compaction"),
    compactionId: Id,
    trigger: StringEnum(["auto", "manual"]),
    summary: CompactionSummary,
    replaced: Type.Object({
      turns: Type.Integer({ minimum: 0 }),
      fromMessageId: Nullable(Id),
      toMessageId: Nullable(Id),
    }),
    tokensBefore: Type.Integer({ minimum: 0 }),
    tokensAfter: Type.Integer({ minimum: 0 }),
  },
  { $id: "CompactionBlock" },
);

/**
 * Feature #509: "Learned: …" in the chat, after a turn taught Psyche something about the owner
 * (written to `USER.md`). Each item can be undone with `memory.forgetLearned`.
 */
export const LearnedBlock = Type.Object(
  {
    type: Type.Literal("learned"),
    items: Type.Array(LearnedFact, { minItems: 1, maxItems: 10 }),
  },
  { $id: "LearnedBlock" },
);

/**
 * The teaching loop (docs/agent/teaching-loop-2026.md §5.1): "Psyche will remember: …" under the
 * message the owner corrected, with Undo (`memory.lessons.forget`) and Change
 * (`memory.lessons.edit`). `lessonId` is null when Psyche only noted the feedback.
 */
export const TaughtBlock = Type.Object(
  {
    type: Type.Literal("taught"),
    feedbackId: Id,
    lessonId: Nullable(Id),
    /** The lesson statement, or null with "Thanks. Psyche noted it." */
    statement: Nullable(Type.String({ maxLength: 300 })),
    /** The message the feedback was about. */
    messageId: Id,
  },
  { $id: "TaughtBlock" },
);

/**
 * A specialist job's result as a transcript block (docs/design/chat-experience-2026.md §4.5):
 * posted in the thread that spawned the job when it reports; the same result also stays in the
 * Feed and Inbox. The card reads the job (`specialists.get`) by `taskId`, so nothing is copied.
 */
export const SpecialistResultBlock = Type.Object(
  { type: Type.Literal("specialist_result"), taskId: Id },
  { $id: "SpecialistResultBlock" },
);

export const Block = Type.Union(
  [
    TextBlock,
    ToolCallBlock,
    PlanBlock,
    ChecklistBlock,
    ApprovalBlock,
    QuestionBlock,
    ArtifactBlock,
    FileBlock,
    ContextBlock,
    ReceiptBlock,
    TaskBlock,
    WrapUpBlock,
    RelatedThreadsBlock,
    CompactionBlock,
    LearnedBlock,
    TaughtBlock,
    SpecialistResultBlock,
  ],
  { $id: "Block" },
);
export type Block = Static<typeof Block>;
export type BlockType = Block["type"];
