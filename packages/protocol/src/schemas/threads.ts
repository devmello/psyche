import { type Static, Type } from "@sinclair/typebox";
import {
  Id,
  IsoDateTime,
  ModelRef,
  Nullable,
  PermissionMode,
  Provenance,
  StringEnum,
  Usage,
} from "../common.ts";
import { Block } from "./blocks.ts";
import { LessonRef } from "./learning.ts";

/** Data model §2. */
export const ThreadKind = StringEnum(
  ["main", "side", "incognito", "channel", "automation", "subagent"],
  {
    $id: "ThreadKind",
  },
);
export type ThreadKind = Static<typeof ThreadKind>;

export const Thread = Type.Object(
  {
    id: Id,
    kind: ThreadKind,
    title: Type.String(),
    titleSource: StringEnum(["user", "auto"]),
    parentThreadId: Nullable(Id),
    forkedFromMessageId: Nullable(Id),
    sessionKey: Type.String({ description: 'e.g. "owner:main", "telegram:peer:12345"' }),
    personaOverlay: Nullable(Type.String()),
    permissionMode: PermissionMode,
    modelRef: Nullable(ModelRef),
    pinned: Type.Boolean(),
    archivedAt: Nullable(IsoDateTime),
    expiresAt: Nullable(IsoDateTime),
    activeWriterRunId: Nullable(Id),
    createdAt: IsoDateTime,
    updatedAt: IsoDateTime,
    lastMessageAt: Nullable(IsoDateTime),
  },
  { $id: "Thread" },
);
export type Thread = Static<typeof Thread>;

/** Derived counts `threads.list` returns per thread (architecture §11). */
export const ThreadActivity = Type.Object(
  {
    running: Type.Integer({ minimum: 0 }),
    awaitingInput: Type.Integer({ minimum: 0 }),
    awaitingApproval: Type.Integer({ minimum: 0 }),
  },
  { $id: "ThreadActivity" },
);
export type ThreadActivity = Static<typeof ThreadActivity>;

export const MessageRole = StringEnum(["user", "agent", "system", "tool"], { $id: "MessageRole" });
export type MessageRole = Static<typeof MessageRole>;

export const ChannelRef = Type.Object(
  { channel: Type.String(), account: Type.String(), messageId: Type.String() },
  { $id: "ChannelRef" },
);
export type ChannelRef = Static<typeof ChannelRef>;

export const Message = Type.Object(
  {
    id: Id,
    threadId: Id,
    seq: Type.Integer({ minimum: 0 }),
    role: MessageRole,
    blocks: Type.Array(Block),
    providerNative: Nullable(
      Type.Unknown({ description: "Opaque provider turn, round-tripped verbatim" }),
    ),
    provenance: Provenance,
    replyToMessageId: Nullable(Id),
    channelRef: Nullable(ChannelRef),
    runId: Nullable(Id),
    createdAt: IsoDateTime,
    /**
     * Lessons the Gateway put in this answer's prompt (the "Used n lessons" chip; teaching loop
     * §5.1). Filled by the Gateway when it assembles the prompt; absent when none applied.
     */
    lessonsApplied: Type.Optional(Type.Array(LessonRef, { maxItems: 20 })),
  },
  { $id: "Message" },
);
export type Message = Static<typeof Message>;

export const RunStatus = StringEnum(
  ["running", "done", "failed", "cancelled", "awaiting_approval", "awaiting_input"],
  { $id: "RunStatus" },
);
export type RunStatus = Static<typeof RunStatus>;

/** What started a run (run trace §4.2): a chat turn, a Task, an automation, or a helper. */
export const RunKind = StringEnum(["chat", "task", "automation", "subagent"], { $id: "RunKind" });
export type RunKind = Static<typeof RunKind>;

export const RunOrigin = StringEnum(["owner", "automation", "channel", "subagent"], {
  $id: "RunOrigin",
});
export type RunOrigin = Static<typeof RunOrigin>;

/**
 * A run's budget and what it used (run-trace §4.2; docs/agent/specialists-2026.md §4.6).
 * `costUsd` is null for unpriced (subscription) runs; clients show "—".
 */
export const RunBudget = Type.Object(
  {
    limit: Type.Object({
      steps: Type.Optional(Type.Integer({ minimum: 1 })),
      tokens: Type.Optional(Type.Integer({ minimum: 1 })),
      wallMs: Type.Optional(Type.Integer({ minimum: 1 })),
      costUsd: Type.Optional(Nullable(Type.Number({ minimum: 0 }))),
    }),
    used: Type.Object({
      steps: Type.Integer({ minimum: 0 }),
      tokens: Type.Integer({ minimum: 0 }),
      wallMs: Type.Integer({ minimum: 0 }),
      costUsd: Type.Optional(Nullable(Type.Number({ minimum: 0 }))),
      /** Spent on calls retried after provider or transport errors (specialists §4.6). */
      retried: Type.Optional(
        Type.Object({
          tokens: Type.Integer({ minimum: 0 }),
          costUsd: Nullable(Type.Number({ minimum: 0 })),
        }),
      ),
    }),
  },
  { $id: "RunBudget" },
);
export type RunBudget = Static<typeof RunBudget>;

export const Run = Type.Object(
  {
    id: Id,
    threadId: Id,
    status: RunStatus,
    modelRef: ModelRef,
    attempt: Type.Integer({ minimum: 1 }),
    startedAt: IsoDateTime,
    endedAt: Nullable(IsoDateTime),
    error: Nullable(Type.String()),
    usage: Usage,
    // Run trace §4.2 (additive). Helper and specialist runs are child runs: `parentRunId` is the
    // run that spawned them, `rootRunId` the top of the tree (shared with S02's specialists).
    kind: Type.Optional(RunKind),
    title: Type.Optional(Type.String({ maxLength: 160 })),
    parentRunId: Nullable(Id),
    rootRunId: Nullable(Id),
    taskId: Nullable(Id),
    automationRunId: Nullable(Id),
    stepCount: Type.Optional(Type.Integer({ minimum: 0 })),
    currentStepId: Nullable(Id),
    lastStepAt: Nullable(IsoDateTime),
    origin: Type.Optional(RunOrigin),
    budget: Type.Optional(RunBudget),
    deadline: Nullable(IsoDateTime),
    /** The branch label for an S02 specialist. */
    specialist: Type.Optional(Type.Object({ role: Type.String({ minLength: 1, maxLength: 64 }) })),
    /** Why the trace differs from what ran ("Some steps were folded"). */
    note: Type.Optional(Type.String({ maxLength: 160 })),
  },
  { $id: "Run" },
);
export type Run = Static<typeof Run>;

/** How a message sent while the agent is mid-turn is queued (architecture §4.2). */
export const QueueMode = StringEnum(["steer", "followUp", "interrupt"], { $id: "QueueMode" });
export type QueueMode = Static<typeof QueueMode>;
