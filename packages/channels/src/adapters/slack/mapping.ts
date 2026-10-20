import type { ChannelAttachment, ChannelAttachmentKind, InboundMessage } from "@psyche/protocol";

/**
 * Pure Slack Events API → Psyche mapping (N8). Everything here is a function of the event and the
 * bot's own identity; no I/O. Only `message` events are mapped (an `app_mention` duplicates one).
 */

export interface SlackIdentity {
  /** The bot user (`auth.test` `user_id`). */
  userId: string;
  /** The bot id (`auth.test` `bot_id`): messages carrying it are Psyche's own. */
  botId?: string;
}

export interface SlackFile {
  id?: string;
  name?: string;
  title?: string;
  mimetype?: string;
  size?: number;
  url_private_download?: string;
  url_private?: string;
  subtype?: string;
}

export interface SlackMessageEvent {
  type: string;
  subtype?: string;
  channel?: string;
  channel_type?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
  files?: SlackFile[];
  message?: SlackMessageEvent;
  previous_message?: SlackMessageEvent;
  event_ts?: string;
}

/** Subtypes that are a person's message (everything else is a system notice and is dropped). */
const PERSON_SUBTYPES = new Set([undefined, "file_share", "thread_broadcast", "me_message"]);

/** Slack ids: users U…/W…, channels C…/G…/D…. */
export const SLACK_USER_ID = /^[UW][A-Z0-9]{2,}$/;

/**
 * Structured mention of the bot: Slack writes `<@U…>` only for an autocompleted mention, so a
 * pasted or typed "@psyche" in plain text does not count (review design-22).
 */
export function mentionsBot(text: string, me: SlackIdentity): boolean {
  return new RegExp(`<@${me.userId}(\\|[^>]*)?>`).test(text);
}

/** Readable text: user / channel mentions to `@id` / `#name`, links to their label or URL. */
export function plainText(text: string): string {
  return text
    .replace(
      /<@([UW][A-Z0-9]+)(?:\|([^>]*))?>/g,
      (_m, id: string, label?: string) => `@${label ?? id}`,
    )
    .replace(
      /<#([CG][A-Z0-9]+)(?:\|([^>]*))?>/g,
      (_m, id: string, label?: string) => `#${label ?? id}`,
    )
    .replace(/<!(here|channel|everyone)>/g, "@$1")
    .replace(/<(https?:[^|>]+)\|([^>]+)>/g, "$2 ($1)")
    .replace(/<(https?:[^>]+)>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function fileKind(file: SlackFile): ChannelAttachmentKind {
  const mime = file.mimetype ?? "";
  if (file.subtype === "slack_audio") return "voice";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  return "file";
}

export function mapFiles(files: SlackFile[] | undefined): ChannelAttachment[] {
  const out: ChannelAttachment[] = [];
  for (const f of files ?? []) {
    const url = f.url_private_download ?? f.url_private;
    if (url === undefined) continue;
    out.push({
      name: f.name ?? f.title ?? "file",
      mime: f.mimetype ?? "application/octet-stream",
      size: f.size ?? 0,
      kind: fileKind(f),
      ref: url,
    });
  }
  return out;
}

/**
 * One Slack `message` event → an inbound message, or undefined when it is not a person's
 * message (bots, Psyche itself, joins, deletions). `message_changed` becomes an edit.
 */
export function mapMessageEvent(
  event: SlackMessageEvent,
  me: SlackIdentity,
  account: string,
  receivedAt: number,
): InboundMessage | undefined {
  if (event.type !== "message" || event.channel === undefined) return undefined;
  let msg = event;
  let editOf: string | undefined;
  if (event.subtype === "message_changed") {
    if (event.message === undefined || event.message.ts === undefined) return undefined;
    msg = { ...event.message, channel: event.channel, channel_type: event.channel_type };
    editOf = event.message.ts;
  } else if (!PERSON_SUBTYPES.has(event.subtype)) {
    return undefined;
  }
  if (msg.subtype !== undefined && !PERSON_SUBTYPES.has(msg.subtype)) return undefined;
  if (msg.bot_id !== undefined || msg.user === undefined || msg.user === me.userId)
    return undefined;
  if (msg.ts === undefined) return undefined;
  const raw = msg.text ?? "";
  const isGroup = event.channel_type !== "im";
  const attachments = mapFiles(msg.files);
  const inThread = msg.thread_ts !== undefined && msg.thread_ts !== msg.ts;
  return {
    channel: "slack",
    account,
    messageId: editOf === undefined ? msg.ts : `${msg.ts}:edit:${event.event_ts ?? event.ts ?? ""}`,
    chatId: event.channel,
    senderId: msg.user,
    isGroup,
    ...(isGroup ? { mentioned: mentionsBot(raw, me) } : {}),
    text: plainText(raw),
    ...(attachments.length === 0 ? {} : { attachments }),
    ...(inThread ? { replyToMessageId: msg.thread_ts } : {}),
    receivedAt,
    ...(editOf === undefined ? {} : { editOf }),
  };
}
