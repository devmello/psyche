import { type Static, Type } from "@sinclair/typebox";
import { IsoDateTime, Nullable, StringEnum } from "../common.ts";
import type { NodeCapability } from "./identity.ts";

/**
 * Messages on the Mac (features J7 and N5; security §3.5 `messages.send`, §9, §12). The mac
 * helper's `messages.*` node capabilities read `~/Library/Messages/chat.db` read-only (Full Disk
 * Access) and send through Messages.app scripting (Automation). The Gateway reaches them through
 * `node.invoke`; the iMessage channel adapter (`@psyche/channels`) is built on them. Message
 * bodies from anyone but the owner are untrusted content (security §3.6).
 *
 * The cursor is chat.db's `message.ROWID`: monotonic per database, so "everything after cursor N"
 * never skips or repeats a row. Added by M2 messages (J7 / N5).
 */

/**
 * Transport of a handle or chat as chat.db records it (`handle.service`, `chat.service_name`).
 * `sms` and `rcs` identities are carrier-asserted and weak (review design-21): a channel never
 * treats them as the owner.
 */
export const MessagesService = StringEnum(["imessage", "sms", "rcs", "unknown"], {
  $id: "MessagesService",
});
export type MessagesService = Static<typeof MessagesService>;

/** A chat.db `message.ROWID`. */
export const MessagesCursor = Type.Integer({ minimum: 0, $id: "MessagesCursor" });
export type MessagesCursor = Static<typeof MessagesCursor>;

/** One participant handle: a phone number in E.164 form or a lowercased email address. */
export const MessagesHandle = Type.Object(
  {
    handle: Type.String({ minLength: 1, maxLength: 320 }),
    service: MessagesService,
  },
  { $id: "MessagesHandle" },
);
export type MessagesHandle = Static<typeof MessagesHandle>;

export const MessagesChat = Type.Object(
  {
    chatId: Type.String({
      minLength: 1,
      description:
        "chat.db chat.guid (e.g. iMessage;-;+15551234567, any;-;… on macOS 26+). Opaque; pass back as-is.",
    }),
    service: MessagesService,
    displayName: Nullable(Type.String({ description: "Group name the participants set" })),
    isGroup: Type.Boolean(),
    participants: Type.Array(MessagesHandle),
    lastMessageAt: Nullable(IsoDateTime),
    lastCursor: Nullable(MessagesCursor),
  },
  { $id: "MessagesChat" },
);
export type MessagesChat = Static<typeof MessagesChat>;

/** Attachment metadata only: the helper never returns file bytes or paths outside the record. */
export const MessagesAttachment = Type.Object(
  {
    id: Type.String({ minLength: 1, description: "attachment.guid" }),
    filename: Nullable(Type.String({ description: "transfer_name, not a path" })),
    mimeType: Nullable(Type.String()),
    uti: Nullable(Type.String()),
    totalBytes: Nullable(Type.Integer({ minimum: 0 })),
    isVoiceNote: Type.Boolean({ description: "An audio message bubble (CAF)" }),
    isSticker: Type.Boolean(),
  },
  { $id: "MessagesAttachment" },
);
export type MessagesAttachment = Static<typeof MessagesAttachment>;

/** Tapbacks (`associated_message_type` 2000–2006 and their 3000-range removals). */
export const MessagesReactionKind = StringEnum(
  ["love", "like", "dislike", "laugh", "emphasize", "question", "emoji", "unknown"],
  { $id: "MessagesReactionKind" },
);
export type MessagesReactionKind = Static<typeof MessagesReactionKind>;

export const MessagesReaction = Type.Object(
  {
    kind: MessagesReactionKind,
    removed: Type.Boolean(),
    targetGuid: Type.String({ minLength: 1, description: "The reacted-to message's guid" }),
    emoji: Type.Optional(Type.String({ description: "For kind emoji" })),
  },
  { $id: "MessagesReaction" },
);
export type MessagesReaction = Static<typeof MessagesReaction>;

export const MessagesMessage = Type.Object(
  {
    cursor: MessagesCursor,
    guid: Type.String({ minLength: 1 }),
    chatId: Type.String({ minLength: 1 }),
    service: MessagesService,
    isFromMe: Type.Boolean(),
    /** The sending handle; null when isFromMe. */
    sender: Nullable(MessagesHandle),
    text: Nullable(
      Type.String({ description: "message.text, or decoded from attributedBody (typedstream)" }),
    ),
    sentAt: IsoDateTime,
    editedAt: Nullable(IsoDateTime),
    replyToGuid: Nullable(Type.String({ description: "thread_originator_guid (inline reply)" })),
    reaction: Nullable(MessagesReaction),
    attachments: Type.Array(MessagesAttachment),
  },
  { $id: "MessagesMessage" },
);
export type MessagesMessage = Static<typeof MessagesMessage>;

export const MessagesAutomationStatus = StringEnum(["granted", "denied", "not_determined"], {
  $id: "MessagesAutomationStatus",
});
export type MessagesAutomationStatus = Static<typeof MessagesAutomationStatus>;

/** Result of `messages.status`: preflight only, never prompts. */
export const MessagesStatus = Type.Object(
  {
    fullDiskAccess: Type.Boolean({ description: "chat.db is readable" }),
    /** Apple Events to Messages.app (needed by messages.send). */
    automation: MessagesAutomationStatus,
    databasePresent: Type.Boolean(),
    lastCursor: Nullable(MessagesCursor),
  },
  { $id: "MessagesStatus" },
);
export type MessagesStatus = Static<typeof MessagesStatus>;

