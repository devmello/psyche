import { findSensitiveNormalized, type SensitiveKind } from "@psyche/audit";

/**
 * The outbound check (security §3.9): one deterministic function, outside the model, that every
 * path carrying Psyche's own text to another service or person goes through. It withholds
 * credentials, full card details, bank account numbers, government ID numbers and one-time codes.
 *
 * - `owner`: a reply into the owner's own chat. The value is cut out and the owner is told to open
 *   Psyche to see it. If an encoded form (full-width digits, zero-width joiners) still matches after
 *   the cut, the whole message is replaced.
 * - `other`: a group, another person, or an email reply. The message is held: not sent.
 *
 * Published test card numbers get no exception here: `prohibitions.ts` allows them only when the
 * target is the owner's own loopback project, and a message has no such target.
 * Only the kinds are reported, never the values.
 */

export type OutboundAudience = "owner" | "other";

export const OUTBOUND_WITHHELD_NOTICE = "[withheld: open Psyche to see it]";

export type OutboundVerdict =
  | { action: "allow" }
  | { action: "redact"; text: string; kinds: SensitiveKind[] }
  | { action: "hold"; kinds: SensitiveKind[] };

function kindsIn(views: readonly string[]): SensitiveKind[] {
  const kinds = new Set<SensitiveKind>();
  for (const v of views) for (const m of findSensitiveNormalized(v)) kinds.add(m.kind);
  return [...kinds];
}

/**
 * `render` is how the text will actually be sent when that differs (Markdown flattened to plain
 * text can join `**4111**…` into one run); the rendering is scanned too.
 */
export function checkOutbound(
  text: string,
  audience: OutboundAudience,
  render: (text: string) => string = (t) => t,
): OutboundVerdict {
  const seen = (t: string) => [t, render(t)];
  const kinds = kindsIn(seen(text));
  if (kinds.length === 0) return { action: "allow" };
  if (audience === "other") return { action: "hold", kinds };
  const normalized = text.normalize("NFKC").replace(/[\p{Cf}]/gu, "");
  let out = "";
  let at = 0;
  for (const m of findSensitiveNormalized(text)) {
    if (m.index < at) continue;
    out += normalized.slice(at, m.index) + OUTBOUND_WITHHELD_NOTICE;
    at = m.index + m.length;
  }
  out += normalized.slice(at);
  // Anything still matching in the cut text or its rendering means the whole message goes.
  return {
    action: "redact",
    text: kindsIn(seen(out)).length === 0 ? out : OUTBOUND_WITHHELD_NOTICE,
    kinds,
  };
}
