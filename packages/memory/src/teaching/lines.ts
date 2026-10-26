import type { LessonScope } from "@psyche/protocol";
import { scopeKey } from "./store.ts";

/**
 * Lesson-owned lines in workspace files (docs/agent/teaching-loop-2026.md §4 rule 2): one line
 * per lesson, tagged with its id and scope, inside a section the lesson owns or appended to a
 * section the owner owns. Only tagged lines are ever rewritten or removed; the owner's own text
 * is never touched.
 *
 *     - 2026-10-25 [ls_01j… recipient=jane@example.com] Replies to Jane are short.
 */

const LINE = /^- (\d{4}-\d{2}-\d{2}) \[(ls_[a-z0-9_]+)(?: ([a-zA-Z]+=[^\]]+))?\] (.+)$/;

export interface LessonLine {
  /** 0-based index in the file. */
  index: number;
  date: string;
  lessonId: string;
  scope: string | undefined;
  text: string;
}

export function formatLessonLine(
  date: string,
  lessonId: string,
  scope: LessonScope,
  text: string,
): string {
  const s = scopeKey(scope);
  return `- ${date} [${lessonId}${s === "global" ? "" : ` ${s}`}] ${text.replace(/\s+/g, " ").trim()}`;
}

export function parseLessonLines(content: string): LessonLine[] {
  const out: LessonLine[] = [];
  content.split("\n").forEach((raw, index) => {
    const m = LINE.exec(raw.trimEnd());
    if (m === null) return;
    out.push({
      index,
      date: m[1] as string,
      lessonId: m[2] as string,
      scope: m[3],
      text: m[4] as string,
    });
  });
  return out;
}

export function findLessonLine(content: string, lessonId: string): string | undefined {
  const l = parseLessonLines(content).find((x) => x.lessonId === lessonId);
  return l === undefined ? undefined : content.split("\n")[l.index];
}

/** The text of a lesson's line, without the date and tag. */
export function lessonLineText(content: string, lessonId: string): string | undefined {
  return parseLessonLines(content).find((x) => x.lessonId === lessonId)?.text;
}

/**
 * Puts `line` in the section `## <section>`: in place of `replaces`' line when it is there, else
 * at the end of the section (created at the end of the file when missing).
 */
export function upsertLessonLine(
  content: string,
  section: string,
  line: string,
  replaces?: string,
): string {
  const lines = content.split("\n");
  if (replaces !== undefined) {
    const at = parseLessonLines(content).find((x) => x.lessonId === replaces);
    if (at !== undefined) {
      lines[at.index] = line;
      return lines.join("\n");
    }
  }
  const heading = `## ${section}`;
  const at = lines.findIndex((l) => l.trim() === heading);
  if (at < 0) {
    const base = content.replace(/\s+$/, "");
    return `${base}${base === "" ? "" : "\n\n"}${heading}\n\n${line}\n`;
  }
  let end = at + 1;
  while (end < lines.length && !(lines[end] ?? "").startsWith("## ")) end++;
  while (end > at + 1 && (lines[end - 1] ?? "").trim() === "") end--;
  lines.splice(end, 0, ...(end === at + 1 ? ["", line] : [line]));
  return lines.join("\n");
}

/**
 * Removes a lesson's line, or puts `restore` in its place (the line it replaced). `undefined`
 * when the line is not there.
 */
export function removeLessonLine(
  content: string,
  lessonId: string,
  restore?: string,
): string | undefined {
  const at = parseLessonLines(content).find((x) => x.lessonId === lessonId);
  if (at === undefined) return undefined;
  const lines = content.split("\n");
  if (restore === undefined) lines.splice(at.index, 1);
  else lines[at.index] = restore;
  return lines.join("\n");
}
