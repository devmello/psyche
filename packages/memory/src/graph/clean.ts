/** One line of third-party text made safe to show: see the nudge design note §2. */
export function safeName(name: string, max = 60): string {
  let out = "";
  for (const ch of name) {
    const c = ch.codePointAt(0) as number;
    const invisible =
      c < 0x20 ||
      c === 0x7f ||
      (c >= 0x200b && c <= 0x200f) ||
      c === 0x2028 ||
      c === 0x2029 ||
      (c >= 0x2060 && c <= 0x2064) ||
      c === 0xfeff;
    out += invisible ? " " : ch;
  }
  return out.replace(/\s+/g, " ").trim().slice(0, max);
}
