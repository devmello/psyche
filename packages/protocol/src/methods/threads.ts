import { type Static, Type } from "@sinclair/typebox";
import { Id, IsoDateTime, ModelRef, PermissionMode, StringEnum } from "../common.ts";
import {
  CompactionResult,
  ContextLimits,
  ContextUsage,
  EffectiveContextLimits,
} from "../schemas/context.ts";
import { Thread, ThreadActivity, ThreadKind } from "../schemas/threads.ts";
import { defineMethod, nextCursor, OkResult, pageParams } from "./define.ts";

/** `threads.*` (architecture §11; data model §2). */

export const ThreadResult = Type.Object({ thread: Thread }, { $id: "ThreadResult" });
export type ThreadResult = Static<typeof ThreadResult>;

/**
 * The newest user or agent text of a thread, for the sidebar row (UI design §2.2: title, last
 * line, time). Plain text, whitespace collapsed, at most 160 characters.
 */
export const ThreadPreview = Type.Object(
  {
    role: StringEnum(["user", "agent"]),
    text: Type.String({ maxLength: 160 }),
    at: IsoDateTime,
  },
  { $id: "ThreadPreview" },
);
export type ThreadPreview = Static<typeof ThreadPreview>;

/** A thread plus the derived activity counts and the last line the sidebar shows. */
export const ThreadListEntry = Type.Object(
  {
    thread: Thread,
    activity: ThreadActivity,
    /** Absent when the thread has no user or agent text yet. */
    lastMessage: Type.Optional(ThreadPreview),
  },
  { $id: "ThreadListEntry" },
);
export type ThreadListEntry = Static<typeof ThreadListEntry>;

const ThreadIdParams = Type.Object({ threadId: Id }, { $id: "ThreadIdParams" });

export const ThreadsMethods = {
  "threads.create": defineMethod({
    params: Type.Object({
      kind: Type.Optional(ThreadKind),
      title: Type.Optional(Type.String({ maxLength: 200 })),
      permissionMode: Type.Optional(PermissionMode),
      modelRef: Type.Optional(ModelRef),
      parentThreadId: Type.Optional(Id),
    }),
    result: ThreadResult,
    scope: "operator.write",
    sideEffecting: true,
    description:
      "Creates a thread (default kind main). Side-effecting: a retried key returns the same thread.",
  }),
  "threads.list": defineMethod({
    params: Type.Object({
      kind: Type.Optional(ThreadKind),
      includeArchived: Type.Optional(Type.Boolean()),
      pinnedOnly: Type.Optional(Type.Boolean()),
      query: Type.Optional(
        Type.String({
          minLength: 1,
          maxLength: 200,
          description: "Case-insensitive substring match on the title",
        }),
      ),
      ...pageParams,
    }),
    result: Type.Object({ threads: Type.Array(ThreadListEntry), ...nextCursor }),
    scope: "operator.read",
    description:
      "Lists threads, most recent first, each with derived activity counts (running / awaiting input / awaiting approval).",
  }),
  "threads.get": defineMethod({
    params: ThreadIdParams,
    result: ThreadListEntry,
    scope: "operator.read",
    description: "Returns one thread with its activity counts.",
  }),
  "threads.rename": defineMethod({
    params: Type.Object({ threadId: Id, title: Type.String({ minLength: 1, maxLength: 200 }) }),
    result: ThreadResult,
    scope: "operator.write",
    description: "Sets a user title (titleSource becomes user).",
  }),
  "threads.archive": defineMethod({
    params: ThreadIdParams,
    result: ThreadResult,
    scope: "operator.write",
    description: "Archives a thread; running work is not cancelled.",
  }),
  "threads.restore": defineMethod({
    params: ThreadIdParams,
    result: ThreadResult,
    scope: "operator.write",
    description: "Restores an archived thread.",
  }),
  "threads.delete": defineMethod({
    params: Type.Object({
      threadId: Id,
      alsoForget: Type.Optional(
        Type.Boolean({ description: "Also stage retraction of memory derived from this thread" }),
      ),
    }),
    result: OkResult,
    scope: "operator.write",
    description: "Deletes a thread and its messages (receipts and audit entries are kept).",
  }),
  "threads.pin": defineMethod({
    params: Type.Object({ threadId: Id, pinned: Type.Boolean() }),
    result: ThreadResult,
    scope: "operator.write",
    description: "Pins or unpins a thread.",
  }),
  "threads.update": defineMethod({
    params: Type.Object({
      threadId: Id,
      /** `auto` needs the thread's model on the auto-mode allowlist (security §7.2). */
      permissionMode: Type.Optional(PermissionMode),
      /** Per-thread `/model` pin (strict); null clears it back to the router's primary. */
      modelRef: Type.Optional(Type.Union([ModelRef, Type.Null()])),
    }),
    result: ThreadResult,
    scope: "operator.write",
    description:
      "Sets a thread's permission mode and/or model (composer /plan, /model, the mode and model pills). auto is refused with forbidden unless the thread's model is on the auto-mode allowlist; picking a model that is not allowed drops an auto thread to balanced.",
  }),
  "threads.fork": defineMethod({
    params: Type.Object({
      threadId: Id,
      messageId: Id,
      title: Type.Optional(Type.String({ maxLength: 200 })),
    }),
    result: ThreadResult,
    scope: "operator.write",
    sideEffecting: true,
    description:
      "User-initiated fork: a new side thread with the transcript up to and including messageId. Side-effecting.",
  }),
  "threads.contextUsage": defineMethod({
    params: Type.Object({ threadId: Id }),
    result: Type.Object({
      /** The last turn's usage; null before the first turn. */
      usage: Type.Union([ContextUsage, Type.Null()]),
      limits: EffectiveContextLimits,
      /** The thread's own override (empty when it follows the settings). */
      threadLimits: ContextLimits,
    }),
    scope: "operator.read",
    description:
      "A thread's context usage after its last turn (exact prompt tokens when the provider reports them) and its effective limits.",
  }),
  "threads.setContextLimits": defineMethod({
    params: Type.Object({
      threadId: Id,
      /** Null clears the override; the thread follows `context.*` settings again. */
      limits: Type.Union([ContextLimits, Type.Null()]),
    }),
    result: Type.Object({ limits: EffectiveContextLimits, threadLimits: ContextLimits }),
    scope: "operator.write",
    description:
      "Sets or clears a thread's context limits (maxTokens, compactAt, keepRecentTurns); maxTokens above the model's window is refused with invalid_params.",
  }),
  "threads.compact": defineMethod({
    params: Type.Object({ threadId: Id }),
    result: Type.Object({ compaction: Type.Union([CompactionResult, Type.Null()]) }),
    scope: "operator.write",
    sideEffecting: true,
    description:
      "Side-effecting: compacts the thread's earlier turns now (null when there is nothing to compact); conflict while the thread runs or waits on an approval.",
  }),
} as const;
