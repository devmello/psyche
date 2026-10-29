import { createHash } from "node:crypto";

export const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

/**
 * Drops quoted replies from a mail body (`>` lines, "On … wrote:" and what follows, Outlook
 * "From:/Sent:" headers, "-----Original Message-----"), so a long thread is not stored once per
 * reply. Falls back to the whole text when stripping would leave nothing.
 */
export function stripQuotedReplies(body: string): string {
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  const keep: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/^\s*-{2,}\s*(original message|forwarded message)\s*-{2,}\s*$/i.test(line)) break;
    if (/^\s*on .{5,200}wrote:\s*$/i.test(line)) break;
    if (/^\s*on .{5,200}$/i.test(line) && /wrote:\s*$/i.test(lines[i + 1] ?? "")) break;
    if (
      /^\s*from:\s.+/i.test(line) &&
      /^\s*(sent|date):\s/i.test(lines[i + 1] ?? "") &&
      keep.length > 0
    )
      break;
    if (/^\s*>/.test(line)) continue;
    keep.push(line);
  }
  const out = keep.join("\n").trim();
  return out === "" ? body.trim() : out;
}

/** Plain text of a note's HTML body, for notes that arrive without a plain-text field. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}
