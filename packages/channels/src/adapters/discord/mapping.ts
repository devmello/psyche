import type { ChannelAttachment, InboundMessage, QuotedMessage } from "@psyche/protocol";

/**
 * Pure Discord gateway (v10) → Psyche mapping (feature N8). A function of the dispatch payload
 * and the bot's own user id; no I/O. Only the fields Psyche reads are typed.
 */

export interface DiscordUser {
  id: string;
  username?: string;
  global_name?: string | null;
  bot?: boolean;
  system?: boolean;
}

export interface DiscordAttachment {
  id: string;
  filename: string;
  size: number;
  url: string;
  content_type?: string;
  duration_secs?: number;
}

export interface DiscordMessage {
  id: string;
  channel_id: string;
  guild_id?: string;
  author?: DiscordUser;
  webhook_id?: string;
  /** 0 default, 19 reply; everything else is a system message. */
  type?: number;
  content?: string;
  timestamp?: string;
  edited_timestamp?: string | null;
  mentions?: DiscordUser[];
  attachments?: DiscordAttachment[];
  flags?: number;
  /** `type` 0 = reply, 1 = forward. */
  message_reference?: { type?: number; message_id?: string; channel_id?: string };
  referenced_message?: DiscordMessage | null;
  message_snapshots?: { message?: { content?: string } }[];
}

/** Messages Psyche reads: DEFAULT and REPLY. */
const USER_MESSAGE_TYPES = new Set([0, 19]);
/** `flags` bit for a voice message. */
const IS_VOICE_MESSAGE = 1 << 13;
const SNOWFLAKE = /^\d{1,20}$/;

export function isSnowflake(id: string): boolean {
  return SNOWFLAKE.test(id);
}

export function displayName(user: DiscordUser): string {
  return user.global_name ?? user.username ?? "";
}

export function mapAttachments(message: DiscordMessage): ChannelAttachment[] {
  const voice = ((message.flags ?? 0) & IS_VOICE_MESSAGE) !== 0;
  return (message.attachments ?? []).map((a) => {
    const mime = a.content_type ?? "application/octet-stream";
    const kind = mime.startsWith("image/")
      ? "image"
      : mime.startsWith("audio/")
        ? voice
          ? "voice"
          : "audio"
        : mime.startsWith("video/")
          ? "video"
          : "file";
    const out: ChannelAttachment = { kind, name: a.filename, mime, size: a.size, ref: a.url };
    if (a.duration_secs !== undefined) out.durationMs = Math.round(a.duration_secs * 1000);
    return out;
  });
}

function mapQuoted(message: DiscordMessage, botId: string): QuotedMessage | undefined {
  const ref = message.referenced_message;
  if (ref === undefined) return undefined;
  // `null`: the replied-to message was deleted.
  if (ref === null) return { text: "", fromSelf: false };
  const quoted: QuotedMessage = { text: ref.content ?? "" };
  if (ref.author !== undefined) {
    quoted.senderId = ref.author.id;
    quoted.fromSelf = ref.author.id === botId;
  }
  return quoted;
}

/**
 * Maps MESSAGE_CREATE / MESSAGE_UPDATE. `undefined` for what Psyche ignores: the bot itself,
 * other bots, webhooks, system messages, and updates that are not content edits (embeds resolving).
 */
export function mapMessage(
  message: DiscordMessage,
  botId: string,
  account: string,
  options: { edited?: boolean } = {},
): InboundMessage | undefined {
  const author = message.author;
  if (author === undefined || author.id === botId) return undefined;
  if (author.bot === true || author.system === true || message.webhook_id !== undefined) {
    return undefined;
  }
  if (message.type !== undefined && !USER_MESSAGE_TYPES.has(message.type)) return undefined;
  const editedAt = message.edited_timestamp ? Date.parse(message.edited_timestamp) : Number.NaN;
  if (options.edited === true && (message.content === undefined || !Number.isFinite(editedAt))) {
    return undefined;
  }
  const edited = options.edited === true;
  const forwarded = message.message_reference?.type === 1;
  const text = forwarded
    ? (message.message_snapshots?.[0]?.message?.content ?? "")
    : (message.content ?? "");
  const sentAt = message.timestamp === undefined ? Number.NaN : Date.parse(message.timestamp);
  const isGroup = message.guild_id !== undefined;

  const inbound: InboundMessage = {
    channel: "discord",
    account,
    messageId: edited ? `${message.id}:e${editedAt}` : message.id,
    chatId: message.channel_id,
    senderId: author.id,
    isGroup,
    // A forwarded message's mentions are someone else's (design-22).
    mentioned: !forwarded && (message.mentions ?? []).some((u) => u.id === botId),
    text,
    receivedAt: edited ? editedAt : Number.isFinite(sentAt) ? sentAt : Date.now(),
    identityStrength: "strong",
  };
  const name = displayName(author);
  if (name !== "") inbound.senderName = name;
  const attachments = mapAttachments(message);
  if (attachments.length > 0) inbound.attachments = attachments;
  if (forwarded) {
    inbound.forwardedFrom = {};
  } else if (message.message_reference?.message_id !== undefined) {
    inbound.replyToMessageId = message.message_reference.message_id;
    const quoted = mapQuoted(message, botId);
    if (quoted !== undefined) inbound.quoted = quoted;
  }
  if (edited) inbound.editOf = message.id;
  return inbound;
}

/** Discord message id from an inbound id (edits carry a `:e<ms>` suffix). */
export function discordMessageId(messageId: string): string | undefined {
  const id = messageId.split(":")[0] ?? "";
  return isSnowflake(id) ? id : undefined;
}
