import { type Static, Type } from "@sinclair/typebox";
import { Id, IsoDateTime, ModelRef, Nullable, PermissionMode, StringEnum } from "../common.ts";
import { ApprovalKind } from "./permissions.ts";
import { RunBudget } from "./threads.ts";

/**
 * Background specialists (docs/agent/specialists-2026.md §7.1): a named role that runs a job in
 * the background as a Task with its own thread, tools, model, budget and deadline, and delivers
 * exactly one result.
 */

/** Role ids are skill-defined (`metadata.psyche.specialist.role`); the six bundled ones are listed. */
export const SpecialistRoleId = Type.String({
  minLength: 1,
  maxLength: 64,
  pattern: "^[a-z][a-z0-9-]*$",
  description:
    "researcher | shopper | coder | organizer | writer | planner, or a skill-defined role",
});

/** What kind of result a role produces; it shapes the result card. */
export const SpecialistResultKind = StringEnum(["findings", "draft", "changes", "plan", "items"], {
  $id: "SpecialistResultKind",
});
export type SpecialistResultKind = Static<typeof SpecialistResultKind>;

/** One approval a job will likely need, shown at spawn (informational; grants nothing). */
export const ApprovalHint = Type.Object(
  {
    kind: ApprovalKind,
    /** Psyche's words, e.g. "Will ask before opening new sites". */
    label: Type.String({ minLength: 1, maxLength: 200 }),
    estimate: Type.Optional(Type.Integer({ minimum: 1, description: "How many, roughly" })),
  },
  { $id: "ApprovalHint" },
);
export type ApprovalHint = Static<typeof ApprovalHint>;

/** What the parent passes: references only; the specialist reads them with its tools. */
export const SpecialistInputs = Type.Object(
  {
    libraryItemIds: Type.Array(Id, { maxItems: 32 }),
    folders: Type.Array(Type.String({ minLength: 1, maxLength: 1024 }), { maxItems: 8 }),
    urls: Type.Array(Type.String({ minLength: 1, maxLength: 2048 }), { maxItems: 32 }),
  },
  { $id: "SpecialistInputs" },
);
export type SpecialistInputs = Static<typeof SpecialistInputs>;

export const SpecialistOutcome = StringEnum(["done", "partial", "failed", "cancelled"], {
  $id: "SpecialistOutcome",
});
export type SpecialistOutcome = Static<typeof SpecialistOutcome>;

export const SpecialistFinding = Type.Object(
  {
    title: Type.String({ minLength: 1, maxLength: 200 }),
    detail: Type.String({ maxLength: 2000 }),
    sources: Type.Optional(Type.Array(Type.String({ maxLength: 2048 }), { maxItems: 10 })),
  },
  { $id: "SpecialistFinding" },
);
export type SpecialistFinding = Static<typeof SpecialistFinding>;

/**
 * The one result of a job: the specialist's report (sanitized) plus what the runtime knows.
 * `tainted` results are untrusted: data, never instructions.
 */
export const SpecialistResult = Type.Object(
  {
    outcome: SpecialistOutcome,
    summary: Type.String({ maxLength: 600 }),
    findings: Type.Array(SpecialistFinding, { maxItems: 12 }),
    /** Artifact or Library item ids the job created. */
    artifacts: Type.Array(Id, { maxItems: 32 }),
    /** Suggested follow-ups, shown as the card's buttons. */
    next: Type.Array(
      Type.Object({
        label: Type.String({ minLength: 1, maxLength: 60 }),
        message: Type.String({ maxLength: 300 }),
      }),
      { maxItems: 2 },
    ),
    /** For partial and failed results: what is missing, and why. */
    gaps: Type.Array(Type.String({ maxLength: 300 }), { maxItems: 12 }),
    receipts: Type.Array(Id),
    tainted: Type.Boolean(),
    /** Why the job stopped early, when it did: `budget:tokens`, `deadline`, `owner`, `error`. */
    stopReason: Type.Optional(Type.String({ maxLength: 200 })),
    /** The C7 evaluator's verdict on `done` results that had receipts. */
    evaluator: Type.Optional(
      Type.Object({
        verdict: StringEnum(["done", "reopen", "escalate"]),
        reason: Type.String({ maxLength: 300 }),
      }),
    ),
    /** Questions answered with their recommended default after the role's wait (§4.4). */
    defaultsUsed: Type.Optional(Type.Array(Type.String({ maxLength: 200 }), { maxItems: 8 })),
  },
  { $id: "SpecialistResult" },
);
export type SpecialistResult = Static<typeof SpecialistResult>;

export const SpecialistAutomation = Type.Object(
  { id: Id, title: Type.String({ maxLength: 200 }) },
  { $id: "SpecialistAutomation" },
);
export type SpecialistAutomation = Static<typeof SpecialistAutomation>;

