import type { ChannelAttachment, InboundMessage, QuotedMessage } from "@psyche/protocol";

/**
 * signal-cli JSON-RPC `receive` notifications (signal-cli-jsonrpc(5): `{"method":"receive",
 * "params":{"envelope":{…},"account":"+…"}}`) → what the Signal adapter acts on. One pure function,
 * `mapReceive`, holds every field name the adapter relies on, so a signal-cli rename breaks one
 * tested place.
 *
 * Signal identities are strong: end-to-end encrypted, the number registered to a device. The
 * sender id is the E.164 number (`sourceNumber`), else `uuid:<sourceUuid>` for a sender who
 * hides their number. DMs are keyed by that id; groups by `group:<groupId>` (base64).
 */

export const E164_RE = /^\+\d{6,15}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const SIGNAL_UUID_ID_RE =
  /^uuid:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Signal group ids are base64 (32 bytes for v2 groups). */
export const SIGNAL_GROUP_ID_RE = /^group:[A-Za-z0-9+/=_-]{8,128}$/;
export const SIGNAL_GROUP_PREFIX = "group:";

export interface SignalMention {
  name?: string | null;
  number?: string | null;
  uuid?: string | null;
  start?: number;
  length?: number;
}

export interface SignalQuote {
  id?: number;
  author?: string | null;
  authorNumber?: string | null;
  authorUuid?: string | null;
  text?: string | null;
}

export interface SignalAttachmentInfo {
  contentType?: string | null;
  filename?: string | null;
  id?: string | null;
  size?: number | null;
  voiceNote?: boolean;
}

export interface SignalReaction {
  emoji?: string;
  targetAuthor?: string | null;
  targetAuthorNumber?: string | null;
  targetAuthorUuid?: string | null;
  targetSentTimestamp?: number;
  isRemove?: boolean;
}

export interface SignalDataMessage {
  timestamp?: number;
  message?: string | null;
  viewOnce?: boolean;
  mentions?: SignalMention[];
  quote?: SignalQuote;
  attachments?: SignalAttachmentInfo[];
  reaction?: SignalReaction;
  groupInfo?: { groupId?: string; type?: string };
  remoteDelete?: unknown;
  sticker?: unknown;
}

export interface SignalEnvelope {
  source?: string | null;
  sourceNumber?: string | null;
  sourceUuid?: string | null;
  sourceName?: string | null;
  sourceDevice?: number;
  timestamp?: number;
  dataMessage?: SignalDataMessage;
  editMessage?: { targetSentTimestamp?: number; dataMessage?: SignalDataMessage };
  syncMessage?: unknown;
  typingMessage?: unknown;
  receiptMessage?: unknown;
  storyMessage?: unknown;
  callMessage?: unknown;
}

export interface SignalReceiveParams {
  envelope?: SignalEnvelope;
  account?: string;
  exception?: unknown;
}

/** The channel account: Psyche's own Signal number (and its ACI uuid, when known). */
export interface SignalSelf {
  number: string;
  uuid?: string;
}

/** A reaction to one of our messages: the adapter matches it against approval cards. */
export interface SignalReactionEvent {
  emoji: string;
  /** The reacted-to message is one this account sent. */
  targetIsSelf: boolean;
  targetSentTimestamp: number;
  isRemove: boolean;
  chatId: string;
  senderId: string;
  isGroup: boolean;
}

export type SignalEvent =
  | { kind: "message"; message: InboundMessage }
  | { kind: "reaction"; reaction: SignalReactionEvent }
  | { kind: "ignore"; reason: string };

function isSelf(self: SignalSelf, number?: string | null, uuid?: string | null): boolean {
  if (number != null && number === self.number) return true;
  return uuid != null && self.uuid !== undefined && uuid.toLowerCase() === self.uuid.toLowerCase();
}

/** `+1555…` → itself; a uuid → `uuid:<uuid>`; anything else → undefined. */
export function signalId(number?: string | null, uuid?: string | null): string | undefined {
  if (number != null && E164_RE.test(number)) return number;
  const u = uuid?.toLowerCase();
  if (u !== undefined && UUID_RE.test(u)) return `uuid:${u}`;
  return undefined;
}

/** A DM chat id or `group:<id>` → the `send` / `sendTyping` target params. */
export function signalTarget(
  chatId: string,
): { recipient: string[] } | { groupId: string } | undefined {
  if (SIGNAL_GROUP_ID_RE.test(chatId)) return { groupId: chatId.slice(SIGNAL_GROUP_PREFIX.length) };
  if (E164_RE.test(chatId)) return { recipient: [chatId] };
  if (SIGNAL_UUID_ID_RE.test(chatId)) return { recipient: [chatId.slice(5)] };
  return undefined;
}

function attachmentKind(a: SignalAttachmentInfo): ChannelAttachment["kind"] {
  const mime = a.contentType ?? "";
  if (a.voiceNote === true && mime.startsWith("audio/")) return "voice";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  return "file";
}

export function mapSignalAttachments(
  list: readonly SignalAttachmentInfo[] | undefined,
): ChannelAttachment[] {
  return (list ?? []).map((a) => ({
    name: a.filename ?? "attachment",
    mime: a.contentType ?? "application/octet-stream",
    size: typeof a.size === "number" && a.size >= 0 ? a.size : 0,
    kind: attachmentKind(a),
    ...(typeof a.id === "string" && a.id !== "" ? { ref: a.id } : {}),
  }));
}

