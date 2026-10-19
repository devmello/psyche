import type {
  ChannelAttachment,
  ForwardedFrom,
  InboundMessage,
  QuotedMessage,
} from "@psyche/protocol";
import type { Chat, Message, MessageEntity, MessageOrigin, Update, User } from "grammy/types";

/**
 * Pure Telegram Bot API → Psyche mapping (S10). Everything here is a function of the update and
 * the bot's own identity; no I/O.
 */

export interface BotIdentity {
  id: number;
  username: string;
}

/**
 * Telegram placeholder senders: `GroupAnonymousBot` (anonymous group admins), `Channel_Bot`
 * (messages sent on behalf of a channel) and the Telegram service account (777000, linked channel
 * auto-forwards). The real author is hidden, so the identity is weak (review design-21).
 */
export const PLACEHOLDER_SENDER_IDS: ReadonlySet<number> = new Set([1087968824, 136817688, 777000]);

export function displayName(user: Pick<User, "first_name" | "last_name" | "username">): string {
  const full = [user.first_name, user.last_name].filter((s) => s !== undefined && s !== "");
  if (full.length > 0) return full.join(" ");
  return user.username ?? "";
}

function chatTitle(chat: Chat): string | undefined {
  if ("title" in chat && typeof chat.title === "string") return chat.title;
  if ("first_name" in chat && typeof chat.first_name === "string") {
    return displayName({
      first_name: chat.first_name,
      ...("last_name" in chat && chat.last_name !== undefined ? { last_name: chat.last_name } : {}),
      ...("username" in chat && chat.username !== undefined ? { username: chat.username } : {}),
    });
  }
  return undefined;
}

function entityText(text: string, entity: MessageEntity): string {
  // Telegram offsets and lengths are UTF-16 code units, which is what JS strings index by.
  return text.slice(entity.offset, entity.offset + entity.length);
}

/**
 * Whether the bot is addressed. Only structured entities count: a plain-text "@bot" without a
 * `mention` entity (e.g. inside a forwarded or pasted message) is not a mention (review design-22).
 */
export function isMentioned(message: Message, bot: BotIdentity): boolean {
  const text = message.text ?? message.caption ?? "";
  const entities = message.entities ?? message.caption_entities ?? [];
  const handle = `@${bot.username}`.toLowerCase();
  for (const entity of entities) {
    if (entity.type === "mention") {
      if (entityText(text, entity).toLowerCase() === handle) return true;
    } else if (entity.type === "text_mention") {
      if (entity.user.id === bot.id) return true;
    } else if (entity.type === "bot_command") {
      if (entityText(text, entity).toLowerCase().endsWith(handle)) return true;
    }
  }
  return false;
}

export function mapForwardOrigin(origin: MessageOrigin): ForwardedFrom {
  switch (origin.type) {
    case "user": {
      const name = displayName(origin.sender_user);
      return {
        senderId: String(origin.sender_user.id),
        ...(name === "" ? {} : { senderName: name }),
      };
    }
    case "hidden_user":
      return { senderName: origin.sender_user_name };
    case "chat": {
      const title = chatTitle(origin.sender_chat);
      return {
        senderId: String(origin.sender_chat.id),
        ...(title === undefined ? {} : { senderName: title }),
      };
    }
    case "channel": {
      const title = chatTitle(origin.chat);
      return {
        senderId: String(origin.chat.id),
        ...(title === undefined ? {} : { senderName: title }),
      };
    }
  }
}

export function mapAttachments(message: Message): ChannelAttachment[] {
  const out: ChannelAttachment[] = [];
  if (message.voice !== undefined) {
    out.push({
      kind: "voice",
      name: "voice.ogg",
      mime: message.voice.mime_type ?? "audio/ogg",
      size: message.voice.file_size ?? 0,
      ref: message.voice.file_id,
      durationMs: message.voice.duration * 1000,
    });
  }
  if (message.audio !== undefined) {
    out.push({
      kind: "audio",
      name: message.audio.file_name ?? "audio.mp3",
      mime: message.audio.mime_type ?? "audio/mpeg",
      size: message.audio.file_size ?? 0,
      ref: message.audio.file_id,
      durationMs: message.audio.duration * 1000,
    });
  }
  if (message.photo !== undefined && message.photo.length > 0) {
    // Telegram lists the sizes of one photo; keep the largest (by pixels, then bytes).
    const largest = message.photo.reduce((best, p) => {
      const area = p.width * p.height;
      const bestArea = best.width * best.height;
      if (area !== bestArea) return area > bestArea ? p : best;
      return (p.file_size ?? 0) > (best.file_size ?? 0) ? p : best;
    });
    out.push({
      kind: "image",
      name: "photo.jpg",
      mime: "image/jpeg",
      size: largest.file_size ?? 0,
      ref: largest.file_id,
    });
  }
  if (message.document !== undefined) {
    out.push({
      kind: "file",
      name: message.document.file_name ?? "file",
      mime: message.document.mime_type ?? "application/octet-stream",
      size: message.document.file_size ?? 0,
      ref: message.document.file_id,
    });
  }
  if (message.video !== undefined) {
    out.push({
      kind: "video",
      name: message.video.file_name ?? "video.mp4",
      mime: message.video.mime_type ?? "video/mp4",
      size: message.video.file_size ?? 0,
      ref: message.video.file_id,
      durationMs: message.video.duration * 1000,
    });
  }
  return out;
}

