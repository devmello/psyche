import { type Static, Type } from "@sinclair/typebox";
import { Id, IsoDateTime, ModelRef, Nullable, PermissionMode, Provenance, StringEnum, Usage } from "../common.ts";
import { Block } from "./blocks.ts";

/** Data model §2. */
export const ThreadKind = StringEnum(["main", "side", "incognito", "channel", "automation", "subagent"], {
  $id: "ThreadKind",
});
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
    providerNative: Nullable(Type.Unknown({ description: "Opaque provider turn, round-tripped verbatim" })),
    provenance: Provenance,
    replyToMessageId: Nullable(Id),
    channelRef: Nullable(ChannelRef),
    runId: Nullable(Id),
    createdAt: IsoDateTime,
  },
  { $id: "Message" },
);
export type Message = Static<typeof Message>;

export const RunStatus = StringEnum(
  ["running", "done", "failed", "cancelled", "awaiting_approval", "awaiting_input"],
  { $id: "RunStatus" },
);
export type RunStatus = Static<typeof RunStatus>;

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
  },
  { $id: "Run" },
);
export type Run = Static<typeof Run>;

/** How a message sent while the agent is mid-turn is queued (architecture §4.2). */
export const QueueMode = StringEnum(["steer", "followUp", "interrupt"], { $id: "QueueMode" });
export type QueueMode = Static<typeof QueueMode>;
