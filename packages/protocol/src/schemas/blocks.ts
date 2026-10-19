import { type Static, Type } from "@sinclair/typebox";
import { Id, StringEnum } from "../common.ts";

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
    ReceiptBlock,
    TaskBlock,
    WrapUpBlock,
  ],
  { $id: "Block" },
);
export type Block = Static<typeof Block>;
export type BlockType = Block["type"];