function mapQuoted(message: Message, bot: BotIdentity): QuotedMessage | undefined {
  const reply = message.reply_to_message;
  if (reply === undefined) return undefined;
  const quoted: QuotedMessage = {
    text: message.quote?.text ?? reply.text ?? reply.caption ?? "",
  };
  if (reply.forward_origin !== undefined) {
    // The quoted message was itself forwarded: its author is the forward origin, not the person
    // who forwarded it (review design-22). Leave the author unset so it stays untrusted.
    quoted.fromSelf = false;
  } else if (reply.from !== undefined) {
    quoted.senderId = String(reply.from.id);
    quoted.fromSelf = reply.from.id === bot.id;
  } else if (reply.sender_chat !== undefined) {
    quoted.senderId = String(reply.sender_chat.id);
    quoted.fromSelf = false;
  }
  return quoted;
}

/**
 * Maps a `message` / `edited_message` to an `InboundMessage`. Returns `undefined` for messages
 * Psyche ignores (the bot's own, messages without any sender).
 */
export function mapMessage(
  message: Message,
  bot: BotIdentity,
  account: string,
  options: { edited?: boolean } = {},
): InboundMessage | undefined {
  const from = message.from;
  if (from === undefined && message.sender_chat === undefined) return undefined;
  if (from !== undefined && from.id === bot.id) return undefined;

  const senderIsChat =
    message.sender_chat !== undefined ||
    (from !== undefined && PLACEHOLDER_SENDER_IDS.has(from.id));
  const senderId = from !== undefined ? String(from.id) : String((message.sender_chat as Chat).id);
  const senderName =
    message.sender_chat !== undefined
      ? chatTitle(message.sender_chat)
      : from !== undefined
        ? displayName(from)
        : undefined;

  const edited = options.edited === true && message.edit_date !== undefined;
  const id = String(message.message_id);
  const attachments = mapAttachments(message);
  const quoted = mapQuoted(message, bot);

  const inbound: InboundMessage = {
    channel: "telegram",
    account,
    messageId: edited ? `${id}:e${message.edit_date}` : id,
    chatId: String(message.chat.id),
    senderId,
    isGroup: message.chat.type === "group" || message.chat.type === "supergroup",
    // Entities survive forwarding; a forwarded mention is not a mention (design-22).
    mentioned: message.forward_origin === undefined && isMentioned(message, bot),
    text: message.text ?? message.caption ?? "",
    receivedAt: (edited ? (message.edit_date ?? message.date) : message.date) * 1000,
    identityStrength: senderIsChat ? "weak" : "strong",
  };
  if (senderName !== undefined && senderName !== "") inbound.senderName = senderName;
  if (senderIsChat) inbound.senderIsChat = true;
  if (attachments.length > 0) inbound.attachments = attachments;
  if (message.reply_to_message !== undefined) {
    inbound.replyToMessageId = String(message.reply_to_message.message_id);
  }
  if (quoted !== undefined) inbound.quoted = quoted;
  if (message.forward_origin !== undefined) {
    inbound.forwardedFrom = mapForwardOrigin(message.forward_origin);
  }
  if (edited) inbound.editOf = id;
  return inbound;
}

/** Maps an update; only `message` and `edited_message` produce inbound messages. */
export function mapUpdate(
  update: Update,
  bot: BotIdentity,
  account: string,
): InboundMessage | undefined {
  if (update.message !== undefined) return mapMessage(update.message, bot, account);
  if (update.edited_message !== undefined) {
    return mapMessage(update.edited_message, bot, account, { edited: true });
  }
  return undefined;
}

export interface ApprovalCallback {
  nonce: string;
  decision: "approve" | "deny";
}

const APPROVAL_CALLBACK = /^a:([A-Za-z0-9_-]{8,32}):([yn])$/;

/** Builds `a:<nonce>:<y|n>` (never carries the approval id or answer token). */
export function approvalCallbackData(nonce: string, decision: "approve" | "deny"): string {
  return `a:${nonce}:${decision === "approve" ? "y" : "n"}`;
}

/** Parses approval button data; anything else (including malformed data) is `undefined`. */
export function parseApprovalCallback(data: string | undefined): ApprovalCallback | undefined {
  if (data === undefined) return undefined;
  const m = APPROVAL_CALLBACK.exec(data);
  if (m === null || m[1] === undefined) return undefined;
  return { nonce: m[1], decision: m[2] === "y" ? "approve" : "deny" };
}

/** Telegram `reply_parameters.message_id` from an inbound id (edits carry a `:e<date>` suffix). */
export function telegramMessageId(messageId: string): number | undefined {
  const n = Number(messageId.split(":")[0]);
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

/** Numeric chat ids go out as numbers; `@channelusername` stays a string. */
export function telegramChatId(chatId: string): number | string {
  return /^-?\d+$/.test(chatId) && Number.isSafeInteger(Number(chatId)) ? Number(chatId) : chatId;
}
