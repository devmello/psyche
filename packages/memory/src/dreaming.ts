import type { MemoryChunk, MemoryClaim, Provenance } from "@psyche/protocol";
import { oneLine } from "./daily.ts";
import { blockingKinds } from "./filters.ts";
import { guessKind } from "./importer.ts";
import { dailyNoteDate } from "./layout.ts";
import type { SqliteMemoryStore } from "./store.ts";
import { localDateTime, previousDate, sha256Hex } from "./support.ts";

/**
 * Nightly dreaming (feature H6; architecture §4.8; security §8 "One writer"). The only writer of
 * `MEMORY.md`. Deterministic, no model call:
 *
 * 1. Candidates are daily-note entries from the last `lookbackDays` with `owner` or `agent`
 *    provenance; `untrusted` and `system` entries never become candidates, and sensitive ones
 *    (credentials, cards, ids, accounts, health) are refused unless sensitive topics are on.
 * 2. Near-duplicate entries (keyword Jaccard ≥ 0.6) are grouped and scored with OpenClaw's
 *    weights: provenance 0.30, frequency across days 0.24, query diversity 0.15, recency 0.15,
 *    recall 0.10, richness 0.06. Owner facts need `minScore`; agent inferences also need to have
 *    been recalled `agentMinRecalls` times by `agentMinQueries` different queries.
 * 3. A promoted group merges into a similar sourced bullet (sources united, newest wording wins)
 *    or becomes a new bullet in the right section, `- text [YYYY-MM-DD, …]`, with a claim.
 * 4. Bullets whose claim was superseded are replaced by the successor's text; bullets whose
 *    newest source is older than `decayDays` are dropped as stale. A run never removes more than
 *    `maxLossFraction` of the sourced bullets.
 * 5. Bullets the owner wrote (no source list) are never changed. A promoted bullet the owner
 *    deleted is remembered (as a hash) and never promoted again.
 * 6. A diary entry goes to `DREAMS.md` with what happened, counting (never quoting) what was not
 *    promoted.
 */

export const DREAMING_HOUR = 3;
export const DREAMING_PROMPT_MARKER = "@psyche/memory:dreaming";
const LEDGER_KEY = "dreaming.ledger";
const SIMILAR = 0.6;

export interface DreamingOptions {
  lookbackDays?: number;
  minScore?: number;
  agentMinRecalls?: number;
  agentMinQueries?: number;
  decayDays?: number;
  maxLossFraction?: number;
  maxPromotions?: number;
  maxBulletChars?: number;
  allowSensitive?: boolean;
}

const DEFAULTS: Required<DreamingOptions> = {
  lookbackDays: 14,
  minScore: 0.5,
  agentMinRecalls: 2,
  agentMinQueries: 2,
  decayDays: 120,
  maxLossFraction: 0.25,
  maxPromotions: 20,
  maxBulletChars: 300,
  allowSensitive: false,
};

export interface DreamingReport {
  candidates: number;
  promoted: number;
  merged: number;
  superseded: number;
  dropped: number;
  notPromoted: {
    untrusted: number;
    system: number;
    sensitive: number;
    belowThreshold: number;
    deletedByOwner: number;
  };
  /** Set when removals were skipped by the loss guard. */
  guarded?: string;
}

/** True when a run is due: it is past 03:00 local and the last run was before today's 03:00. */
export function dreamingDue(
  nowMs: number,
  lastRunMs: number | undefined,
  timeZone: string,
): boolean {
  const now = localDateTime(nowMs, timeZone);
  if (Number(now.time.slice(0, 2)) < DREAMING_HOUR) return false;
  if (lastRunMs === undefined) return true;
  const last = localDateTime(lastRunMs, timeZone);
  return last.date < now.date || Number(last.time.slice(0, 2)) < DREAMING_HOUR;
}

// --- text helpers ------------------------------------------------------------------------------

