import { createHash } from "node:crypto";
import type { LearnedFact } from "@psyche/protocol";
import { blockingKinds, looksLikeInstruction } from "./filters.ts";
import type { ProfileField } from "./profile-fields.ts";
import { type ProfileSection, parseSectionFacts, SECTION_LINE } from "./profile-sections.ts";

/**
 * `USER.md`'s dated "Learned" section (feature #509): facts about the owner distilled from the
 * owner's own messages, one line each with its id, date and the thread it came from, beside the
 * Directives section. This package is the one writer (security §8 "One writer"): the learner in
 * the Gateway proposes, `learnUserFacts` filters, dedupes and writes; `forgetLearned` undoes.
 */

export const LEARNED_HEADING = "## Learned (dated; from your chats)";
const LINE =
  /^- (\d{4}-\d{2}-\d{2}) \[(lf_[a-z0-9]{6,32}) thread:([^\]\s]+) (\w+)(?: field:(name|timezone|work|home_city))?(?: lesson:(ls_[a-z0-9_]+))?\] (.+)$/;

/** A learned fact, optionally written by a teaching-loop lesson (docs/agent/teaching-loop-2026.md §4). */
export interface LearnedFactLine extends LearnedFact {
  lessonId?: string;
  /**
   * The USER.md header field this fact filled (`field:` in the line), set only for facts from the
   * owner's own words. The line stays as provenance for the header value.
   */
  field?: ProfileField;
  /**
   * The USER.md profile section the fact is a bullet of (Education, Work history, Skills, …)
   * instead of a Learned line; set only for facts from the owner's own words.
   */
  section?: ProfileSection;
}

export interface LearnedLine extends LearnedFactLine {
  /** 1-based line in USER.md. */
  line: number;
}

export function parseLearned(content: string): LearnedLine[] {
  const out: LearnedLine[] = [];
  content.split("\n").forEach((raw, i) => {
    const m = LINE.exec(raw.trimEnd());
    if (m === null) return;
    out.push({
      line: i + 1,
      date: m[1] as string,
      factId: m[2] as string,
      threadId: m[3] as string,
      kind: m[4] as LearnedFact["kind"],
      ...(m[5] === undefined ? {} : { field: m[5] as ProfileField }),
      ...(m[6] === undefined ? {} : { lessonId: m[6] }),
      text: m[7] as string,
    });
  });
  for (const f of parseSectionFacts(content)) {
    out.push({ ...f, kind: (KINDS.has(f.kind) ? f.kind : "other") as LearnedFact["kind"] });
  }
  return out.sort((a, b) => a.line - b.line);
}

const KINDS = new Set(["name", "preference", "routine", "person", "project", "other"]);

/** The fact id of a Learned line or a profile-section bullet. */
function factIdOf(raw: string): string | undefined {
  const l = raw.trimEnd();
  return LINE.exec(l)?.[2] ?? SECTION_LINE.exec(l)?.[2];
}

