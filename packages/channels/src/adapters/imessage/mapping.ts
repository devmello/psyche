import type {
  ChannelAttachment,
  InboundMessage,
  MessagesAttachment,
  MessagesMessage,
  QuotedMessage,
} from "@psyche/protocol";

/**
 * chat.db rows (`MessagesMessage`, from the mac helper's `messages.watch`) → `InboundMessage`.
 * The sender id is the canonical handle (E.164 phone or lowercased email), never a contact name.
 * Anything not carried over iMessage proper (SMS, RCS, unknown) is a weak identity (design-21).
 */

/** chat.db marks group chats with `;+;` in the guid (`iMessage;+;chat123…`, `any;+;…`). */
export function isGroupChat(chatId: string): boolean {
  return chatId.includes(";+;");
}

/** Phones stay as the helper sends them (E.164); email handles are lowercased. */
export function canonicalHandle(handle: string): string {
  const h = handle.trim();
  return h.includes("@") ? h.toLowerCase() : h;
}

/** A bare handle (`+15551234567`, `a@b.c`) as opposed to a chat guid (`iMessage;-;…`). */
export function isBareHandle(id: string): boolean {
  return !id.includes(";");
}

/** The 1:1 peer of a DM chat guid (`iMessage;-;+1555…` → `+1555…`), else undefined. */
export function dmPeer(chatId: string): string | undefined {
  const i = chatId.indexOf(";-;");
  return i < 0 ? undefined : canonicalHandle(chatId.slice(i + 3));
}

export function isStrongRow(row: MessagesMessage): boolean {
  return row.service === "imessage" && (row.sender?.service ?? row.service) === "imessage";
}

function attachmentKind(a: MessagesAttachment): ChannelAttachment["kind"] {
  if (a.isVoiceNote) return "voice";
  const mime = a.mimeType ?? "";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  return "file";
}

/** Metadata only: the helper never returns bytes, so there is no `ref` to fetch. */
export function mapAttachments(list: readonly MessagesAttachment[]): ChannelAttachment[] {
  return list
    .filter((a) => !a.isSticker)
    .map((a) => ({
      name: a.filename ?? "attachment",
      mime: a.mimeType ?? "application/octet-stream",
      size: a.totalBytes ?? 0,
      kind: attachmentKind(a),
    }));
}

/** What the adapter remembers of recent rows, for inline-reply quotes. */
export interface KnownRow {
  text: string;
  senderId?: string;
  fromSelf: boolean;
}

/**
 * Maps one inbound row. Returns undefined for rows that never become messages: our own sends
 * (`isFromMe`), tapbacks (handled separately as approval answers) and rows without a sender.
 */
export function mapRow(
  row: MessagesMessage,
  account: string,
  lookup: (guid: string) => KnownRow | undefined,
): InboundMessage | undefined {
  if (row.isFromMe || row.reaction != null || row.sender == null) return undefined;
  const attachments = mapAttachments(row.attachments);
  const text = row.text ?? "";
  if (text.trim() === "" && attachments.length === 0) return undefined;
  const sentAt = Date.parse(row.sentAt);
  const out: InboundMessage = {
    channel: "imessage",
    account,
    messageId: row.guid,
    chatId: row.chatId,
    senderId: canonicalHandle(row.sender.handle),
    isGroup: isGroupChat(row.chatId),
    // chat.db carries no structured mention entities: groups activate only on inline replies to
    // Psyche's own messages (`quoted.fromSelf`) or with `requireMention: false`.
    mentioned: false,
    // U+FFFC is the attachment placeholder chat.db leaves in the text.
    text: text.replaceAll("￼", "").trim(),
    receivedAt: Number.isFinite(sentAt) ? sentAt : 0,
    ...(isStrongRow(row) ? {} : { identityStrength: "weak" as const }),
    ...(attachments.length === 0 ? {} : { attachments }),
  };
  if (row.replyToGuid != null) {
    out.replyToMessageId = row.replyToGuid;
    const known = lookup(row.replyToGuid);
    if (known !== undefined) {
      const quoted: QuotedMessage = { text: known.text, fromSelf: known.fromSelf };
      if (known.senderId !== undefined && !known.fromSelf) quoted.senderId = known.senderId;
      out.quoted = quoted;
    }
  }
  // An edit rewrites the same ROWID, which the cursor never revisits: each row arrives once.
  return out;
}
