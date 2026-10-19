import { type Provenance, PsycheError } from "@psyche/protocol";
import { formatTag, type ProvenanceTag, parseTag, trustRank } from "./provenance.ts";

/**
 * Daily notes, `memory/YYYY-MM-DD.md` (data model §7.1): append-only, one bullet per entry,
 * `- HH:MM [provenance] text`. Entries without a valid tag are `agent` (unknown provenance is
 * never `owner`). Continuation lines (indented) belong to the entry above them.
 */

export interface DailyEntry {
  /** 1-based, inclusive. */
  lineStart: number;
  lineEnd: number;
  time?: string;
  /** `undefined` when the line had no valid tag. */
  tag?: ProvenanceTag;
  provenance: Provenance;
  /** Entry text without the bullet, time and tag; continuation lines joined with spaces. */
  text: string;
}

const TAGGED = /^[-*] (\d{2}:\d{2}) \[([^\]\n]*)\] ?(.*)$/;
const TIMED = /^[-*] (\d{2}:\d{2}) (.*)$/;
const BULLET = /^[-*] (.*)$/;

/** Collapses an entry to one line (entries are one bullet each). */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function formatEntry(time: string, tag: ProvenanceTag, text: string): string {
  return `- ${time} [${formatTag(tag)}] ${oneLine(text)}`;
}

export function newDailyNote(date: string): string {
  return `# ${date}\n\n`;
}

interface ParsedLine {
  time?: string;
  tag?: ProvenanceTag;
  text: string;
}

function parseLine(line: string): ParsedLine | undefined {
  if (line.trim().length === 0 || line.startsWith("#")) return undefined;
  const tagged = TAGGED.exec(line);
  if (tagged !== null) {
    const tag = parseTag(tagged[2] ?? "");
    if (tag !== undefined) return { time: tagged[1], tag, text: tagged[3] ?? "" };
    return { time: tagged[1], text: `[${tagged[2]}] ${tagged[3] ?? ""}` };
  }
  const timed = TIMED.exec(line);
  if (timed !== null) return { time: timed[1], text: timed[2] ?? "" };
  const bullet = BULLET.exec(line);
  return { text: bullet === null ? line.trim() : (bullet[1] ?? "") };
}

export function parseDailyNote(content: string): DailyEntry[] {
  const entries: DailyEntry[] = [];
  let current: DailyEntry | undefined;
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const lineNo = i + 1;
    if (current !== undefined && /^\s+\S/.test(line)) {
      current.text = oneLine(`${current.text} ${line}`);
      current.lineEnd = lineNo;
      continue;
    }
    const parsed = parseLine(line);
    if (parsed === undefined) {
      current = undefined;
      continue;
    }
    current = {
      lineStart: lineNo,
      lineEnd: lineNo,
      provenance: parsed.tag?.provenance ?? "agent",
      text: oneLine(parsed.text),
      ...(parsed.time === undefined ? {} : { time: parsed.time }),
      ...(parsed.tag === undefined ? {} : { tag: parsed.tag }),
    };
    entries.push(current);
  }
  return entries.filter((e) => e.text.length > 0);
}

/** Rewrites one added line so it carries a tag no more trusted than the writer. */
function normalizeAddedLine(line: string, writer: ProvenanceTag, time: string): string {
  const trimmed = line.trim();
  if (trimmed.length === 0) return "";
  if (trimmed.startsWith("#")) return trimmed;
  const parsed = parseLine(trimmed);
  if (parsed === undefined) return "";
  // A non-owner keeps only its own tag or a less trusted `untrusted:*` quote: never `system`,
  // never `owner`, never a tag above its own.
  const keep =
    parsed.tag !== undefined &&
    trustRank(parsed.tag.provenance) <= trustRank(writer.provenance) &&
    (parsed.tag.provenance === writer.provenance || parsed.tag.provenance === "untrusted");
  return formatEntry(parsed.time ?? time, keep && parsed.tag ? parsed.tag : writer, parsed.text);
}

/**
 * Applies the daily-note write rules and returns the content to store.
 * - Non-owner writers may only append: the new content must start with the old content and the
 *   appended text must start on a new line. Every appended line becomes its own entry with a
 *   tag no more trusted than the writer's (a forged `[owner]` becomes the writer's tag).
 * - The owner may edit anything; lines the owner added without a tag are tagged `owner`.
 */
export function applyDailyWrite(
  previous: string | undefined,
  next: string,
  writer: ProvenanceTag,
  time: string,
): string {
  const old = previous ?? "";
  if (writer.provenance === "owner") {
    const before = new Set(old.split("\n"));
    return next
      .split("\n")
      .map((line) => {
        if (before.has(line) || parseLine(line) === undefined) return line;
        const parsed = parseLine(line);
        return parsed?.tag === undefined ? normalizeAddedLine(line, writer, time) : line;
      })
      .join("\n");
  }
  if (!next.startsWith(old)) {
    throw new PsycheError("policy_denied", "daily notes are append-only");
  }
  let appended = next.slice(old.length);
  if (appended.length === 0) return old;
  if (old.length > 0 && !old.endsWith("\n")) {
    if (!appended.startsWith("\n")) {
      throw new PsycheError("policy_denied", "daily notes are append-only");
    }
    appended = appended.slice(1);
  }
  const lines = appended
    .split("\n")
    .map((line) => normalizeAddedLine(line, writer, time))
    .filter((line) => line.length > 0);
  if (lines.length === 0) return old;
  const base = old.length === 0 || old.endsWith("\n") ? old : `${old}\n`;
  return `${base}${lines.join("\n")}\n`;
}
