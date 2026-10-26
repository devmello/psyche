import { type Static, Type } from "@sinclair/typebox";
import { Id, IsoDateTime, ModelRef, Nullable, StringEnum, Usage } from "../common.ts";
import { Run, RunStatus } from "./threads.ts";

/**
 * The run trace (docs/design/run-trace-2026.md §4.2): one append-only list of steps per run,
 * written by the Gateway for every run (chat, Task, automation, helper). The chat's step log and
 * the agent sheet's Timeline both read these, so a step never says two things. Every string is
 * redacted at write; reasoning text and frames expire on the owner's retention settings.
 */

/** Run trace §4.5. */
export const RUN_STEP_LIMITS = {
  stepsPerRun: 2000,
  labelChars: 160,
  targetChars: 120,
  previewBytes: 2048,
  payloadBytes: 1024 * 1024,
  thinkingBytes: 64 * 1024,
  framesPerRun: 600,
  thinkingSummaryChars: 120,
  earlierAttempts: 5,
} as const;

export const RunStepKind = StringEnum(
  [
    "thinking",
    "model",
    "tool",
    "approval",
    "question",
    "subagent",
    "text",
    "memory",
    "artifact",
    "note",
  ],
  { $id: "RunStepKind" },
);
export type RunStepKind = Static<typeof RunStepKind>;

export const RunStepStatus = StringEnum(
  ["pending", "running", "ok", "failed", "waiting", "cancelled", "skipped"],
  { $id: "RunStepStatus" },
);
export type RunStepStatus = Static<typeof RunStepStatus>;

export const RunStepError = Type.Object(
  {
    code: Type.String({ minLength: 1, maxLength: 64 }),
    message: Type.String({ maxLength: 1000 }),
    retryable: Type.Boolean(),
  },
  { $id: "RunStepError" },
);
export type RunStepError = Static<typeof RunStepError>;

/** An earlier attempt of a retried step (the current one is the step itself). */
export const RunStepAttempt = Type.Object(
  {
    startedAt: IsoDateTime,
    endedAt: Nullable(IsoDateTime),
    status: RunStepStatus,
    error: Type.Optional(RunStepError),
  },
  { $id: "RunStepAttempt" },
);
export type RunStepAttempt = Static<typeof RunStepAttempt>;

export const RunStep = Type.Object(
  {
    /** `stp_…`; a thinking step's id is its `chat.reasoning` stepId. */
    id: Id,
    runId: Id,
    seq: Type.Integer({ minimum: 1, description: "Per run, monotonic from 1: the replay order" }),
    /** A helper's steps point at the spawn step on the parent run. */
    parentStepId: Type.Optional(Id),
    /** Steps dispatched together (a parallel group). */
    groupId: Type.Optional(Id),
    kind: RunStepKind,
    status: RunStepStatus,
    /** The status line ("Searching flights"), redacted. */
    label: Type.String({ maxLength: RUN_STEP_LIMITS.labelChars }),
    /** The past-tense form once ended ("Searched flights"). */
    doneLabel: Type.Optional(Type.String({ maxLength: RUN_STEP_LIMITS.labelChars })),
    /** A domain, file or recipient, redacted. */
    target: Type.Optional(Type.String({ maxLength: RUN_STEP_LIMITS.targetChars })),
    startedAt: IsoDateTime,
    endedAt: Nullable(IsoDateTime),
    /** 1-based; a retry adds an attempt to the same step. */
    attempt: Type.Integer({ minimum: 1 }),
    attempts: Type.Optional(
      Type.Array(RunStepAttempt, { maxItems: RUN_STEP_LIMITS.earlierAttempts }),
    ),
    toolCallId: Type.Optional(Id),
    approvalId: Type.Optional(Id),
    inputRequestId: Type.Optional(Id),
    receiptId: Type.Optional(Id),
    artifactId: Type.Optional(Id),
    memoryPath: Type.Optional(Type.String({ maxLength: 1024 })),
    /** Subagent steps: the helper's own run, and its Task when it has one. */
    childRunId: Type.Optional(Id),
    taskId: Type.Optional(Id),
    /** Model steps. */
    modelRef: Type.Optional(ModelRef),
    usage: Type.Optional(Usage),
    /** The last progress update of a running tool (throttled). */
    progress: Type.Optional(
      Type.Object({
        message: Type.Optional(Type.String({ maxLength: RUN_STEP_LIMITS.labelChars })),
        fraction: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
      }),
    ),
    /** Short, redacted previews; the bodies are read with `runs.step`. */
    preview: Type.Optional(
      Type.Object({
        input: Type.Optional(Type.String({ maxLength: RUN_STEP_LIMITS.previewBytes })),
        output: Type.Optional(Type.String({ maxLength: RUN_STEP_LIMITS.previewBytes })),
      }),
    ),
    payloadRef: Type.Optional(Type.Object({ input: Type.Optional(Id), output: Type.Optional(Id) })),
    /** The frame seq range this step saw in the run's recording. */
    frames: Type.Optional(
      Type.Object({ first: Type.Integer({ minimum: 1 }), last: Type.Integer({ minimum: 1 }) }),
    ),
    /**
     * Thinking: the summary line stays with the thread; `full` is kept for
     * `data.reasoningRetentionDays` and never sent in `run.step` (read it with `runs.step`).
     * `expiresAt` stays after expiry so the UI can say why the detail is gone.
     */
    text: Type.Optional(
      Type.Object({
        summary: Type.String({ maxLength: RUN_STEP_LIMITS.thinkingSummaryChars }),
        full: Type.Optional(Type.String({ maxLength: RUN_STEP_LIMITS.thinkingBytes })),
        expiresAt: Type.Optional(IsoDateTime),
      }),
    ),
    error: Type.Optional(RunStepError),
  },
  { $id: "RunStep" },
);
export type RunStep = Static<typeof RunStep>;

