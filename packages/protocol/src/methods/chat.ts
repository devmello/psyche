import { type Static, Type } from "@sinclair/typebox";
import { Id, IsoDateTime, Nullable, StringEnum } from "../common.ts";
import { Message, QueueMode } from "../schemas/threads.ts";
import { defineMethod, nextCursor, pageParams } from "./define.ts";
import { ChatScreenRef } from "./screen.ts";

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

/**
 * What a message is asking about (Feed "Ask about this", or a search result opened in a side
 * chat): the Gateway resolves it, gives the agent
 * the item's text as untrusted context ahead of the message, and records a `context` block on the
 * user message so the transcript keeps showing what the question was about.
 */
export const ChatContextRef = Type.Object(
  {
    kind: StringEnum(["feed_item", "search_hit", "memory_entity", "life_answer", "mail_followup"]),
    id: Id,
    /**
     * `search_hit` only: what the window labelled the result, for the card it shows. The Gateway
     * reads the result itself by `id` (text, kind, trust) and never takes text or trust from here.
     * `memory_entity` ("Continue in chat" on a Memory page) carries the item's id only: the
     * Gateway reads the item, decides its trust and ignores `title` and `scope` entirely.
     * `life_answer` ("Open as a chat" on a Search answer) carries the opaque `answerId` that
     * `memory.life.answer` returned: the Gateway holds the answer and re-reads every id it cites
     * under this connection's rules; the answer text and ids are never taken from the client.
     */
    title: Type.Optional(Type.String({ maxLength: 300 })),
    scope: Type.Optional(Type.String({ maxLength: 40 })),
  },
  { $id: "ChatContextRef" },
);
export type ChatContextRef = Static<typeof ChatContextRef>;

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

/** Most files one message can carry (the composer shows the same limit). */
export const MAX_ATTACHED_FILES = 8;

/**
 * A file the owner attached from disk (a native pick or a drop in the desktop app). The path is
 * only a name: `chat.send` includes it only while `chat.attachFiles` holds a live read grant for
 * exactly that file in the thread, so a client cannot attach what the owner did not pick.
 */
export const ChatAttachedFile = Type.Object(
  { path: Type.String({ minLength: 1, maxLength: 4096 }) },
  { $id: "ChatAttachedFile" },
);
export type ChatAttachedFile = Static<typeof ChatAttachedFile>;

export const ChatAttachFilesResult = Type.Object(
  {
    files: Type.Array(
      Type.Object({
        path: Type.String(),
        name: Type.String(),
        size: Type.Integer({ minimum: 0 }),
        type: Type.String(),
      }),
    ),
    refused: Type.Array(
      Type.Object({
        path: Type.String(),
        reason: StringEnum(["sensitive", "missing", "not_file", "invalid"]),
      }),
    ),
  },
  { $id: "ChatAttachFilesResult" },
);

export const ChatMethods = {
  "chat.attachFiles": defineMethod({
    params: Type.Object({
      threadId: Id,
      paths: Type.Array(Type.String({ minLength: 1, maxLength: 4096 }), {
        minItems: 1,
        maxItems: MAX_ATTACHED_FILES,
      }),
    }),
    result: ChatAttachFilesResult,
    scope: "operator.admin",
    sideEffecting: true,
    description:
      "Desktop app only (the web shell has no real paths and uploads to the Library instead). The owner picked or dropped these files on a message: each gets a read-only grant for exactly that file (not its folder) in this thread, for 24 hours, until Clear chat or deletion of the thread, or until a restart. The pick is the approval, so there is no card; a file under a sensitive root (~/.ssh, ~/.psyche, ~/Library, ...), a folder or a missing file is refused and listed in `refused`. Returns name, size and type for the chip. forbidden outside the desktop app. Side-effecting.",
  }),
  "chat.send": defineMethod({
    params: Type.Object({
      threadId: Id,
      content: MessageContent,
      attachments: Type.Optional(Type.Array(Id, { maxItems: 32, description: "Library item ids" })),
      attachedFiles: Type.Optional(
        Type.Array(ChatAttachedFile, {
          maxItems: MAX_ATTACHED_FILES,
          description:
            "Files from disk the owner attached (desktop): only those `chat.attachFiles` granted in this thread are used; the agent sees their name, size and type and reads them with read_file",
        }),
      ),
      mode: Type.Optional(QueueMode),
      /**
       * Quote-reply (feature E5): the message this one answers, in the same thread. Stored as
       * `Message.replyToMessageId`; the agent sees the quoted text ahead of the new message.
       */
      replyToMessageId: Type.Optional(Id),
      /**
       * The message is a click on a widget's reply button or a form submit (generative-ui-2026
       * §6.2): it is stored with `via: "widget"` (the "from widget" chip, D10), and when the widget
       * is untrusted the turn it starts is tainted with the widget's sources (§7.3).
       */
      fromWidget: Type.Optional(Type.Object({ widgetId: Id }, { $id: "ChatFromWidget" })),
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
      /**
       * Ask about my screen (docs/design/screen-ask-2026.md): the `screen.capture` this message
       * asks about. The Gateway adds its text context, attaches the frame per `image` and the
       * relevance rule, and widens the turn's taint (screen content is untrusted).
       */
      screen: Type.Optional(ChatScreenRef),
      /**
       * Ask about this (Feed): the item the message is about. Fetched web text in it is untrusted,
       * so the turn starts tainted. Only for a turn that starts now: a busy thread refuses it.
       */
      context: Type.Optional(ChatContextRef),
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
