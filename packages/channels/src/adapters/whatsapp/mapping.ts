import { createHmac, timingSafeEqual } from "node:crypto";
import type { ChannelAttachment, InboundMessage } from "@psyche/protocol";

/**
 * WhatsApp Cloud API webhook helpers (feature N6): the `X-Hub-Signature-256` algorithm and the
 * notification → message mapping. Only Meta's official Cloud API; unofficial clients (Baileys)
 * are not supported.
 */

/**
 * How much a WhatsApp sender id is worth (security §9 transport table). `strong`: the Cloud API
 * delivers Meta-verified numbers over a webhook signed with the app secret, so `wa_id` is not
 * forgeable the way an SMS caller id is. Flipping this to `"weak"` is the one-line change that
 * makes WhatsApp a weak transport: every message is tagged weak and `WEAK_TRANSPORTS` (settings.ts)
 * picks it up from this constant.
 */
export const WHATSAPP_IDENTITY_STRENGTH: "strong" | "weak" = "strong";

export const E164 = /^\+\d{6,15}$/;
/** Graph media ids are numeric. */
export const MEDIA_ID = /^\d{1,32}$/;

/** `sha256=<hex HMAC-SHA256(appSecret, raw body bytes)>`, Meta's `X-Hub-Signature-256` value. */
export function hubSignature(appSecret: string, body: Uint8Array): string {
  return `sha256=${createHmac("sha256", appSecret).update(body).digest("hex")}`;
}