/** Lowercase words only: "Prefers tea." and "prefers  tea" are the same fact. */
export function normalizeFact(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function learnedFactId(text: string, threadId: string): string {
  return `lf_${createHash("sha256")
    .update(`${threadId}|${normalizeFact(text)}`)
    .digest("hex")
    .slice(0, 12)}`;
}

export type LearnRefusal = "empty" | "duplicate" | "sensitive" | "instruction" | "too_long";

/** Why a proposed fact is not written, or undefined when it may be. */
export function refuseFact(text: string, known: readonly string[]): LearnRefusal | undefined {
  const t = text.replace(/\s+/g, " ").trim();
  if (t === "") return "empty";
  if (t.length > 300) return "too_long";
  // Secrets and cards always; government ids, financial accounts and health unless asked for.
  if (blockingKinds(t, false).length > 0) return "sensitive";
  if (looksLikeInstruction(t)) return "instruction";
  const n = normalizeFact(t);
  if (known.some((k) => k === n || (n.length > 12 && k.includes(n)))) return "duplicate";
  return undefined;
}

/** Adds lines under the Learned heading (creating the section at the end of the file). */
export function formatLearned(f: LearnedFactLine): string {
  const lesson = f.lessonId === undefined ? "" : ` lesson:${f.lessonId}`;
  const field = f.field === undefined ? "" : ` field:${f.field}`;
  return `- ${f.date} [${f.factId} thread:${f.threadId} ${f.kind}${field}${lesson}] ${f.text.replace(/\s+/g, " ").trim()}`;
}

export function addLearned(content: string, facts: readonly LearnedFactLine[]): string {
  if (facts.length === 0) return content;
  const lines = facts.map(formatLearned);
  const all = content.split("\n");
  const at = all.findIndex((l) => l.trim() === LEARNED_HEADING);
  if (at < 0) {
    const base = content.replace(/\s+$/, "");
    return `${base}${base === "" ? "" : "\n\n"}${LEARNED_HEADING}\n\n${lines.join("\n")}\n`;
  }
  // After the heading's existing lines: the end of the section (the next heading or EOF).
  let end = at + 1;
  while (end < all.length && !(all[end] ?? "").startsWith("## ")) end++;
  while (end > at + 1 && (all[end - 1] ?? "").trim() === "") end--;
  const insert = end === at + 1 ? ["", ...lines] : lines;
  all.splice(end, 0, ...insert);
  return all.join("\n");
}

/**
 * Removes one learned line, or puts `restore` (the line a lesson replaced) in its place;
 * `undefined` when it is not there.
 */
export function removeLearned(
  content: string,
  factId: string,
  restore?: string,
): string | undefined {
  const lines = content.split("\n");
  const i = lines.findIndex((l) => factIdOf(l) === factId);
  if (i < 0) return undefined;
  if (restore === undefined) lines.splice(i, 1);
  else lines[i] = restore;
  return lines.join("\n");
}

/**
 * A pattern for `oldStr` that also matches the lines of `USER.md` it was copied from when the
 * hidden machine tags are missing: the ` <!--lf_… -->` tag after a profile bullet and the
 * `[lf_… thread:… kind]` tag after a Learned line's date. The model sees USER.md without them
 * (`compactUserView`), so an exact `str_replace` on what it saw finds 0 matches.
 */
export function tagTolerantPattern(oldStr: string): RegExp {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const tail = "(?:[ \\t]*<!--lf_[a-z0-9]{6,32} [^>\\n]*-->)?";
  const lines = oldStr.split("\n").map((line) => {
    const m = /^(- \d{4}-\d{2}-\d{2} )(.*)$/.exec(line);
    const head =
      m === null
        ? esc(line)
        : `${esc(m[1] as string)}(?:\\[lf_[^\\]\\n]*\\] )?${esc(m[2] as string)}`;
    // A tag sits at the end of a line; an empty last piece (old_str ends with "\n") adds none.
    return line === "" ? head : `${head}${tail}`;
  });
  return new RegExp(lines.join("\n"), "g");
}

/** The raw line of a learned fact, or `undefined`. */
export function learnedLine(content: string, factId: string): string | undefined {
  return content.split("\n").find((l) => factIdOf(l) === factId);
}

// --- The prompt view ---------------------------------------------------------------------------

/** `- 2026-11-01 superseded by 2026-11-05: text` (a directive the owner replaced). */
const SUPERSEDED_DIRECTIVE = /^- \d{4}-\d{2}-\d{2} superseded by \d{4}-\d{2}-\d{2}: /;
/** The machine tag a profile-section bullet carries: ` <!--lf_… -->`. */
const SECTION_TAG = /\s*<!--lf_[a-z0-9]{6,32} [^>]*-->\s*$/;

export interface UserPromptView {
  text: string;
  /** True when lines or characters were cut to fit the budget. */
  truncated: boolean;
}

/**
 * The compact view of `USER.md` the prompt carries (audit P6): the owner-written sections first,
 * unchanged apart from the machine tag on profile-section bullets and directives the owner
 * replaced; then the Learned lines newest first as `- date text`, with their `[lf_… thread:… kind]`
 * tags dropped, as many as fit in `budget` characters. A cut leaves a marker naming how many
 * lines are shown. The file on disk is never rewritten; this only builds prompt text.
 *
 * The owner part alone can exceed the budget: it is then cut from the head with a marker, and
 * no Learned line is shown.
 */
export function compactUserView(
  content: string,
  budget: number,
  label = "USER.md",
): UserPromptView {
  const lines = content.trimEnd().split("\n");
  const owner: string[] = [];
  const learned: { date: string; text: string; at: number }[] = [];
  let inLearned = false;
  let sawHeading = false;
  lines.forEach((raw, at) => {
    const line = raw.trimEnd();
    if (line.trim() === LEARNED_HEADING) {
      inLearned = true;
      sawHeading = true;
      return;
    }
    if (line.startsWith("## ")) inLearned = false;
    if (SUPERSEDED_DIRECTIVE.test(line)) return;
    const m = inLearned ? LINE.exec(line) : null;
    if (m !== null) {
      learned.push({ date: m[1] as string, text: (m[7] as string).trim(), at });
      return;
    }
    owner.push(line.replace(SECTION_TAG, ""));
  });
  // Newest first; among the same date the line appended last wins.
  learned.sort((a, b) => (a.date === b.date ? b.at - a.at : a.date < b.date ? 1 : -1));
  const ownerText = owner
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
  if (ownerText.length > budget) {
    const kept = ownerText.slice(0, budget);
    return {
      text: `${kept}\n[truncated: ${label} owner sections are ${ownerText.length.toLocaleString("en-US")} characters; the first ${budget.toLocaleString("en-US")} are shown. The full file is in the workspace.]`,
      truncated: true,
    };
  }
  const head =
    sawHeading || learned.length > 0 ? `${ownerText}\n\n${LEARNED_HEADING}\n` : ownerText;
  const shown: string[] = [];
  let used = head.length;
  for (const l of learned) {
    const row = `- ${l.date} ${l.text}`;
    if (used + row.length + 1 > budget) break;
    shown.push(row);
    used += row.length + 1;
  }
  const cut = learned.length - shown.length;
  const body = shown.join("\n");
  if (cut === 0) return { text: `${head}${body}`.trimEnd(), truncated: false };
  const marker = `[truncated: ${label} has ${learned.length.toLocaleString("en-US")} learned lines; the newest ${shown.length.toLocaleString("en-US")} are shown, ${cut.toLocaleString("en-US")} older left out. The full file is in the workspace.]`;
  return { text: `${head}${body}${body === "" ? "" : "\n"}${marker}`, truncated: true };
}
