import type { NoticeMessage } from "@psyche/protocol";

/**
 * Cleaning of a keyed notice (`NotifyInput.message`). Its values come from places an attacker can
 * write to (a device name, a page's host, a tool name, an agent's reason), and every client shows
 * them inside a sentence the owner trusts. So the notifier, not each caller, strips what could
 * disguise or move text: control (Cc) and format (Cf) characters, which include zero-width
 * characters, the bidirectional overrides U+202A to U+202E and the isolates U+2066 to U+2069,
 * and tag characters. Whitespace runs become one space. Clients treat the values as plain text
 * (ICU values are never parsed as markup), so `<` and `&` stay as they are.
 */

/** Cc, Cf, the line and paragraph separators, and the bidi ranges spelled out. */
const UNSAFE = /[\p{Cc}\p{Cf}\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu;

/** The longest value kept. A connector consent link is the longest thing sent this way. */
export const MAX_NOTICE_VALUE = 2048;
const MAX_PARAMS = 16;
const KEY = /^[a-z][A-Za-z0-9]*(\.[A-Za-z][A-Za-z0-9]*){1,6}$/;
const PARAM_NAME = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;

export function cleanNoticeValue(raw: string, max = MAX_NOTICE_VALUE): string {
  const out = raw.replace(UNSAFE, " ").replace(/\s+/g, " ").trim();
  const points = [...out];
  return points.length > max ? `${points.slice(0, max - 1).join("")}…` : out;
}

/**
 * The notice with clean ids and values, or `undefined` when its ids are malformed (the notification
 * then goes out with its English text only). Values other than strings and finite numbers are
 * dropped; a name that is not a plain identifier is dropped.
 */
export function cleanNoticeMessage(message: NoticeMessage | undefined): NoticeMessage | undefined {
  if (message === undefined) return undefined;
  if (!KEY.test(message.titleKey) || !KEY.test(message.bodyKey)) return undefined;
  const params: Record<string, string | number> = {};
  let count = 0;
  for (const [name, value] of Object.entries(message.params ?? {})) {
    if (count >= MAX_PARAMS || !PARAM_NAME.test(name)) continue;
    if (typeof value === "string") params[name] = cleanNoticeValue(value);
    else if (typeof value === "number" && Number.isFinite(value)) params[name] = value;
    else continue;
    count++;
  }
  return {
    titleKey: message.titleKey,
    bodyKey: message.bodyKey,
    ...(count === 0 ? {} : { params }),
  };
}
