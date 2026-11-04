/**
 * Only the owner's own sentences (docs/design/memory-everything-2026.md §7, MW7 review). Text the
 * owner pastes into chat or a note ("is this real? ...", a forwarded notice, "my prof says ...",
 * "Canvas: HW7 due Nov 12") is somebody else's words. This is a noise filter, not a trust
 * boundary: it decides what may even be *proposed* from owner text, and which low-harm fields
 * may be written. Anything that changes a status, a deadline or creates a to-do is only ever a
 * proposal the owner confirms. It errs towards dropping.
 *
 * What it removes, in order:
 * - fenced blocks, `>` quoted lines, mail header blocks and the paragraph under them, pastes
 *   (a paragraph over 400 characters or with 4 or more lines);
 * - every quoted span of any length and in any quote style, and a lone opening quote to the end
 *   of its paragraph;
 * - lines that start with a source label ("Canvas:", "Piazza:", "From ...");
 * - every sentence with a question mark, with a reporting verb or phrase ("says", "wrote",
 *   "according to", "per", "apparently", "emailed", "told us", and common French, German,
 *   Spanish and Chinese forms), whichever side of the verb the claim is on;
 * - a sentence that a later sentence takes back ("jk", "not yet", "never mind").
 *
 * Removed text is replaced by a marker no quote can span, so a quote never bridges two sentences
 * that had something removed between them.
 */

/** Marker left where text was removed. */
export const REMOVED = "\u0001";

export const MAX_OWN_PARAGRAPH_CHARS = 400;
export const MAX_OWN_PARAGRAPH_LINES = 4;

const FENCE = /```[\s\S]*?(?:```|$)/g;
const HEADER =
  /^\s*(?:from|to|cc|bcc|subject|date|sent|reply-to|de|para|asunto|von|an|betreff)\s*:/i;
/** Names of places text comes from: "Canvas: HW7 due Nov 12" is the site talking, not the owner. */
const SOURCE_LINE =
  /^\s*(?:canvas|gradescope|piazza|classroom|google classroom|blackboard|moodle|brightspace|slack|discord|teams|email|e-mail|mail|gmail|outlook|message|text|sms|imessage|whatsapp|signal|telegram|chat|prof|professor|ta|teacher|instructor|notification|announcement|reminder|jira|linear|github|reddit|twitter|forwarded|fwd|fw|re|quote|source|from)\b[^:\n]{0,30}:/i;

const QUOTE_PAIRS: [string, string][] = [
  ['"', '"'],
  ["“", "”"],
  ["„", "“"],
  ["«", "»"],
  ["»", "«"],
  ["＂", "＂"],
  ["「", "」"],
  ["『", "』"],
  ["‘", "’"],
  ["`", "`"],
];
const OPENERS = new Set(QUOTE_PAIRS.map(([o]) => o));

/** A pair of quote marks and everything between, in any style. */
function stripQuotes(para: string): string {
  let out = para;
  for (const [o, c] of QUOTE_PAIRS) {
    const re = new RegExp(`${esc(o)}[^${esc(c)}]*${esc(c)}`, "gu");
    out = out.replace(re, ` ${REMOVED} `);
  }
  // Straight single quotes: an opening one not inside a word, a closing one not inside a word,
  // so apostrophes ("don't") inside the span do not end it.
  out = out.replace(
    /(?<![\p{L}\p{N}])'(?:[^'\n]|'(?=[\p{L}\p{N}]))*'(?![\p{L}\p{N}])/gu,
    ` ${REMOVED} `,
  );
  // A quote that never closes runs to the end of its paragraph.
  const chars = Array.from(out);
  const at = chars.findIndex((ch) => OPENERS.has(ch));
  if (at >= 0) out = `${chars.slice(0, at).join("")} ${REMOVED}`;
  return out;
}

const esc = (s: string) => s.replace(/[\\^$.*+?()[\]{}|-]/g, "\\$&");

/** A reporting verb or phrase: the sentence carries someone else's claim. */
const REPORTING = new RegExp(
  [
    String.raw`\b(?:says?|said|saying|is saying|are saying|wrote|writes|written|told (?:me|us)|tells? (?:me|us)|according to|per|apparently|reportedly|supposedly|allegedly|emailed|e-mailed|messaged|texted|pinged|announced|posted|replied|mentioned|claims?|claimed|noted|notified|reminded me|heard|reads|forwarded|pasted|screenshot)\b`,
    // French, German, Spanish
    String.raw`\b(?:dit|dis|a dit|écrit|ecrit|selon|d'après|sagt|sagte|schreibt|schrieb|laut|gemäß|dice|dijo|escribió|escribio|escribe|según|segun|me dijo|me avisó)\b`,
    // Chinese
    "说道?|写道|写着|表示|据|根据",
  ].join("|"),
  "iu",
);
/** A later sentence that takes the earlier one back. */
const RETRACT =
  /^\s*(?:jk\b|just kidding|kidding|not yet\b|nope\b|lol no\b|never ?mind|nvm\b|actually,? no\b|scratch that|wait,? no\b)/i;

/** Sentences with the whitespace that followed each, so removed ones can be marked in place. */
function sentences(para: string): { text: string; sep: string }[] {
  const out: { text: string; sep: string }[] = [];
  const re = /[^.!?。！？\n]*(?:[.!?。！？]+|\n|$)(\s*)/gu;
  let m: RegExpExecArray | null = re.exec(para);
  while (m !== null && m[0] !== "") {
    const whole = m[0];
    const sep = m[1] ?? "";
    out.push({ text: whole.slice(0, whole.length - sep.length), sep });
    m = re.exec(para);
  }
  return out;
}

export function ownWords(text: string): string {
  const base = text.replace(FENCE, `\n\n${REMOVED}\n\n`);
  const kept: string[] = [];
  let afterHeader = false;
  for (const para of base.split(/\n\s*\n/)) {
    const lines = para.split("\n").filter((l) => l.trim() !== "");
    const headerLike = lines.filter((l) => HEADER.test(l)).length;
    const quotedLines = lines.filter((l) => /^\s*>/.test(l)).length;
    const paste = para.length > MAX_OWN_PARAGRAPH_CHARS || lines.length >= MAX_OWN_PARAGRAPH_LINES;
    if (headerLike >= 2 || (lines.length > 0 && HEADER.test(lines[0] as string))) {
      afterHeader = true;
      kept.push(REMOVED);
      continue;
    }
    if (afterHeader || paste || (quotedLines > 0 && quotedLines === lines.length)) {
      afterHeader = false;
      kept.push(REMOVED);
      continue;
    }
    const plain = lines.filter((l) => !/^\s*>/.test(l) && !SOURCE_LINE.test(l)).join("\n");
    const quoted = stripQuotes(plain);
    const parts = sentences(quoted);
    const result: string[] = [];
    for (const s of parts) {
      const drop = /[?？]/.test(s.text) || REPORTING.test(s.text) || s.text.includes(REMOVED);
      if (RETRACT.test(s.text) && result.length > 0) {
        // The owner took the sentence before it back.
        result[result.length - 1] = ` ${REMOVED} `;
      }
      result.push(drop ? ` ${REMOVED}${s.sep}` : `${s.text}${s.sep}`);
    }
    kept.push(result.join("").trim());
  }
  return kept.join("\n\n");
}
