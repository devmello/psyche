import { createHmac, timingSafeEqual } from "node:crypto";
import type { ChannelAttachment, InboundMessage } from "@psyche/protocol";

/**
 * Twilio webhook helpers (feature N9): the `X-Twilio-Signature` algorithm and the form → message
 * mapping. Every SMS sender is a weak identity (security §9, review design-21): caller ids are
 * spoofable, so an SMS sender is never the owner, whatever number it shows.
 */

export const E164 = /^\+\d{6,15}$/;

/** Form parameters in arrival order (repeated names allowed). */
export type FormParams = [name: string, value: string][];

export function parseForm(body: string): FormParams {
  return [...new URLSearchParams(body).entries()];
}

/**
 * base64(HMAC-SHA1(authToken, url + each POST parameter's name and value, sorted by name)).
 * Repeated names are ordered by value, as Twilio's own validators do.
 */
export function twilioSignature(authToken: string, url: string, params: FormParams): string {
  const sorted = [...params].sort(([an, av], [bn, bv]) =>
    an < bn ? -1 : an > bn ? 1 : av < bv ? -1 : av > bv ? 1 : 0,
  );
  const data = url + sorted.map(([n, v]) => n + v).join("");
  return createHmac("sha1", authToken).update(data, "utf8").digest("base64");
}

export function signatureMatches(expected: string, given: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(given, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Opt-out / help keywords Twilio answers itself: never a message, never a pairing request. `YES`
 * also re-subscribes, but it is too common a reply to drop.
 */
const KEYWORDS = new Set([
  "stop",
  "stopall",
  "unsubscribe",
  "cancel",
  "end",
  "quit",
  "start",
  "unstop",
  "help",
  "info",
]);

function kindOf(mime: string): ChannelAttachment["kind"] {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  return "file";
}

/** MMS media → attachment metadata; `ref` is the media URL (it carries no credentials). */
export function mapMedia(get: (name: string) => string | undefined): ChannelAttachment[] {
  const count = Math.min(10, Number.parseInt(get("NumMedia") ?? "0", 10) || 0);
  const out: ChannelAttachment[] = [];
  for (let i = 0; i < count; i++) {
    const url = get(`MediaUrl${i}`);
    if (url === undefined || url === "") continue;
    const mime = get(`MediaContentType${i}`) ?? "application/octet-stream";
    out.push({ name: `media-${i}`, mime, size: 0, kind: kindOf(mime), ref: url });
  }
  return out;
}

/**
 * A verified webhook's parameters → `InboundMessage`, or undefined for what never becomes a
 * message (non-E.164 senders such as short codes, opt-out keywords, empty bodies).
 */
export function mapSms(
  params: FormParams,
  account: string,
  receivedAt: number,
): InboundMessage | undefined {
  const map = new Map(params);
  const get = (name: string) => map.get(name);
  const from = get("From") ?? "";
  const sid = get("MessageSid") ?? get("SmsSid") ?? "";
  if (!E164.test(from) || sid === "") return undefined;
  const text = (get("Body") ?? "").trim();
  if ((get("OptOutType") ?? "") !== "" || KEYWORDS.has(text.toLowerCase())) return undefined;
  const attachments = mapMedia(get);
  if (text === "" && attachments.length === 0) return undefined;
  return {
    channel: "sms",
    account,
    messageId: sid,
    chatId: from,
    senderId: from,
    isGroup: false,
    text,
    receivedAt,
    // Always: the owner's own number over SMS never gets owner authority.
    identityStrength: "weak",
    ...(attachments.length === 0 ? {} : { attachments }),
  };
}