export const MessagesChatsParams = Type.Object(
  {
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, default: 50 })),
    query: Type.Optional(
      Type.String({ maxLength: 128, description: "Substring of a handle or display name" }),
    ),
  },
  { $id: "MessagesChatsParams" },
);
export type MessagesChatsParams = Static<typeof MessagesChatsParams>;

export const MessagesChatsResult = Type.Object(
  { chats: Type.Array(MessagesChat) },
  { $id: "MessagesChatsResult" },
);
export type MessagesChatsResult = Static<typeof MessagesChatsResult>;

/**
 * `messages.read`: with `sinceCursor`, messages after it in ascending order (a page of `limit`);
 * without it, the most recent `limit` messages, still ascending. `chatId` or `handle` narrows to
 * one conversation.
 */
export const MessagesReadParams = Type.Object(
  {
    chatId: Type.Optional(Type.String({ minLength: 1 })),
    handle: Type.Optional(Type.String({ minLength: 1, maxLength: 320 })),
    sinceCursor: Type.Optional(MessagesCursor),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, default: 20 })),
  },
  { $id: "MessagesReadParams" },
);
export type MessagesReadParams = Static<typeof MessagesReadParams>;

export const MessagesReadResult = Type.Object(
  {
    messages: Type.Array(MessagesMessage),
    /** Highest cursor returned, else sinceCursor; pass it back as sinceCursor. */
    cursor: Nullable(MessagesCursor),
    hasMore: Type.Boolean(),
  },
  { $id: "MessagesReadResult" },
);
export type MessagesReadResult = Static<typeof MessagesReadResult>;

/** Which Messages account a send goes through (default `imessage`). */
export const MessagesSendService = StringEnum(["imessage", "sms"], { $id: "MessagesSendService" });
export type MessagesSendService = Static<typeof MessagesSendService>;

/**
 * `messages.send` (destructive, targetKind `recipient`; approval kind `message_send`, scopes
 * `once` / `task` only). Exactly one of `to` (a handle, starting a 1:1 chat) or `chatId`.
 * The binding is `{channel: "imessage", account, recipient, bodyHash}` (security §3.5).
 */
export const MessagesSendParams = Type.Object(
  {
    to: Type.Optional(Type.String({ minLength: 1, maxLength: 320 })),
    chatId: Type.Optional(Type.String({ minLength: 1 })),
    text: Type.String({ minLength: 1, maxLength: 20000 }),
    service: Type.Optional(MessagesSendService),
  },
  { $id: "MessagesSendParams" },
);
export type MessagesSendParams = Static<typeof MessagesSendParams>;

/** Messages.app scripting does not return the new message; the watcher reports it. */
export const MessagesSendResult = Type.Object(
  {
    sent: Type.Literal(true),
    recipient: Type.String({ description: "The handle or chat id the text went to" }),
    sentAt: IsoDateTime,
  },
  { $id: "MessagesSendResult" },
);
export type MessagesSendResult = Static<typeof MessagesSendResult>;

/**
 * `messages.watch` (streaming): polls chat.db every `intervalMs` and emits one
 * `MessagesWatchEvent` per batch of new rows after `sinceCursor` (default: the current newest row,
 * so nothing old is replayed). Runs until cancelled. `includeFromMe` adds the owner's own sends,
 * which a channel needs to drop its echoes.
 */
export const MessagesWatchParams = Type.Object(
  {
    sinceCursor: Type.Optional(MessagesCursor),
    intervalMs: Type.Optional(Type.Integer({ minimum: 500, maximum: 60000, default: 2000 })),
    includeFromMe: Type.Optional(Type.Boolean({ default: false })),
  },
  { $id: "MessagesWatchParams" },
);
export type MessagesWatchParams = Static<typeof MessagesWatchParams>;

/** `node.event` data streamed by `messages.watch`. */
export const MessagesWatchEvent = Type.Union(
  [
    Type.Object({
      type: Type.Literal("messages.new"),
      messages: Type.Array(MessagesMessage),
      cursor: MessagesCursor,
    }),
    Type.Object({
      type: Type.Literal("messages.watch_error"),
      reason: Type.String({ description: "e.g. full_disk_access_missing, database_locked" }),
      retryable: Type.Boolean(),
    }),
  ],
  { $id: "MessagesWatchEvent" },
);
export type MessagesWatchEvent = Static<typeof MessagesWatchEvent>;

/** The capabilities a node offering Messages declares (the mac helper's manifest matches). */
export const MESSAGES_CAPABILITIES: readonly NodeCapability[] = [
  {
    name: "messages.status",
    description: "Full Disk Access and Automation preflight for Messages; never prompts",
    sideEffect: "none",
  },
  { name: "messages.chats", description: "Recent chats from chat.db", sideEffect: "read" },
  {
    name: "messages.read",
    description: "Messages from chat.db, recent or after a cursor",
    sideEffect: "read",
  },
  {
    name: "messages.watch",
    description: "Stream new chat.db messages after a cursor",
    sideEffect: "read",
    streaming: true,
  },
  {
    name: "messages.send",
    description: "Send a text through Messages.app",
    sideEffect: "destructive",
    targetKind: "recipient",
  },
];
