import type { Block } from "@psyche/protocol";

/** Per-type block shapes (data model §9.1); the protocol exports only the union. */
export type BlockOf<T extends Block["type"]> = Extract<Block, { type: T }>;
export type TextBlock = BlockOf<"text">;
export type ToolCallBlock = BlockOf<"tool_call">;
export type PlanBlock = BlockOf<"plan">;
export type ChecklistBlock = BlockOf<"checklist">;
export type ApprovalBlock = BlockOf<"approval">;
export type QuestionBlock = BlockOf<"question">;
export type ArtifactBlock = BlockOf<"artifact">;
export type FileBlock = BlockOf<"file">;
export type ReceiptBlock = BlockOf<"receipt">;
export type TaskBlock = BlockOf<"task">;
export type WrapUpBlock = BlockOf<"wrap_up">;
export type AutomationWorkflowBlock = BlockOf<"automation_workflow">;
