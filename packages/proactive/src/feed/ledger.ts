/**
 * The interest ledger: `workspace/interests.md` (data model §7.1; architecture §4.11). One topic
 * per line with a weight and a reason; `!exclude:` topics; `!hide-source:` hosts. The owner can
 * edit any line and their edits win: the file is re-read before every change and written back
 * with its etag. Lines this module does not understand (the header comment, blank lines, prose)
 * are kept verbatim, in place.
 *
 * Feedback rules (UI §3.9 "written to the interest ledger at once with an undo toast"):
 *
 * | feedback         | effect on the post's topics                               | undo (`null`)      |
 * | ---------------- | --------------------------------------------------------- | ------------------ |
 * | `like`           | +0.10 each (cap 1.0)                                      | −0.10              |
 * | `save`           | +0.15 each (cap 1.0)                                      | −0.15              |
 * | `not_interested` | −0.20 each (floor 0.05); a topic at the floor 3× is excluded | +0.20           |
 * | `hide_source`    | adds `!hide-source: <host>` for every citation host       | removes the lines  |
 * | `follow_topic`   | adds `<topic> (0.60)`; +0.20 when it already exists        | removes / −0.20    |
 *
 * A post without matched topics gets its title's key phrase as a new topic on `like` / `save`
 * (0.40 / 0.50), so the ledger can grow from the Feed alone. Every change is one audit line.
 */

export interface LedgerTopic {
  kind: "topic";
  topic: string;
  weight: number;
  why: string;
}
export interface LedgerExclude {
  kind: "exclude";
  topic: string;
  why: string;
}
export interface LedgerHiddenSource {
  kind: "hide_source";
  host: string;
  why: string;
}
export type LedgerEntry = (LedgerTopic | LedgerExclude | LedgerHiddenSource) & {
  /** Set by a feedback rule; the line disappears on serialize. */
  removed?: true;
};

/** A parsed ledger: entries in file order plus the lines around them. */
export interface Ledger {
  /** File lines; an entry line is replaced by its index into `entries`. */
  lines: (string | { entry: number })[];
  entries: LedgerEntry[];
}

const TOPIC_LINE = /^- (?!!)(.+?) \((\d(?:\.\d+)?)\)(?: [—–-]+ (.*))?$/;
const EXCLUDE_LINE = /^- !exclude: (.+?)(?: [—–-]+ (.*))?$/;
const HIDE_LINE = /^- !hide-source: (.+?)(?: [—–-]+ (.*))?$/;

export const WEIGHT_FLOOR = 0.05;
export const WEIGHT_CAP = 1;
export const NOT_INTERESTED_EXCLUDE_AFTER = 3;

export function parseLedger(text: string): Ledger {
  const lines: Ledger["lines"] = [];
  const entries: LedgerEntry[] = [];
  let inComment = false;
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    // Lines inside the template's HTML comment are examples, not entries.
    if (line.includes("<!--")) inComment = true;
    const entry = inComment ? undefined : parseEntry(line);
    if (line.includes("-->")) inComment = false;
    if (entry === undefined) {
      lines.push(line);
      continue;
    }
    lines.push({ entry: entries.length });
    entries.push(entry);
  }
  return { lines, entries };
}

function parseEntry(line: string): LedgerEntry | undefined {
  let m = EXCLUDE_LINE.exec(line);
  if (m !== null) return { kind: "exclude", topic: clean(m[1]), why: clean(m[2]) };
  m = HIDE_LINE.exec(line);
  if (m !== null) return { kind: "hide_source", host: clean(m[1]).toLowerCase(), why: clean(m[2]) };
  m = TOPIC_LINE.exec(line);
  if (m !== null) {
    const weight = Number(m[2]);
    if (!Number.isFinite(weight) || weight < 0 || weight > 1) return undefined;
    return { kind: "topic", topic: clean(m[1]), weight, why: clean(m[2 + 1]) };
  }
  return undefined;
}

function clean(s: string | undefined): string {
  return (s ?? "").trim();
}

export function formatEntry(e: LedgerEntry): string {
  const why = e.why === "" ? "" : ` — ${e.why}`;
  if (e.kind === "topic") return `- ${e.topic} (${e.weight.toFixed(2)})${why}`;
  if (e.kind === "exclude") return `- !exclude: ${e.topic}${why}`;
  return `- !hide-source: ${e.host}${why}`;
}