/** A `runs.list` row: the run with what Activity draws without reading its steps. */
export const RunSummary = Type.Object(
  {
    ...Run.properties,
    currentStep: Type.Optional(
      Type.Object({ label: Type.String(), status: RunStepStatus, startedAt: IsoDateTime }),
    ),
    /** Steps per 5 s bucket over the last minute (12 buckets), for the sparkline. */
    activity: Type.Optional(
      Type.Array(Type.Integer({ minimum: 0 }), { minItems: 12, maxItems: 12 }),
    ),
    /** Automations: the last 10 runs' durations, newest first. */
    durationsMs: Type.Optional(Type.Array(Type.Integer({ minimum: 0 }), { maxItems: 10 })),
  },
  { $id: "RunSummary" },
);
export type RunSummary = Static<typeof RunSummary>;

/** One frame Psyche saw (browser or computer use), in the run's recording. */
export const RunFrame = Type.Object(
  {
    seq: Type.Integer({ minimum: 1 }),
    at: IsoDateTime,
    stepId: Nullable(Id),
    width: Type.Integer({ minimum: 1 }),
    height: Type.Integer({ minimum: 1 }),
    /** Gone after `data.replayRetentionDays`; the row stays. */
    expired: Type.Optional(Type.Boolean()),
  },
  { $id: "RunFrame" },
);
export type RunFrame = Static<typeof RunFrame>;

export const RunTraceFormat = StringEnum(["psyche-trace+json", "markdown"], {
  $id: "RunTraceFormat",
});
export type RunTraceFormat = Static<typeof RunTraceFormat>;

export const RUN_TRACE_FORMAT = "psyche-trace" as const;
export const RUN_TRACE_VERSION = 1 as const;

/** `psyche-trace+json` v1 step: OTel GenAI attribute names where one exists (§4.7). */
export const TraceStep = Type.Object(
  {
    id: Id,
    seq: Type.Integer({ minimum: 1 }),
    parentStepId: Type.Optional(Id),
    groupId: Type.Optional(Id),
    kind: RunStepKind,
    status: RunStepStatus,
    label: Type.String(),
    target: Type.Optional(Type.String()),
    startedAt: IsoDateTime,
    endedAt: Nullable(IsoDateTime),
    attempt: Type.Integer({ minimum: 1 }),
    attributes: Type.Record(
      Type.String(),
      Type.Union([Type.String(), Type.Number(), Type.Boolean()]),
    ),
    input: Type.Optional(Type.Unknown()),
    output: Type.Optional(Type.Unknown()),
    thinking: Type.Optional(Type.String()),
    error: Type.Optional(RunStepError),
    childRunId: Type.Optional(Id),
  },
  { $id: "TraceStep" },
);
export type TraceStep = Static<typeof TraceStep>;

export const TraceRun = Type.Object(
  {
    id: Id,
    kind: Type.Optional(Type.String()),
    title: Type.Optional(Type.String()),
    status: RunStatus,
    startedAt: IsoDateTime,
    endedAt: Nullable(IsoDateTime),
    usage: Usage,
    model: Type.String(),
    parentRunId: Nullable(Id),
  },
  { $id: "TraceRun" },
);
export type TraceRun = Static<typeof TraceRun>;

/** A helper's run inside an export: the same shape, one level down at a time. */
export const TraceChild = Type.Object(
  { run: TraceRun, steps: Type.Array(TraceStep) },
  { $id: "TraceChild" },
);
export type TraceChild = Static<typeof TraceChild>;

/** The `psyche-trace+json` v1 document (run trace §4.7). With frames it ships as a .zip. */
export const PsycheTrace = Type.Object(
  {
    format: Type.Literal(RUN_TRACE_FORMAT),
    version: Type.Literal(RUN_TRACE_VERSION),
    exportedAt: IsoDateTime,
    redacted: Type.Literal(true),
    run: TraceRun,
    steps: Type.Array(TraceStep),
    children: Type.Array(TraceChild),
    frames: Type.Array(
      Type.Object({
        seq: Type.Integer({ minimum: 1 }),
        at: IsoDateTime,
        stepId: Nullable(Id),
        file: Type.String(),
      }),
    ),
  },
  { $id: "PsycheTrace" },
);
export type PsycheTrace = Static<typeof PsycheTrace>;
