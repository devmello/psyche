import { domainToASCII } from "node:url";

/**
 * Value-slot sanitizer for anything a chat surface shows the owner as a fact (approval cards,
 * pairing notices). Review design-12: invisible format and control characters are shown as
 * `⟨U+XXXX⟩`, line breaks collapse to `⏎` so a value cannot forge extra card lines, and hosts
 * with non-ASCII labels are shown in punycode. Values are never truncated here; a card that does
 * not fit its surface is replaced as a whole (see `renderApprovalCard`).
 */

const LINE_BREAKS = new Set([0x0a, 0x0d, 0x2028, 0x2029, 0x85]);

/** Unicode Cf characters that matter for spoofing, plus C0 / C1 controls other than tab. */
function isHidden(cp: number): boolean {
  return (
    (cp < 0x20 && cp !== 0x09) ||
    (cp >= 0x7f && cp <= 0x9f) ||
    cp === 0xad ||
    cp === 0x061c ||
    cp === 0x180e ||
    (cp >= 0x200b && cp <= 0x200f) ||
    (cp >= 0x202a && cp <= 0x202e) ||
    (cp >= 0x2060 && cp <= 0x2064) ||
    (cp >= 0x2066 && cp <= 0x206f) ||
    cp === 0xfeff ||
    (cp >= 0xfff9 && cp <= 0xfffb) ||
    (cp >= 0xe0000 && cp <= 0xe007f)
  );
}

export function sanitizeValue(value: string): string {
  let out = "";
  let previousCr = false;
  for (const ch of value) {
    const cp = ch.codePointAt(0) ?? 0;
    if (LINE_BREAKS.has(cp)) {
      if (!(previousCr && cp === 0x0a)) out += "⏎";
      previousCr = cp === 0x0d;
      continue;
    }
    previousCr = false;
    out += isHidden(cp) ? `⟨U+${cp.toString(16).toUpperCase().padStart(4, "0")}⟩` : ch;
  }
  return punycodeHosts(out);
}

const HOSTISH = /((?:https?:\/\/)?)((?:[^\s/:@?#⏎⟨⟩"'<>()]+\.)+[^\s/:@?#⏎⟨⟩"'<>().]+)/gu;

/** Rewrites every host-looking token that contains non-ASCII characters to its punycode form. */
export function punycodeHosts(text: string): string {
  return text.replace(HOSTISH, (match, scheme: string, host: string) => {
    if (/^[\x21-\x7E]*$/.test(host)) return match;
    const ascii = domainToASCII(host.toLowerCase());
    return ascii === "" ? match : `${scheme}${ascii}`;
  });
}
