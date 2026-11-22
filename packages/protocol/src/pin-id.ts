/**
 * A stable id for a standing instruction in a thread's compaction summary: a hash of its text
 * with whitespace folded and case ignored. The owner removes a pin by this id, so a long pin or
 * one with unusual characters never has to travel as text. Not a security boundary: 64 bits of two
 * FNV-1a passes, plenty to tell apart the at most 40 pins of one thread.
 */
export function pinId(text: string): string {
  const s = text.replace(/\s+/g, " ").trim().toLowerCase();
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ (c + i), 0x85ebca6b) >>> 0;
  }
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}
