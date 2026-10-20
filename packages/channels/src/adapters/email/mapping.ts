import type { ChannelAttachment, InboundMessage, QuotedMessage } from "@psyche/protocol";

/**
 * Email → Psyche mapping (N9, pure). A conversation is a mail thread, keyed by its root
 * Message-ID (the first `References` entry, else `In-Reply-To`, else the message's own id), so a
 * reply to Psyche's mail continues the same session. `From:` is forgeable, so every sender is weak
 * (review design-21): the channel service treats email senders as non-owners whatever their
 * address, and their routes are chat-only.
 */

export interface EmailAttachmentInfo {
  partId: string;
  filename: string;
  mimeType: string;
  size: number;
}

/** One inbox message as the transport reads it (bodies are third-party content). */
export interface EmailInbound {
  /** Transport id for `attachment` (IMAP UID, JMAP id). */
  id: string;
  /** RFC 5322 Message-ID, with angle brackets. */
  messageId: string;
  /** Sender address (bare, lower-case) and display name. */
  from: string;
  fromName?: string;
  subject: string;
  /** Epoch ms. */
  date: number;
  /** Plain-text body (HTML already reduced to text). */
  text: string;
  inReplyTo?: string;
  references: string[];
  attachments: EmailAttachmentInfo[];
  /** `Auto-Submitted` other than `no`, `Precedence: bulk/list/junk`, or a `List-Id`. */
  automated?: boolean;
}

/** The thread key for a message (its root Message-ID). */
export function threadKey(m: Pick<EmailInbound, "messageId" | "inReplyTo" | "references">): string {
  return m.references[0] ?? m.inReplyTo ?? m.messageId;
}

const QUOTE_HEADER = /^(On .{3,200}wrote:|-{2,} ?Original Message ?-{2,}|From: .+)$/;

/**
 * Splits the new text from the quoted history a mail client appends: everything from the first
 * "On … wrote:" / "Original Message" line, or the first run of `>` lines that runs to the end.
 */
export function splitQuoted(body: string): { text: string; quoted: string } {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  let cut = lines.findIndex((l) => QUOTE_HEADER.test(l.trim()));
  if (cut < 0) {
    const firstQuote = lines.findIndex((l) => l.startsWith(">"));
    if (
      firstQuote >= 0 &&
      lines.slice(firstQuote).every((l) => l.startsWith(">") || l.trim() === "")
    ) {
      cut = firstQuote;
    }
  }
  if (cut < 0) return { text: body.trim(), quoted: "" };
  const quoted = lines
    .slice(cut)
    .filter((l) => !QUOTE_HEADER.test(l.trim()))
    .map((l) => l.replace(/^>\s?/, ""))
    .join("\n")
    .trim();
  return { text: lines.slice(0, cut).join("\n").trim(), quoted };
}

export function mapEmail(
  m: EmailInbound,
  account: string,
  sentByPsyche: (messageId: string) => boolean,
): InboundMessage | undefined {
  if (m.automated === true) return undefined;
  const from = m.from.trim().toLowerCase();
  if (from === "" || from === account.toLowerCase()) return undefined;
  const { text, quoted } = splitQuoted(m.text);
  const subject = m.subject.trim();
  const body =
    text === "" ? "" : subject === "" || isReply(subject) ? text : `${subject}\n\n${text}`;
  const quote: QuotedMessage | undefined =
    quoted === ""
      ? undefined
      : m.inReplyTo !== undefined && sentByPsyche(m.inReplyTo)
        ? { text: quoted, fromSelf: true }
        : { text: quoted };
  const attachments: ChannelAttachment[] = m.attachments.map((a) => ({
    name: a.filename,
    mime: a.mimeType,
    size: a.size,
    kind: a.mimeType.startsWith("image/") ? "image" : "file",
    ref: `${m.id}#${a.partId}`,
  }));
  return {
    channel: "email",
    account,
    messageId: m.messageId,
    chatId: threadKey(m),
    senderId: from,
    ...(m.fromName === undefined ? {} : { senderName: m.fromName }),
    isGroup: false,
    text: body,
    ...(attachments.length === 0 ? {} : { attachments }),
    ...(m.inReplyTo === undefined ? {} : { replyToMessageId: m.inReplyTo }),
    receivedAt: m.date,
    identityStrength: "weak",
    ...(quote === undefined ? {} : { quoted: quote }),
  };
}

export function isReply(subject: string): boolean {
  return /^(re|aw|sv|antw)\s*:/i.test(subject.trim());
}

export function replySubject(subject: string): string {
  const s = subject.trim() === "" ? "Psyche" : subject.trim();
  return isReply(s) ? s : `Re: ${s}`;
}