/** The `specialist` block on a Task (specialists §7.1). */
export const SpecialistSpec = Type.Object(
  {
    role: SpecialistRoleId,
    /** The run that spawned the job; null when an automation started it. */
    parentRunId: Nullable(Id),
    parentThreadId: Id,
    rootRunId: Nullable(Id),
    model: ModelRef,
    /** The resolved tool allowlist (after expansion and `deny`). */
    tools: Type.Array(Type.String({ minLength: 1 })),
    permissionMode: PermissionMode,
    budget: RunBudget,
    deadline: Nullable(IsoDateTime),
    inputs: SpecialistInputs,
    deliver: StringEnum(["inbox", "thread"]),
    planFirst: Type.Boolean(),
    /** Where the job stands in the specialist queue; null once it has started. */
    queuePosition: Nullable(Type.Integer({ minimum: 1 })),
    result: Nullable(SpecialistResult),
    /** The automation that started the job, when one did ("From your automation {title}"). */
    automation: Type.Optional(SpecialistAutomation),
    /** The approvals the job will likely ask for, computed at spawn (informational, §4.4). */
    preflight: Type.Optional(Type.Array(ApprovalHint, { maxItems: 16 })),
    /**
     * Set while the job is paused at a budget (§4.6): the owner's question card and why.
     * `raised` means the owner raised the limits with `tasks.update` before answering.
     */
    budgetPause: Type.Optional(
      Nullable(
        Type.Object({
          inputRequestId: Id,
          reason: Type.String({ maxLength: 200 }),
          raised: Type.Optional(Type.Boolean()),
        }),
      ),
    ),
    /** A plan-first job's plan was approved; later runs use the job's own mode (§4.1). */
    planApproved: Type.Optional(Type.Boolean()),
  },
  { $id: "SpecialistSpec" },
);
export type SpecialistSpec = Static<typeof SpecialistSpec>;

/** Owner-facing budget numbers (Settings and the spawn tool use minutes, not ms). */
export const SpecialistBudgetSetting = Type.Object(
  {
    tokens: Type.Optional(Type.Integer({ minimum: 1 })),
    costUsd: Type.Optional(Type.Number({ minimum: 0 })),
    minutes: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { $id: "SpecialistBudgetSetting" },
);
export type SpecialistBudgetSetting = Static<typeof SpecialistBudgetSetting>;

/** One role as `specialists.list` returns it: the skill's definition plus the owner's settings. */
export const SpecialistRole = Type.Object(
  {
    role: SpecialistRoleId,
    label: Type.String({ minLength: 1, maxLength: 60 }),
    description: Type.String({ maxLength: 500 }),
    /** The skill that defines it. */
    skill: Type.String({ minLength: 1 }),
    source: StringEnum(["bundled", "workspace", "home"]),
    enabled: Type.Boolean(),
    /** The model class the role asks for, and the model Settings picked for it. */
    modelClass: StringEnum(["utility", "primary", "harness", "vision"]),
    model: Nullable(ModelRef),
    maxMode: PermissionMode,
    tools: Type.Array(Type.String({ minLength: 1 })),
    result: SpecialistResultKind,
    planFirst: Type.Boolean(),
    budget: SpecialistBudgetSetting,
    caps: Type.Object({
      tokens: Type.Optional(Type.Integer({ minimum: 1 })),
      costUsd: Type.Optional(Type.Number({ minimum: 0 })),
      minutes: Type.Optional(Type.Integer({ minimum: 1 })),
      maxHours: Type.Integer({ minimum: 1 }),
    }),
    approvals: Type.Array(ApprovalKind),
  },
  { $id: "SpecialistRole" },
);
export type SpecialistRole = Static<typeof SpecialistRole>;

/** A job as mission control and `specialists.jobs` list it. */
export const SpecialistJob = Type.Object(
  {
    taskId: Id,
    runId: Nullable(Id),
    threadId: Id,
    parentThreadId: Id,
    parentRunId: Nullable(Id),
    role: SpecialistRoleId,
    title: Type.String(),
    /** The fixed vocabulary (§6.2): Queued, Working, Needs you, Done, Partial, Failed, Cancelled. */
    status: StringEnum([
      "queued",
      "working",
      "needs_you",
      "done",
      "partial",
      "failed",
      "cancelled",
    ]),
    queuePosition: Nullable(Type.Integer({ minimum: 1 })),
    budget: RunBudget,
    deadline: Nullable(IsoDateTime),
    /** The last step's label, for the row's second line. */
    lastStep: Nullable(Type.String({ maxLength: 200 })),
    /** The spawn's pre-flight: approvals the job will likely ask for (informational, §4.4). */
    /** The automation that started the job, when one did. */
    automation: Type.Optional(SpecialistAutomation),
    preflight: Type.Optional(Type.Array(ApprovalHint, { maxItems: 16 })),
    createdAt: IsoDateTime,
    updatedAt: IsoDateTime,
    result: Nullable(SpecialistResult),
  },
  { $id: "SpecialistJob" },
);
export type SpecialistJob = Static<typeof SpecialistJob>;
