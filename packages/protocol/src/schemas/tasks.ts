import { type Static, Type } from "@sinclair/typebox";
import { Id, IsoDateTime, JsonObject, Nullable, StringEnum } from "../common.ts";
import { ChecklistItem } from "./blocks.ts";
import { LessonRef } from "./learning.ts";
import { TaintSource } from "./permissions.ts";
import { SpecialistSpec } from "./specialists.ts";

/** Data model §3; architecture §4.5. */
export const TaskStatus = StringEnum(
  [
    "queued",
    "running",
    "awaiting_input",
    "awaiting_approval",
    "paused",
    "done",
    "failed",
    "cancelled",
  ],
  { $id: "TaskStatus" },
);
export type TaskStatus = Static<typeof TaskStatus>;

export const TaskOrigin = StringEnum(
  ["chat", "automation", "idea", "goal", "channel", "subagent"],
  {
    $id: "TaskOrigin",
  },
);
export type TaskOrigin = Static<typeof TaskOrigin>;

/**
 * Where a Task's commands run (features K1, L1–L5; architecture §9, §10): `sandbox` is the
 * per-task container on the Gateway host, `vm` the sandbox Mac guest, through its paired
 * psyche-node. Absent means the owner's default (`vm.defaultWorkspace`, else `sandbox`).
 */
export const TaskWorkspace = StringEnum(["sandbox", "vm"], { $id: "TaskWorkspace" });
export type TaskWorkspace = Static<typeof TaskWorkspace>;

export const PlanStepStatus = StringEnum(["pending", "running", "done", "failed", "skipped"], {
  $id: "PlanStepStatus",
});

export const PlanStep = Type.Object(
  { id: Id, title: Type.String(), status: PlanStepStatus, note: Type.Optional(Type.String()) },
  { $id: "PlanStep" },
);
export type PlanStep = Static<typeof PlanStep>;

export const TaskPlan = Type.Object(
  { approvedAt: Nullable(IsoDateTime), steps: Type.Array(PlanStep) },
  { $id: "TaskPlan" },
);
export type TaskPlan = Static<typeof TaskPlan>;

export const Task = Type.Object(
  {
    id: Id,
    threadId: Id,
    title: Type.String(),
    goal: Type.String(),
    status: TaskStatus,
    createdFrom: TaskOrigin,
    plan: Nullable(TaskPlan),
    checklist: Type.Array(ChecklistItem),
    currentStepId: Nullable(Id),
    attempt: Type.Integer({ minimum: 0 }),
    leaseOwner: Nullable(Type.String()),
    leaseUntil: Nullable(IsoDateTime),
    browserSessionId: Nullable(Id),
    sandboxId: Nullable(Id),
    workspace: Type.Optional(TaskWorkspace),
    summary: Nullable(Type.String()),
    outcome: Nullable(JsonObject),
    taint: Type.Optional(Type.Boolean({ description: "Inherited from a tainted creating turn" })),
    taintSources: Type.Optional(
      Type.Array(TaintSource, {
        description: "The creating turn's taint sources; every run starts tainted with them",
      }),
    ),
    /** Set when the task is a background specialist's job (docs/agent/specialists-2026.md §7.1). */
    specialist: Type.Optional(SpecialistSpec),
    createdAt: IsoDateTime,
    updatedAt: IsoDateTime,
    completedAt: Nullable(IsoDateTime),
    /** Lessons the Gateway applied to this task's runs (teaching loop §5.1); absent when none. */
    lessonsApplied: Type.Optional(Type.Array(LessonRef, { maxItems: 20 })),
  },
  { $id: "Task" },
);
export type Task = Static<typeof Task>;

export const CheckpointStatus = StringEnum(["pending", "running", "done", "failed", "uncertain"], {
  $id: "CheckpointStatus",
});

export const TaskCheckpoint = Type.Object(
  {
    id: Id,
    taskId: Id,
    stepId: Id,
    idx: Type.Integer({ minimum: 0 }),
    replaySafe: Type.Boolean(),
    status: CheckpointStatus,
    payload: Nullable(JsonObject),
    receiptId: Nullable(Id),
    createdAt: IsoDateTime,
  },
  { $id: "TaskCheckpoint" },
);
export type TaskCheckpoint = Static<typeof TaskCheckpoint>;

/** One Activity line with three disclosure levels. */
export const TaskAction = Type.Object(
  {
    id: Id,
    taskId: Id,
    idx: Type.Integer({ minimum: 0 }),
    toolCallId: Nullable(Id),
    level1: Type.String(),
    level2: Type.Object({
      tool: Type.String(),
      target: Type.Optional(Type.String()),
      outcome: Type.Optional(Type.String()),
    }),
    level3Ref: Nullable(Type.String()),
    createdAt: IsoDateTime,
  },
  { $id: "TaskAction" },
);
export type TaskAction = Static<typeof TaskAction>;

/** `ask_user` payload (feature C4): 1–4 questions, 2–4 options, header ≤ 12 chars. */
export const QuestionOption = Type.Object(
  {
    label: Type.String({ minLength: 1 }),
    description: Type.Optional(Type.String()),
    preview: Type.Optional(Type.String()),
  },
  { $id: "QuestionOption" },
);

export const Question = Type.Object(
  {
    question: Type.String({ minLength: 1 }),
    header: Type.String({ minLength: 1, maxLength: 12 }),
    options: Type.Array(QuestionOption, { minItems: 2, maxItems: 4 }),
    multiSelect: Type.Boolean(),
  },
  { $id: "Question" },
);
export type Question = Static<typeof Question>;

export const InputRequestStatus = StringEnum(["open", "answered", "cancelled"], {
  $id: "InputRequestStatus",
});

export const InputRequest = Type.Object(
  {
    id: Id,
    taskId: Nullable(Id),
    threadId: Id,
    questions: Type.Array(Question, { minItems: 1, maxItems: 4 }),
    status: InputRequestStatus,
    answer: Nullable(
      Type.Record(Type.String(), Type.Union([Type.String(), Type.Array(Type.String())])),
    ),
    createdAt: IsoDateTime,
    answeredAt: Nullable(IsoDateTime),
    answeredByDeviceId: Nullable(Id),
  },
  { $id: "InputRequest" },
);
export type InputRequest = Static<typeof InputRequest>;
