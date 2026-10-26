import { type Static, Type } from "@sinclair/typebox";
import { Id, IsoDateTime, Nullable, StringEnum } from "../common.ts";
import { Message, QueueMode } from "../schemas/threads.ts";
import { defineMethod, nextCursor, pageParams } from "./define.ts";

/** `chat.*` (architecture §4.2 request lifecycle). Output streams as `chat.*` / `run.*` events. */

const MessageContent = Type.String({ minLength: 1, maxLength: 200_000 });

export const ChatSendResult = Type.Object(
  {
    messageId: Id,
    runId: Nullable(Id),
    queued: Type.Boolean({
      description: "true when the agent was mid-turn and the message was queued",
    }),
  },
  { $id: "ChatSendResult" },
);

const QueuedMessageResult = Type.Object({ messageId: Id }, { $id: "QueuedMessageResult" });

/** A follow-up waiting for the current turn to settle (feature E3: visible, removable queue). */
export const QueuedMessage = Type.Object(
  {
    messageId: Id,
    threadId: Id,
    position: Type.Integer({ minimum: 0 }),
    content: Type.String(),
    attachments: Type.Array(Id),
    createdAt: IsoDateTime,
  },
  { $id: "QueuedMessage" },
);
export type QueuedMessage = Static<typeof QueuedMessage>;

export const ChatMethods = {
  "chat.send": defineMethod({
    params: Type.Object({
      threadId: Id,
      content: MessageContent,
      attachments: Type.Optional(Type.Array(Id, { maxItems: 32, description: "Library item ids" })),
      mode: Type.Optional(QueueMode),
      /**
       * Quote-reply (feature E5): the message this one answers, in the same thread. Stored as
       * `Message.replyToMessageId`; the agent sees the quoted text ahead of the new message.
       */
      replyToMessageId: Type.Optional(Id),
      /**
       * Redo (teaching loop §5.1): answer `messageId` again, with the owner's instruction
       * ("shorter") or without the lessons it used. A redo with an instruction is recorded as
       * `regenerated` feedback.
       */
      redo: Type.Optional(
        Type.Object({
          messageId: Id,
          instruction: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
          withoutLessons: Type.Optional(Type.Boolean()),
        }),
      ),
    }),
    result: ChatSendResult,
    scope: "operator.write",
    sideEffecting: true,
    description:
      "Sends a user message. If the agent is mid-turn the message is queued by mode (default followUp). Side-effecting: requires idempotencyKey; duplicates return the original result.",
  }),
  "chat.greet": defineMethod({
    params: Type.Object({ threadId: Id }),
    result: Type.Object({
      started: Type.Boolean(),
      runId: Nullable(Id),
    }),
    scope: "operator.write",
    sideEffecting: true,
    description:
      "Starts the agent's first message in an empty thread (the greeting after onboarding; UI design §4.13: the main chat opens with the agent's first message). Runs a turn with no user message, from a fixed Gateway prompt; BOOTSTRAP.md guides it while it exists. Does nothing (started false) when the thread has any message or a run. Side-effecting: requires idempotencyKey.",
  }),
  "chat.history": defineMethod({
    params: Type.Object({ threadId: Id, ...pageParams }),
    result: Type.Object({ messages: Type.Array(Message), ...nextCursor }),
    scope: "operator.read",
    description: "Pages the transcript backwards from the newest message.",
  }),
  "chat.cancel": defineMethod({
    params: Type.Object({ threadId: Id, runId: Type.Optional(Id) }),
    result: Type.Object({ cancelled: Type.Boolean() }),
    scope: "operator.write",
    description: "Cancels the active run (or the given run) in a thread.",
  }),
  "chat.steer": defineMethod({
    params: Type.Object({ threadId: Id, content: MessageContent }),
    result: QueuedMessageResult,
    scope: "operator.write",
    sideEffecting: true,
    description: "Interrupts the current tool loop with new guidance. Side-effecting.",
  }),
  "chat.followUp": defineMethod({
    params: Type.Object({ threadId: Id, content: MessageContent }),
    result: QueuedMessageResult,
    scope: "operator.write",
    sideEffecting: true,
    description: "Queues a message to run after the current turn settles. Side-effecting.",
  }),
  "chat.queue.list": defineMethod({
    params: Type.Object({ threadId: Id }),
    result: Type.Object({ items: Type.Array(QueuedMessage) }),
    scope: "operator.read",
    description: "Lists the thread's queued follow-ups in the order they will run.",
  }),
  "chat.queue.remove": defineMethod({
    params: Type.Object({ threadId: Id, messageId: Id }),
    result: Type.Object({ removed: Type.Boolean() }),
    scope: "operator.write",
    description:
      "Removes a queued follow-up before it starts; false when it already started or is unknown.",
  }),
  "chat.export": defineMethod({
    params: Type.Object({
      threadId: Id,
      format: StringEnum(["markdown", "json"], { $id: "ChatExportFormat" }),
    }),
    result: Type.Object({ mime: Type.String(), content: Type.String() }),
    scope: "operator.read",
    description: "Exports a transcript as Markdown or JSON.",
  }),
} as const;