/** Constant-time comparison of two strings (false when the lengths differ). */
export function constantTimeEqual(expected: string, given: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(given, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Approval buttons carry `apr:<nonce>:approve|deny`, never the approval id or answer token. */
export function approvalButtonId(nonce: string, decision: "approve" | "deny"): string {
  return `apr:${nonce}:${decision}`;
}

export function parseApprovalButtonId(
  id: unknown,
): { nonce: string; decision: "approve" | "deny" } | undefined {
  if (typeof id !== "string") return undefined;
  const m = /^apr:([A-Za-z0-9_-]{8,64}):(approve|deny)$/.exec(id);
  if (m === null) return undefined;
  return { nonce: m[1] as string, decision: m[2] as "approve" | "deny" };
}

// ── payload shapes (only the fields read here) ─────────────────────────────

export interface WaMedia {
  id?: unknown;
  mime_type?: unknown;
  caption?: unknown;
  filename?: unknown;
  voice?: unknown;
}

export interface WaMessage {
  from?: unknown;
  id?: unknown;
  timestamp?: unknown;
  type?: unknown;
  text?: { body?: unknown };
  interactive?: {
    type?: unknown;
    button_reply?: { id?: unknown; title?: unknown };
  };
  context?: { from?: unknown; id?: unknown; forwarded?: unknown; frequently_forwarded?: unknown };
  image?: WaMedia;
  audio?: WaMedia;
  voice?: WaMedia;
  video?: WaMedia;
  document?: WaMedia;
}

export interface WaContact {
  wa_id?: unknown;
  profile?: { name?: unknown };
}

export interface WaValue {
  messaging_product?: unknown;
  metadata?: { phone_number_id?: unknown; display_phone_number?: unknown };
  contacts?: WaContact[];
  messages?: WaMessage[];
  statuses?: unknown[];
}

export interface WaNotification {
  object?: unknown;
  entry?: { id?: unknown; changes?: { field?: unknown; value?: WaValue }[] }[];
}

/** The `value` of every change in a notification (malformed entries are skipped). */
export function changeValues(n: WaNotification): WaValue[] {
  const out: WaValue[] = [];
  for (const entry of Array.isArray(n.entry) ? n.entry : []) {
    for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
      const value = change?.value;
      if (value !== null && typeof value === "object") out.push(value);
    }
  }
  return out;
}

/** `+<digits>` for a `wa_id`, or undefined when it is not a phone number. */
export function waChatId(waId: unknown): string | undefined {
  if (typeof waId !== "string" || !/^\d{6,15}$/.test(waId)) return undefined;
  return `+${waId}`;
}

const MEDIA_TYPES = ["image", "audio", "voice", "video", "document"] as const;

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function mediaAttachment(message: WaMessage): ChannelAttachment | undefined {
  const type = str(message.type);
  const kindType = MEDIA_TYPES.find((t) => t === type);
  if (kindType === undefined) return undefined;
  const media = message[kindType];
  const id = str(media?.id);
  if (id === undefined || !MEDIA_ID.test(id)) return undefined;
  const mime = str(media?.mime_type) ?? "application/octet-stream";
  const kind: ChannelAttachment["kind"] =
    kindType === "voice" || (kindType === "audio" && media?.voice === true)
      ? "voice"
      : kindType === "audio"
        ? "audio"
        : kindType === "image"
          ? "image"
          : kindType === "video"
            ? "video"
            : "file";
  const name = str(media?.filename)?.slice(0, 200) ?? `${kindType}-${id}`;
  return { name, mime, size: 0, kind, ref: id };
}

/** What a verified message becomes: a turn, an approval button press, or nothing. */
export type MappedMessage =
  | { kind: "message"; message: InboundMessage }
  | { kind: "button"; chatId: string; buttonId: string }
  | { kind: "ignored" };

export interface MapContext {
  account: string;
  receivedAt: number;
  contacts: readonly WaContact[];
  /** Text of a message Psyche sent, by its `wamid` (quotes of our own messages). */
  ownText: (messageId: string) => string | undefined;
}

/**
 * One verified `messages[]` entry → message. Text, media (with caption) and button replies are
 * mapped; reactions, stickers, locations, contacts, list replies and `unsupported` are ignored.
 * WhatsApp Cloud API has no groups: `chatId = senderId = +<wa_id>`, `isGroup: false`.
 */
export function mapWaMessage(m: WaMessage, ctx: MapContext): MappedMessage {
  const chatId = waChatId(m.from);
  const messageId = str(m.id);
  if (chatId === undefined || messageId === undefined || messageId === "") {
    return { kind: "ignored" };
  }
  const type = str(m.type);
  if (type === "interactive") {
    const id = str(m.interactive?.button_reply?.id);
    if (m.interactive?.type === "button_reply" && id !== undefined) {
      return { kind: "button", chatId, buttonId: id };
    }
    return { kind: "ignored" };
  }
  let text = "";
  const attachments: ChannelAttachment[] = [];
  if (type === "text") {
    text = (str(m.text?.body) ?? "").trim();
  } else {
    const attachment = mediaAttachment(m);
    if (attachment === undefined) return { kind: "ignored" };
    attachments.push(attachment);
    const kindType = MEDIA_TYPES.find((t) => t === type);
    text = (kindType === undefined ? "" : (str(m[kindType]?.caption) ?? "")).trim();
  }
  if (text === "" && attachments.length === 0) return { kind: "ignored" };

  const contact = ctx.contacts.find((c) => c.wa_id === m.from) ?? ctx.contacts[0];
  const name = str(contact?.profile?.name)?.trim().slice(0, 128);
  const replyTo = str(m.context?.id);
  const forwarded = m.context?.forwarded === true || m.context?.frequently_forwarded === true;
  const quotedFrom = waChatId(m.context?.from);
  const own = replyTo === undefined ? undefined : ctx.ownText(replyTo);
  const message: InboundMessage = {
    channel: "whatsapp",
    account: ctx.account,
    messageId,
    chatId,
    senderId: chatId,
    isGroup: false,
    text,
    receivedAt: ctx.receivedAt,
    identityStrength: WHATSAPP_IDENTITY_STRENGTH,
    ...(name === undefined || name === "" ? {} : { senderName: name }),
    ...(attachments.length === 0 ? {} : { attachments }),
    ...(replyTo === undefined ? {} : { replyToMessageId: replyTo }),
    ...(replyTo === undefined
      ? {}
      : {
          // Ours: a `wamid` we sent (text remembered), or a quote of the business number itself.
          quoted:
            own !== undefined || quotedFrom === ctx.account
              ? { text: own ?? "", fromSelf: true }
              : { text: "", ...(quotedFrom === undefined ? {} : { senderId: quotedFrom }) },
        }),
    ...(forwarded ? { forwardedFrom: {} } : {}),
  };
  return { kind: "message", message };
}
