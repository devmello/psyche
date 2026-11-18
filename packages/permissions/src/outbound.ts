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
}

/** The part of a message worth remembering for the next one. */
export function outboundTail(sent: string): string {
  return sent.slice(-OUTBOUND_TAIL_CHARS);
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
  const lead = options.tail === undefined || options.tail === "" ? "" : `${options.tail}\n`;
  const joined = (t: string) => lead + t;

  const scan = (t: string): SensitiveMatch[] => {
    const whole = joined(t);
    // Only what reaches into this message counts: the tail was already sent.
    const hits = findSensitiveOriginal(whole).filter(relevant);
    const own = hits.filter((m) => m.index + m.length > lead.length);
    const shown = findSensitiveNormalized(joined(render(t))).filter(relevant);
    return [...own, ...shown];
  };

  const found = scan(text);
  if (found.length === 0) return { action: "allow" };
  const kinds = [...new Set(found.map((m) => m.kind))];
  if (audience === "other") return { action: "hold", kinds };

  // Cut exactly the matched spans out of the original text; everything else stays as written.
  const spans = findSensitiveOriginal(joined(text))
    .filter(relevant)
    .filter((m) => m.index + m.length > lead.length)
    .map((m) => {
      const from = Math.max(m.index, lead.length) - lead.length;
      return { index: from, length: m.index + m.length - lead.length - from };
    });
  let out = "";
  let at = 0;
  for (const s of mergeSpans(spans)) {
    out += text.slice(at, s.index) + OUTBOUND_WITHHELD_NOTICE;
    at = s.index + s.length;
  }
  out += text.slice(at);
  // A match that survives the cut (a form only the rendering reveals) means the whole message goes.
  const clean = scan(out).length === 0;
  return { action: "redact", text: clean ? out : OUTBOUND_WITHHELD_NOTICE, kinds };
}
