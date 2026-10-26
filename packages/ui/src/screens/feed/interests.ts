/**
 * The interest ledger as the Feed instructions editor shows it: `interests.md` in the workspace,
 * one topic per line with a weight and a reason, `!exclude:` topics and `!hide-source:` hosts
 * (packages/proactive/src/feed/ledger.ts owns the format). Lines this module doesn't understand
 * (the header comment, blank lines, prose) are kept verbatim and in place, so an owner's notes and
 * the generator's own lines survive a save.
 */

export const INTERESTS_PATH = "interests.md";
/** Free-text guidance the briefing reads ahead of the ledger (agreed with S15 in #614). */
export const FEED_INSTRUCTIONS_PATH = "feed/INSTRUCTIONS.md";

export type InterestRow =
  | { kind: "topic"; topic: string; weight: number; why: string }
  | { kind: "exclude"; topic: string; why: string }
  | { kind: "hide_source"; host: string; why: string };

export interface InterestLedger {
  /** File lines; a row's line is its index into `rows`. */
  lines: (string | { row: number })[];
  rows: InterestRow[];
}

const TOPIC_LINE = /^- (?!!)(.+?) \((\d(?:\.\d+)?)\)(?: [—–-]+ (.*))?$/;
const EXCLUDE_LINE = /^- !exclude: (.+?)(?: [—–-]+ (.*))?$/;
const HIDE_LINE = /^- !hide-source: (.+?)(?: [—–-]+ (.*))?$/;

function parseRow(line: string): InterestRow | undefined {
  let m = EXCLUDE_LINE.exec(line);
  if (m !== null) return { kind: "exclude", topic: (m[1] ?? "").trim(), why: (m[2] ?? "").trim() };
  m = HIDE_LINE.exec(line);
  if (m !== null)
    return {
      kind: "hide_source",
      host: (m[1] ?? "").trim().toLowerCase(),
      why: (m[2] ?? "").trim(),
    };
  m = TOPIC_LINE.exec(line);
  if (m !== null) {
    const weight = Number(m[2]);
    if (!Number.isFinite(weight) || weight < 0 || weight > 1) return undefined;
    return { kind: "topic", topic: (m[1] ?? "").trim(), weight, why: (m[3] ?? "").trim() };
  }
  return undefined;
}

export function parseInterests(text: string): InterestLedger {
  const lines: InterestLedger["lines"] = [];
  const rows: InterestRow[] = [];
  let inComment = false;
  const all = text.split("\n");
  // A trailing newline is not an extra blank line.
  if (all.at(-1) === "") all.pop();
  for (const raw of all) {
    const line = raw.trimEnd();
    if (line.includes("<!--")) inComment = true;
    const row = inComment ? undefined : parseRow(line);
    if (line.includes("-->")) inComment = false;
    if (row === undefined) lines.push(line);
    else {
      lines.push({ row: rows.length });
      rows.push(row);
    }
  }
  return { lines, rows };
}

export function formatRow(r: InterestRow): string {
  const why = r.why === "" ? "" : ` — ${r.why}`;
  if (r.kind === "topic") return `- ${r.topic} (${r.weight.toFixed(2)})${why}`;
  if (r.kind === "exclude") return `- !exclude: ${r.topic}${why}`;
  return `- !hide-source: ${r.host}${why}`;
}

/** True when a row has something to write (an empty topic or host is dropped on save). */
function filled(r: InterestRow): boolean {
  return (r.kind === "hide_source" ? r.host : r.topic).trim() !== "";
}

/**
 * Writes the ledger back with `rows` in place of the parsed ones: kept rows stay on their line,
 * removed rows disappear, new rows go at the end after a blank line. Other lines are untouched.
 */
export function serializeInterests(
  ledger: InterestLedger,
  rows: readonly (InterestRow & { origin?: number })[],
): string {
  const byOrigin = new Map<number, InterestRow>();
  for (const r of rows) if (r.origin !== undefined) byOrigin.set(r.origin, r);
  const out: string[] = [];
  for (const line of ledger.lines) {
    if (typeof line === "string") {
      out.push(line);
      continue;
    }
    const r = byOrigin.get(line.row);
    if (r !== undefined && filled(r)) out.push(formatRow(r));
  }
  const added = rows.filter((r) => r.origin === undefined && filled(r));
  if (added.length > 0) {
    if (out.length > 0 && out[out.length - 1] !== "") out.push("");
    for (const r of added) out.push(formatRow(r));
  }
  return `${out.join("\n")}\n`;
}