export function serializeLedger(ledger: Ledger): string {
  const seen = new Set<number>();
  const out: string[] = [];
  for (const line of ledger.lines) {
    if (typeof line === "string") {
      out.push(line);
      continue;
    }
    const e = ledger.entries[line.entry];
    if (e === undefined || e.removed === true) continue;
    seen.add(line.entry);
    out.push(formatEntry(e));
  }
  // Entries added since the parse go at the end (after a trailing blank line, if the file has none).
  const appended = ledger.entries
    .map((e, i) => (seen.has(i) || e.removed === true ? null : e))
    .filter((e): e is LedgerEntry => e !== null);
  if (appended.length > 0) {
    if (out.length > 0 && out[out.length - 1] !== "") out.push("");
    for (const e of appended) out.push(formatEntry(e));
  }
  let text = out.join("\n");
  if (!text.endsWith("\n")) text += "\n";
  return text;
}

function live(ledger: Ledger): LedgerEntry[] {
  return ledger.entries.filter((e) => e.removed !== true);
}
export function topics(ledger: Ledger): LedgerTopic[] {
  return live(ledger).filter((e): e is LedgerTopic => e.kind === "topic");
}
export function exclusions(ledger: Ledger): string[] {
  return live(ledger)
    .filter((e): e is LedgerExclude => e.kind === "exclude")
    .map((e) => e.topic);
}
export function hiddenHosts(ledger: Ledger): string[] {
  return live(ledger)
    .filter((e): e is LedgerHiddenSource => e.kind === "hide_source")
    .map((e) => e.host);
}

