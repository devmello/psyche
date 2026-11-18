import {
  findSensitiveNormalized,
  findSensitiveOriginal,
  type SensitiveKind,
  type SensitiveMatch,
} from "@psyche/audit";

/**
 * The outbound check (security §3.9): one deterministic function, outside the model, that every
 * path carrying Psyche's own text to another service or person goes through. It withholds
 * credentials, full card details, bank account numbers, government ID numbers and one-time codes.
 *
 * - `owner`: a reply into the owner's own one-to-one chat. The value is cut out and the owner is
 *   told to open Psyche to see it. One-time codes are allowed here: they go to the person they were
 *   sent to. If a form of the value still matches after the cut, the whole message is replaced.
 * - `other`: a group, another person, or an email reply. The message is held: not sent.
 *
 * Published test card numbers get no exception here: `prohibitions.ts` allows them only when the
 * target is the owner's own loopback project, and a message has no such target.
 * Only the kinds are reported, never the values.
 *
 * Out of reach for any detector, and said so on the security page: digits spelled out as words,
 * base64 or other encodings, reversed digits, and separators made of letters.
 */

export type OutboundAudience = "owner" | "other";

export const OUTBOUND_WITHHELD_NOTICE = "[withheld: open Psyche to see it]";

/** How much of the previous message is kept to catch a number split across two messages. */
export const OUTBOUND_TAIL_CHARS = 40;
/** How far back a trailing chain of digits is kept, so a long split number is whole. */
export const OUTBOUND_TAIL_REACH = 200;

/**
 * Kinds a send tool may never carry, even with approval: credentials, cards and their codes, IBANs
 * and US Social Security numbers. The others (one-time codes, passports, SIN, NI and Aadhaar numbers,
 * a routing and account number) ask on a paired device instead (owner decision, review round 2).
 */
export const HARD_OUTBOUND_KINDS: ReadonlySet<SensitiveKind> = new Set<SensitiveKind>([
  "private_key",
  "api_key",
  "bearer_token",
  "jwt",
  "url_credentials",
  "card_number",
  "card_security",
  "iban",
  "us_ssn",
]);

/** The outbound reading of the detectors: cards split by newlines, pipes, bullets and the like. */
const OUTBOUND = { outbound: true } as const;

export type OutboundVerdict =
  | { action: "allow" }
  | { action: "redact"; text: string; kinds: SensitiveKind[] }
  | { action: "hold"; kinds: SensitiveKind[] };

export interface OutboundOptions {
  /**
   * The end of the last message sent to the same chat a moment ago (what was sent, not what was
   * held): a number split across two messages is read as one.
   */
  tail?: string;
  /** What replaces a cut value in the owner's chat, in the owner's language. */
  notice?: string;
}

/**
 * What goes between the earlier message and the new one, so a number split across them reads as
 * the one number it is: nothing when the tail already ends in a separator, else the separator its
 * last digit groups use ("4111 1111" + "1111 1111" joins with a space), else a space.
 */
function tailJoin(tail: string): string {
  if (!/\d$/u.test(tail)) return /[\p{L}\p{N}]$/u.test(tail) ? " " : "";
  const gap = /\d([\s\p{Pd}|/_.·•:\u2212]{1,3})\d+$/u.exec(tail);
  return gap?.[1] ?? " ";
}

const CHAIN_CHAR = /[\d\s\p{Pd}|/_.·•:\u2212]/u;

/**
 * The part of a message worth remembering for the next one: the last 40 characters, reaching back
 * over a trailing chain of digits and separators (up to 200 characters) and 40 more before it, so
 * the start of a split number and the card word next to it are both kept.
 */
export function outboundTail(sent: string): string {
  let start = Math.max(0, sent.length - OUTBOUND_TAIL_CHARS);
  const floor = Math.max(0, sent.length - OUTBOUND_TAIL_REACH);
  let reached = false;
  while (start > floor && CHAIN_CHAR.test(sent.charAt(start - 1))) {
    start -= 1;
    reached = true;
  }
  return sent.slice(reached ? Math.max(0, start - OUTBOUND_TAIL_CHARS) : start);
}

function mergeSpans(
  spans: { index: number; length: number }[],
): { index: number; length: number }[] {
  const sorted = [...spans].sort((a, b) => a.index - b.index || b.length - a.length);
  const out: { index: number; length: number }[] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last !== undefined && s.index <= last.index + last.length) {
      last.length = Math.max(last.length, s.index + s.length - last.index);
    } else out.push({ ...s });
  }
  return out;
}

/**
 * `render` is how the text will actually be sent when that differs (Markdown flattened to plain
 * text can join `**4111**…` into one run); the rendering is scanned too.
 */
export function checkOutbound(
  text: string,
  audience: OutboundAudience,
  render: (text: string) => string = (t) => t,
  options: OutboundOptions = {},
): OutboundVerdict {
  const relevant = (m: SensitiveMatch) => audience === "other" || m.kind !== "one_time_code";
  const tail = options.tail ?? "";
  const notice = options.notice ?? OUTBOUND_WITHHELD_NOTICE;
  const lead = tail === "" ? "" : tail + tailJoin(tail);
  const renderedTail = tail === "" ? "" : render(tail);
  const renderedLead = renderedTail === "" ? "" : renderedTail + tailJoin(renderedTail);

  // Only what reaches into this message counts: the tail was already sent. The tail and the
  // message are rendered apart, so a hit inside the rendered tail alone is not counted either.
  const reaching = (prefix: string, body: string) =>
    findSensitiveOriginal(prefix + body, OUTBOUND)
      .filter(relevant)
      .filter((m) => m.index + m.length > prefix.length);
  const scan = (t: string): SensitiveMatch[] => [
    ...reaching(lead, t),
    ...reaching(renderedLead, render(t)),
  ];

  const found = scan(text);
  if (found.length === 0) return { action: "allow" };
  const kinds = [...new Set(found.map((m) => m.kind))];
  if (audience === "other") return { action: "hold", kinds };

  // Cut exactly the matched spans out of the original text; everything else stays as written.
  const spans = reaching(lead, text).map((m) => {
    const from = Math.max(m.index, lead.length) - lead.length;
    return { index: from, length: m.index + m.length - lead.length - from };
  });
  let out = "";
  let at = 0;
  for (const s of mergeSpans(spans)) {
    out += text.slice(at, s.index) + notice;
    at = s.index + s.length;
  }
  out += text.slice(at);
  // A match that survives the cut (a form only the rendering reveals) means the whole message goes.
  const clean = scan(out).length === 0;
  return { action: "redact", text: clean ? out : notice, kinds };
}

export type OutboundSendDecision =
  | { action: "allow" }
  | { action: "deny"; kinds: SensitiveKind[] }
  | { action: "ask"; kinds: SensitiveKind[] };

/**
 * For tools that send to someone (`messages_send`, email and message tools): a hard kind found by
 * the strict reading (the one the hard prohibitions use, as on main) is refused; anything else the
 * outbound check holds, including a card only the broader outbound reading sees (digit rows aligned
 * with two spaces, bullets), asks on a paired device instead of being refused outright.
 */
export function outboundSendDecision(text: string): OutboundSendDecision {
  const strictHard = [
    ...new Set(
      findSensitiveNormalized(text)
        .map((m) => m.kind)
        .filter((k) => HARD_OUTBOUND_KINDS.has(k)),
    ),
  ];
  if (strictHard.length > 0) return { action: "deny", kinds: strictHard };
  const verdict = checkOutbound(text, "other");
  return verdict.action === "hold" ? { action: "ask", kinds: verdict.kinds } : { action: "allow" };
}
