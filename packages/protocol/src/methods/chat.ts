import { Type } from "@sinclair/typebox";
import { Id, Nullable, StringEnum } from "../common.ts";
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

export const ChatMethods = {
  "chat.send": defineMethod({
    params: Type.Object({
      threadId: Id,
      content: MessageContent,
      attachments: Type.Optional(Type.Array(Id, { maxItems: 32, description: "Library item ids" })),
      mode: Type.Optional(QueueMode),
    }),
    result: ChatSendResult,
    scope: "operator.write",
    sideEffecting: true,
    description:
      "Sends a user message. If the agent is mid-turn the message is queued by mode (default followUp). Side-effecting: requires idempotencyKey; duplicates return the original result.",
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