/** Signal puts U+FFFC where a mention sits; spell it out as `@name` (never an id lookup). */
function renderMentions(text: string, mentions: readonly SignalMention[]): string {
  let out = text;
  const sorted = [...mentions]
    .filter((m) => typeof m.start === "number" && typeof m.length === "number")
    .sort((a, b) => (b.start ?? 0) - (a.start ?? 0));
  for (const m of sorted) {
    const start = m.start ?? 0;
    const length = m.length ?? 0;
    if (out[start] !== "\uFFFC") continue;
    const name = (m.name ?? m.number ?? "someone").replaceAll("\uFFFC", "");
    out = `${out.slice(0, start)}@${name}${out.slice(start + length)}`;
  }
  return out.replaceAll("\uFFFC", "");
}

/**
 * Maps one `receive` notification. Ignored: other accounts' envelopes, sync messages (our own
 * sends from linked devices), typing indicators, receipts, calls, stories, anything from our own
 * account, view-once media, remote deletes, and envelopes without a usable sender.
 */
export function mapReceive(
  params: SignalReceiveParams | undefined,
  self: SignalSelf,
  now: number,
): SignalEvent {
  const env = params?.envelope;
  if (env === undefined || env === null || typeof env !== "object") {
    return { kind: "ignore", reason: "no_envelope" };
  }
  if (params?.account !== undefined && params.account !== self.number) {
    return { kind: "ignore", reason: "other_account" };
  }
  if (env.syncMessage != null) return { kind: "ignore", reason: "sync" };
  if (isSelf(self, env.sourceNumber ?? null, env.sourceUuid ?? null)) {
    return { kind: "ignore", reason: "self" };
  }
  if (env.source != null && isSelf(self, env.source, env.source)) {
    return { kind: "ignore", reason: "self" };
  }
  if (env.typingMessage != null) return { kind: "ignore", reason: "typing" };
  if (env.receiptMessage != null) return { kind: "ignore", reason: "receipt" };
  if (env.storyMessage != null) return { kind: "ignore", reason: "story" };
  if (env.callMessage != null) return { kind: "ignore", reason: "call" };

  const senderId =
    signalId(env.sourceNumber, env.sourceUuid) ??
    (env.source == null ? undefined : signalId(env.source, env.source));
  if (senderId === undefined) return { kind: "ignore", reason: "no_sender" };

  const edit = env.editMessage;
  const data = edit?.dataMessage ?? env.dataMessage;
  if (data == null) return { kind: "ignore", reason: "no_data" };

  const groupId = data.groupInfo?.groupId;
  const isGroup = typeof groupId === "string" && groupId !== "";
  const chatId = isGroup ? `${SIGNAL_GROUP_PREFIX}${groupId}` : senderId;

  if (data.reaction != null && edit === undefined) {
    const r = data.reaction;
    if (typeof r.emoji !== "string" || typeof r.targetSentTimestamp !== "number") {
      return { kind: "ignore", reason: "bad_reaction" };
    }
    const targetIsSelf =
      isSelf(self, r.targetAuthorNumber ?? null, r.targetAuthorUuid ?? null) ||
      (r.targetAuthor != null && isSelf(self, r.targetAuthor, r.targetAuthor));
    return {
      kind: "reaction",
      reaction: {
        emoji: r.emoji,
        targetIsSelf,
        targetSentTimestamp: r.targetSentTimestamp,
        isRemove: r.isRemove === true,
        chatId,
        senderId,
        isGroup,
      },
    };
  }
  if (data.remoteDelete != null) return { kind: "ignore", reason: "remote_delete" };
  if (data.viewOnce === true) return { kind: "ignore", reason: "view_once" };
  if (data.groupInfo !== undefined && !isGroup) return { kind: "ignore", reason: "bad_group" };

  const mentions = data.mentions ?? [];
  const text = renderMentions(data.message ?? "", mentions).trim();
  const attachments = mapSignalAttachments(data.attachments);
  if (text === "" && attachments.length === 0) return { kind: "ignore", reason: "empty" };

  const sentAt = data.timestamp ?? env.timestamp;
  const message: InboundMessage = {
    channel: "signal",
    account: self.number,
    messageId: String(sentAt ?? now),
    chatId,
    senderId,
    ...(typeof env.sourceName === "string" && env.sourceName !== ""
      ? { senderName: env.sourceName }
      : {}),
    isGroup,
    mentioned: mentions.some((m) => isSelf(self, m.number ?? null, m.uuid ?? null)),
    text,
    receivedAt: typeof env.timestamp === "number" ? env.timestamp : now,
    ...(attachments.length === 0 ? {} : { attachments }),
  };
  if (edit !== undefined && typeof edit.targetSentTimestamp === "number") {
    message.editOf = String(edit.targetSentTimestamp);
  }
  const q = data.quote;
  if (q != null && typeof q.id === "number") {
    message.replyToMessageId = String(q.id);
    const fromSelf =
      isSelf(self, q.authorNumber ?? null, q.authorUuid ?? null) ||
      (q.author != null && isSelf(self, q.author, q.author));
    const quoted: QuotedMessage = { text: q.text ?? "", fromSelf };
    const author = signalId(q.authorNumber ?? q.author, q.authorUuid ?? q.author);
    if (!fromSelf && author !== undefined) quoted.senderId = author;
    message.quoted = quoted;
  }
  return { kind: "message", message };
}

/** 👍 / 👎 (any skin tone, with or without VS16) → a decision; anything else → undefined. */
export function reactionDecision(emoji: string): "approve" | "deny" | undefined {
  const base = emoji.replace(/[\u{1F3FB}-\u{1F3FF}\u{FE0F}]/gu, "");
  if (base === "👍") return "approve";
  if (base === "👎") return "deny";
  return undefined;
}