const STOP = new Set(
  "the and for with that this from have has had was were are is its it's his her their them they you your our not but all any can will would should could about into onto than then when what which who whom also just very more most some such only own same too over under again once here there out off".split(
    " ",
  ),
);

export function keywords(text: string): Set<string> {
  return new Set(
    (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(
      (w) => w.length >= 3 && !STOP.has(w),
    ),
  );
}

export function similarity(a: string, b: string): number {
  const x = keywords(a);
  const y = keywords(b);
  if (x.size === 0 || y.size === 0) return 0;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared++;
  return shared / (x.size + y.size - shared);
}

/** Order-insensitive hash of a bullet's keywords (stored for owner deletions; never the text). */
export function factKey(text: string): string {
  return sha256Hex([...keywords(text)].sort().join(" ")).slice(0, 32);
}

// --- MEMORY.md model ---------------------------------------------------------------------------

const SOURCED = /^- (.*?)\s*\[(\d{4}-\d{2}-\d{2}(?:,\s*\d{4}-\d{2}-\d{2})*)\]\s*$/;

export interface MemoryBullet {
  /** 0-based line index. */
  index: number;
  text: string;
  /** Source dates, newest first; empty for bullets the owner wrote. */
  sources: string[];
}

export function parseMemoryBullets(content: string): MemoryBullet[] {
  const out: MemoryBullet[] = [];
  content.split("\n").forEach((line, index) => {
    const m = SOURCED.exec(line);
    if (m !== null) {
      const sources = (m[2] ?? "").split(/,\s*/).sort().reverse();
      out.push({ index, text: m[1] ?? "", sources });
    } else if (/^[-*] \S/.test(line)) {
      out.push({ index, text: line.slice(2).trim(), sources: [] });
    }
  });
  return out;
}

export function formatBullet(text: string, sources: readonly string[]): string {
  const dates = [...new Set(sources)].sort().reverse();
  return `- ${text} [${dates.join(", ")}]`;
}

/** The `MEMORY.md` section a fact belongs in (S20 template headings, plus `Notes`). */
export function sectionFor(text: string): string {
  const t = text.toLowerCase();
  const kind = guessKind(text);
  if (kind === "relationship") return "People";
  if (
    /\b(lives? in|moved to|home town|hometown|neighbou?rhood|apartment|office is in|based in)\b/.test(
      t,
    )
  ) {
    return "Places";
  }
  if (
    /\b(every (day|morning|evening|night|week|weekday|weekend|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|daily|weekly|usually|routine|on (mon|tues|wednes|thurs|fri|satur|sun)days)\b/.test(
      t,
    )
  ) {
    return "Routines";
  }
  if (/\b(account|bank|subscription|subscribes|provider|uses \w+ for|membership)\b/.test(t)) {
    return "Accounts and services";
  }
  if (
    /\b(project|goal|working on|building|learning|plans? to|wants to|deadline|trip|flying)\b/.test(
      t,
    )
  ) {
    return "Projects and goals";
  }
  if (kind === "directive" || /\b(decided|decision|chose|agreed|will no longer)\b/.test(t)) {
    return "Decisions";
  }
  if (kind === "preference") return "Preferences";
  return "Notes";
}

/** Inserts `line` at the end of section `heading` (created at the end of the file if missing). */
function insertInSection(lines: string[], heading: string, line: string): void {
  const at = lines.findIndex((l) => l.trim().toLowerCase() === `## ${heading.toLowerCase()}`);
  if (at === -1) {
    while (lines.length > 0 && (lines[lines.length - 1] ?? "").trim() === "") lines.pop();
    lines.push("", `## ${heading}`, "", line, "");
    return;
  }
  let end = at + 1;
  while (end < lines.length && !(lines[end] ?? "").startsWith("## ")) end++;
  // After the last bullet of the section (or right after the heading and its comments).
  let insert = at + 1;
  for (let i = at + 1; i < end; i++) {
    const l = lines[i] ?? "";
    if (/^[-*] /.test(l) || /^<!--.*-->\s*$/.test(l) || l.trim() === "") {
      if (/^[-*] /.test(l) || /^<!--.*-->\s*$/.test(l)) insert = i + 1;
    } else break;
  }
  lines.splice(insert, 0, line);
  if ((lines[insert + 1] ?? "").startsWith("## ")) lines.splice(insert + 1, 0, "");
}

// --- the run -----------------------------------------------------------------------------------

interface Ledger {
  /** factKey → date promoted. */
  promoted: Record<string, string>;
  /** factKeys the owner removed from MEMORY.md; never promoted again. */
  rejected: string[];
  /** Claim ids whose supersession was applied. */
  superseded: string[];
}

interface Group {
  texts: { text: string; date: string; line: number }[];
  chunkIds: string[];
  dates: Set<string>;
  provenance: Provenance;
}

function daysBetween(a: string, b: string): number {
  return (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000;
}

function latestText(g: Group): { text: string; date: string } {
  const sorted = [...g.texts].sort((a, b) => a.date.localeCompare(b.date) || a.line - b.line);
  return sorted[sorted.length - 1] as { text: string; date: string };
}

export async function runDreaming(
  store: SqliteMemoryStore,
  options: DreamingOptions = {},
): Promise<DreamingReport> {
  const o = { ...DEFAULTS, ...options };
  const job = store.startJob("dreaming");
  try {
    const report = await dream(store, o);
    store.finishJob(
      job,
      "ok",
      `promoted ${report.promoted}, merged ${report.merged}, superseded ${report.superseded}, dropped ${report.dropped}`,
    );
    return report;
  } catch (err) {
    store.finishJob(job, "failed", "dreaming failed");
    throw err;
  }
}

async function dream(
  store: SqliteMemoryStore,
  o: Required<DreamingOptions>,
): Promise<DreamingReport> {
  const today = store.now().date;
  const ledger: Ledger = {
    promoted: {},
    rejected: [],
    superseded: [],
    ...(store.getState<Ledger>(LEDGER_KEY) ?? {}),
  };
  const report: DreamingReport = {
    candidates: 0,
    promoted: 0,
    merged: 0,
    superseded: 0,
    dropped: 0,
    notPromoted: { untrusted: 0, system: 0, sensitive: 0, belowThreshold: 0, deletedByOwner: 0 },
  };
  const memory = (await store.readFile("MEMORY.md"))?.content ?? "# Memory\n";
  const lines = memory.split("\n");
  const before = parseMemoryBullets(memory);

  // Owner deletions: a bullet dreaming promoted that is no longer there.
  const present = new Set(before.filter((b) => b.sources.length > 0).map((b) => factKey(b.text)));
  for (const key of Object.keys(ledger.promoted)) {
    if (!present.has(key)) {
      delete ledger.promoted[key];
      if (!ledger.rejected.includes(key)) ledger.rejected.push(key);
    }
  }
  const rejected = new Set(ledger.rejected);

  // 1. Candidates.
  let since = today;
  for (let i = 0; i < o.lookbackDays; i++) since = previousDate(since);
  const groups: Group[] = [];
  const entries = store
    .allChunks()
    .map((c) => ({ c, date: dailyNoteDate(c.source) }))
    .filter((e): e is { c: MemoryChunk; date: string } => e.date !== undefined && e.date > since)
    .sort((a, b) => a.date.localeCompare(b.date) || a.c.lineStart - b.c.lineStart);
  for (const { c, date } of entries) {
    if (c.provenance === "untrusted") {
      report.notPromoted.untrusted++;
      continue;
    }
    if (c.provenance === "system") {
      report.notPromoted.system++;
      continue;
    }
    const text = oneLine(c.text);
    if (blockingKinds(text, o.allowSensitive).length > 0) {
      report.notPromoted.sensitive++;
      continue;
    }
    report.candidates++;
    const group = groups.find((g) => g.texts.some((t) => similarity(t.text, text) >= SIMILAR));
    if (group === undefined) {
      groups.push({
        texts: [{ text, date, line: c.lineStart }],
        chunkIds: [c.id],
        dates: new Set([date]),
        provenance: c.provenance,
      });
    } else {
      group.texts.push({ text, date, line: c.lineStart });
      group.chunkIds.push(c.id);
      group.dates.add(date);
      if (c.provenance === "owner") group.provenance = "owner";
    }
  }

  // 2. Score and gate.
  const recalls = store.recallStats();
  const eligible: Group[] = [];
  for (const g of groups) {
    const latest = latestText(g);
    if (rejected.has(factKey(latest.text))) {
      report.notPromoted.deletedByOwner++;
      continue;
    }
    let count = 0;
    let queries = 0;
    for (const id of g.chunkIds) {
      const r = recalls.get(id);
      count += r?.count ?? 0;
      queries += r?.queries ?? 0;
    }
    const owner = g.provenance === "owner";
    const length = latest.text.length;
    const score =
      0.3 * (owner ? 1 : 0.5) +
      0.24 * Math.min(1, g.dates.size / 3) +
      0.15 * Math.min(1, queries / 3) +
      0.15 * 0.5 ** (daysBetween(latest.date, today) / 30) +
      0.1 * Math.min(1, count / 5) +
      0.06 * (length >= 20 && length <= 240 ? 1 : 0.5);
    const gated = owner || (count >= o.agentMinRecalls && queries >= o.agentMinQueries);
    if (score < o.minScore || !gated || length > o.maxBulletChars) {
      report.notPromoted.belowThreshold++;
      continue;
    }
    eligible.push(g);
  }

  // 3. Promote or merge.
  const diary: string[] = [];
  const claims = await store.listClaims();
  for (const g of eligible.slice(0, o.maxPromotions)) {
    const latest = latestText(g);
    const bullets = parseMemoryBullets(lines.join("\n"));
    const match = bullets.find((b) => similarity(b.text, latest.text) >= SIMILAR);
    if (match !== undefined && match.sources.length === 0) continue; // the owner already wrote it
    if (match !== undefined) {
      const newest = match.sources[0] ?? "";
      const text = latest.date > newest ? latest.text : match.text;
      const sources = [...new Set([...match.sources, ...g.dates])];
      const line = formatBullet(text, sources);
      if (line !== lines[match.index]) {
        delete ledger.promoted[factKey(match.text)];
        lines[match.index] = line;
        report.merged++;
        diary.push(`- Merged: ${text} [${[...g.dates].sort().reverse().join(", ")}]`);
      }
      ledger.promoted[factKey(text)] = ledger.promoted[factKey(text)] ?? today;
      continue;
    }
    insertInSection(lines, sectionFor(latest.text), formatBullet(latest.text, [...g.dates]));
    ledger.promoted[factKey(latest.text)] = today;
    report.promoted++;
    diary.push(`- Promoted: ${latest.text} [${[...g.dates].sort().reverse().join(", ")}]`);
    if (!claims.some((c) => similarity(c.text, latest.text) >= SIMILAR)) {
      await store
        .addClaim({
          text: latest.text,
          kind: guessKind(latest.text),
          provenance: g.provenance,
          confidence: g.provenance === "owner" ? 0.9 : 0.6,
          sources: g.chunkIds,
        })
        .catch(() => undefined);
    }
  }

  // 4. Supersedes and decay (removals are guarded).
  const removals: { index: number; note: string; claimId?: string }[] = [];
  const replacements: { index: number; line: string; note: string; claimId: string }[] = [];
  const current = parseMemoryBullets(lines.join("\n")).filter((b) => b.sources.length > 0);
  const byId = new Map<string, MemoryClaim>((await store.listClaims()).map((c) => [c.id, c]));
  for (const old of byId.values()) {
    if (typeof old.supersededBy !== "string" || ledger.superseded.includes(old.id)) continue;
    const next = byId.get(old.supersededBy);
    if (next === undefined) continue;
    const bullet = current.find((b) => similarity(b.text, old.text) >= SIMILAR);
    if (bullet === undefined) {
      ledger.superseded.push(old.id);
      continue;
    }
    const already = current.some((b) => b !== bullet && similarity(b.text, next.text) >= SIMILAR);
    const note = `- Superseded: ${bullet.text} → ${next.text}`;
    if (already) removals.push({ index: bullet.index, note, claimId: old.id });
    else {
      replacements.push({
        index: bullet.index,
        line: formatBullet(next.text, [...bullet.sources, today]),
        note,
        claimId: old.id,
      });
    }
  }
  for (const b of current) {
    const newest = b.sources[0];
    if (newest === undefined || ledger.promoted[factKey(b.text)] === undefined) continue;
    if (daysBetween(newest, today) > o.decayDays && !removals.some((r) => r.index === b.index)) {
      removals.push({ index: b.index, note: `- Dropped as stale: ${b.text}` });
    }
  }
  for (const r of replacements) {
    const text = SOURCED.exec(r.line)?.[1] ?? "";
    delete ledger.promoted[factKey(SOURCED.exec(lines[r.index] ?? "")?.[1] ?? "")];
    lines[r.index] = r.line;
    ledger.promoted[factKey(text)] = today;
    ledger.superseded.push(r.claimId);
    report.superseded++;
    diary.push(r.note);
  }
  const prior = before.filter((b) => b.sources.length > 0).length;
  if (removals.length > 0 && prior > 0 && removals.length / prior > o.maxLossFraction) {
    report.guarded = `skipped removing ${removals.length} of ${prior} bullets (limit ${Math.round(o.maxLossFraction * 100)}%)`;
  } else {
    for (const r of [...removals].sort((a, b) => b.index - a.index)) {
      const text = parseMemoryBullets(lines[r.index] ?? "")[0]?.text ?? "";
      delete ledger.promoted[factKey(text)];
      lines.splice(r.index, 1);
      if (r.claimId === undefined) report.dropped++;
      else {
        report.superseded++;
        ledger.superseded.push(r.claimId);
      }
      diary.push(r.note);
    }
  }

  // 5. Write.
  const next = lines.join("\n");
  if (next !== memory) {
    await store.write("MEMORY.md", next, {
      provenance: "agent",
      actor: "job",
      source: "job",
      link: { tool: "dreaming" },
    });
  }
  const n = report.notPromoted;
  const skipped = [
    n.untrusted > 0 ? `${n.untrusted} untrusted` : "",
    n.system > 0 ? `${n.system} system` : "",
    n.sensitive > 0 ? `${n.sensitive} sensitive` : "",
    n.belowThreshold > 0 ? `${n.belowThreshold} below the promotion threshold` : "",
    n.deletedByOwner > 0 ? `${n.deletedByOwner} you deleted before` : "",
  ].filter(Boolean);
  const entry = [
    `## ${today}`,
    "",
    ...(diary.length > 0 ? diary : ["- Nothing new to promote."]),
    ...(skipped.length > 0 ? [`- Not promoted: ${skipped.join(", ")}.`] : []),
    ...(report.guarded === undefined ? [] : [`- Held back: ${report.guarded}.`]),
  ].join("\n");
  const dreams = (await store.readFile("DREAMS.md"))?.content ?? "# Dreams\n";
  await store.write("DREAMS.md", `${dreams.trimEnd()}\n\n${entry}\n`, {
    provenance: "system",
    actor: "job",
    source: "job",
    link: { tool: "dreaming" },
  });
  store.setState(LEDGER_KEY, ledger);
  return report;
}