export function normalizeTopic(topic: string): string {
  return topic
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function findTopic(ledger: Ledger, topic: string): LedgerTopic | undefined {
  const key = normalizeTopic(topic);
  return topics(ledger).find((t) => normalizeTopic(t.topic) === key);
}

function clamp(w: number): number {
  return Math.min(WEIGHT_CAP, Math.max(WEIGHT_FLOOR, Math.round(w * 100) / 100));
}

/** Removes an entry (its line disappears on serialize). */
function removeEntry(_ledger: Ledger, entry: LedgerEntry): void {
  entry.removed = true;
}

export type FeedbackKind = "like" | "save" | "not_interested" | "hide_source" | "follow_topic";

export interface FeedbackContext {
  /** Topics the post matched (from its `reasons`), in ledger spelling. */
  topics: string[];
  /** Hosts of the post's citations (`hide_source`). */
  hosts: string[];
  /** The post's title, for a new topic when nothing matched. */
  title: string;
  /** `follow_topic`: the topic to follow (default: the first matched topic, else the title). */
  topic?: string;
  /** Short attribution kept in the "why", e.g. `post 01J…` (also how undo finds its lines). */
  ref: string;
  /** `YYYY-MM-DD` for the "why". */
  date: string;
}

const DELTA: Record<Exclude<FeedbackKind, "hide_source" | "follow_topic">, number> = {
  like: 0.1,
  save: 0.15,
  not_interested: -0.2,
};

/** Applies one feedback (or its undo) in place; returns the lines it changed, formatted. */
export function applyFeedback(
  ledger: Ledger,
  feedback: FeedbackKind,
  ctx: FeedbackContext,
  options: { undo?: boolean } = {},
): string[] {
  const undo = options.undo === true;
  const changed: string[] = [];
  const note = (what: string) => `${what} ${ctx.date} (${ctx.ref})`;

  if (feedback === "hide_source") {
    for (const host of new Set(ctx.hosts.map((h) => h.toLowerCase()))) {
      const existing = live(ledger).find(
        (e): e is LedgerHiddenSource => e.kind === "hide_source" && e.host === host,
      );
      if (undo) {
        if (existing?.why.includes(ctx.ref)) {
          removeEntry(ledger, existing);
          changed.push(`removed: ${formatEntry(existing)}`);
        }
      } else if (existing === undefined) {
        const e: LedgerHiddenSource = { kind: "hide_source", host, why: note("hidden") };
        ledger.entries.push(e);
        changed.push(formatEntry(e));
      }
    }
    return changed;
  }

  if (feedback === "follow_topic") {
    const topic = (ctx.topic ?? ctx.topics[0] ?? keyPhrase(ctx.title)).trim();
    if (topic === "") return changed;
    const existing = findTopic(ledger, topic);
    if (undo) {
      if (existing === undefined) return changed;
      const followNote = note("followed");
      if (existing.why === followNote) {
        // This feedback created the line: remove it again.
        removeEntry(ledger, existing);
        changed.push(`removed: ${formatEntry(existing)}`);
      } else {
        existing.weight = clamp(existing.weight - 0.2);
        existing.why = dropLastNote(existing.why, followNote);
        changed.push(formatEntry(existing));
      }
      return changed;
    }
    // Following un-excludes.
    const excluded = live(ledger).find(
      (e): e is LedgerExclude =>
        e.kind === "exclude" && normalizeTopic(e.topic) === normalizeTopic(topic),
    );
    if (excluded !== undefined) {
      removeEntry(ledger, excluded);
      changed.push(`removed: ${formatEntry(excluded)}`);
    }
    if (existing === undefined) {
      const e: LedgerTopic = { kind: "topic", topic, weight: 0.6, why: note("followed") };
      ledger.entries.push(e);
      changed.push(formatEntry(e));
    } else {
      existing.weight = clamp(existing.weight + 0.2);
      existing.why = appendWhy(existing.why, note("followed"));
      changed.push(formatEntry(existing));
    }
    return changed;
  }

  const delta = (undo ? -1 : 1) * DELTA[feedback];
  const matched = ctx.topics
    .map((t) => findTopic(ledger, t))
    .filter((t): t is LedgerTopic => t !== undefined);
  if (matched.length === 0 && !undo && feedback !== "not_interested") {
    const topic = keyPhrase(ctx.title);
    if (topic !== "") {
      const e: LedgerTopic = {
        kind: "topic",
        topic,
        weight: feedback === "save" ? 0.5 : 0.4,
        why: note(`${feedback}d a post`),
      };
      ledger.entries.push(e);
      changed.push(formatEntry(e));
    }
    return changed;
  }
  if (matched.length === 0 && undo) {
    // The like / save created the topic: remove it again.
    const created = findTopic(ledger, keyPhrase(ctx.title));
    if (created?.why.includes(ctx.ref)) {
      removeEntry(ledger, created);
      changed.push(`removed: ${formatEntry(created)}`);
    }
    return changed;
  }
  for (const t of matched) {
    t.weight = clamp(t.weight + delta);
    const tag = undo ? `undid ${feedback}` : feedback.replace("_", " ");
    t.why = appendWhy(t.why, note(tag));
    if (!undo && feedback === "not_interested" && t.weight <= WEIGHT_FLOOR) {
      const strikes = (t.why.match(/not interested/g) ?? []).length;
      if (strikes >= NOT_INTERESTED_EXCLUDE_AFTER) {
        removeEntry(ledger, t);
        const e: LedgerExclude = {
          kind: "exclude",
          topic: t.topic,
          why: `not interested ${strikes}× (last ${ctx.ref})`,
        };
        ledger.entries.push(e);
        changed.push(`removed: ${formatEntry(t)}`, formatEntry(e));
        continue;
      }
    }
    changed.push(formatEntry(t));
  }
  return changed;
}

function dropLastNote(why: string, note: string): string {
  const parts = why.split("; ");
  const i = parts.lastIndexOf(note);
  if (i >= 0) parts.splice(i, 1);
  return parts.join("; ");
}

/** Keeps the "why" short: the last few notes only. */
function appendWhy(why: string, note: string): string {
  const parts = why === "" ? [] : why.split("; ");
  parts.push(note);
  return parts.slice(-4).join("; ");
}

const STOP = new Set(
  "a an the and or of to in on for with from by at as is are was were be been this that these those it its into over under about after before your my our their how why what when new".split(
    " ",
  ),
);

/** The title's key phrase: up to four content words, lowercase. */
export function keyPhrase(title: string): string {
  const words = title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]+/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w));
  return words.slice(0, 4).join(" ");
}
