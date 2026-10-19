import { type Static, Type } from "@sinclair/typebox";
import { Id, ModelRef, PermissionMode } from "../common.ts";
import { Thread, ThreadActivity, ThreadKind } from "../schemas/threads.ts";
import { defineMethod, nextCursor, OkResult, pageParams } from "./define.ts";

/** `threads.*` (architecture §11; data model §2). */

export const ThreadResult = Type.Object({ thread: Thread }, { $id: "ThreadResult" });
export type ThreadResult = Static<typeof ThreadResult>;

/** A thread plus the derived activity counts the sidebar shows. */
export const ThreadListEntry = Type.Object(
  { thread: Thread, activity: ThreadActivity },
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
} as const;
