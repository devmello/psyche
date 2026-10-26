import type { Clock, LessonDestination, LessonScope } from "@psyche/protocol";
import { factKey, similarity } from "../dreaming.ts";
import type { SqliteMemoryStore } from "../store.ts";
import { removeLessonLine } from "./lines.ts";
import { SECTION } from "./router.ts";
import type { TeachingService } from "./service.ts";
import { LIVE_STATUSES, type StoredLesson, scopeKey } from "./store.ts";

/**
 * Dreaming's lesson pass (docs/agent/teaching-loop-2026.md §6), after the MEMORY.md run:
 *
 * 1. **Merge** near-duplicate live lessons on the same destination and scope (keyword Jaccard
 *    ≥ 0.6) into the newest one: sources united, `refinedCount` summed, the older lines removed
 *    and the older lessons `superseded`. Only lesson-owned lines move (never USER.md's Learned or
 *    Directives lines, which have their own writers, and never the owner's text).
 * 2. **Propose** a style taught for three or more recipients as a global "How I write for you"
 *    lesson, through the teaching service's card. Never written silently; proposed once.
 * 3. **Flag** a live lesson that a later lesson on the same file section contradicts or narrows
 *    (same topic, overlapping scope, not a supersede), for the weekly card.
 * 4. **Promote** lessons the owner confirmed and that then held through a use into MEMORY.md's
 *    Preferences as `- <statement> [lesson:<id>]`. Forgetting the lesson removes the bullet (the
 *    writer's `removeDerived`); a bullet the owner deleted is never promoted again.
 * 5. **DREAMS.md** gets one "Lessons" line with counts and destinations, never the text.
 */

const SIMILAR = 0.6;
const TOPIC = 0.3;
const GLOBAL_STYLE_RECIPIENTS = 3;
const PROMOTE_KINDS = new Set(["style", "fact", "approach"]);
const LEDGER_KEY = "dreaming.lessons";
const JOB = { provenance: "owner", actor: "job", source: "job" } as const;

export interface LessonFlag {
  lessonId: string;
  /** The later lesson that contradicts or narrows it. */
  byLessonId: string;
  at: string;
}

export interface LessonConsolidationReport {
  merged: number;
  proposed: number;
  flagged: number;
  promoted: number;
  /** Lines touched per destination (`SOUL.md`, `skills`, `MEMORY.md`, …). */
  destinations: Record<string, number>;
}

interface Ledger {
  /** Lesson ids with a MEMORY.md bullet. */
  promoted: string[];
  /** Lesson ids whose bullet the owner deleted: never promoted again. */
  rejected: string[];
  /** factKeys of global styles already proposed. */
  proposed: string[];
  /** Open flags for the weekly card. */
  flags: LessonFlag[];
}

/** The open flags dreaming left for the weekly card (§5.4 "conflicts dreaming found"). */
export function lessonFlags(memory: SqliteMemoryStore): LessonFlag[] {
  return memory.getState<Ledger>(LEDGER_KEY)?.flags ?? [];
}

/** The file (and section) a lesson's line lives in, when it is a lesson-owned line. */
function lineHome(d: LessonDestination): { path: string; section: string } | undefined {
  if (d.type === "skill") return { path: d.path, section: "" };
  if (d.type !== "file") return undefined;
  if (d.section === SECTION.userLearned || d.section === SECTION.userDirectives) return undefined;
  return { path: d.path, section: d.section };
}

const homeKey = (l: StoredLesson) => {
  const h = lineHome(l.destination);
  return h === undefined ? undefined : `${h.path}#${h.section}#${scopeKey(l.scope)}`;
};

const overlaps = (a: LessonScope, b: LessonScope) => {
  const x = scopeKey(a);
  const y = scopeKey(b);
  return x === y || x === "global" || y === "global";
};

const bucket = (l: StoredLesson) =>
  l.destination.type === "skill"
    ? "skills"
    : l.destination.type === "file"
      ? l.destination.path
      : l.destination.type;

export async function consolidateLessons(
  service: TeachingService,
  memory: SqliteMemoryStore,
  options: { clock?: Clock } = {},
): Promise<LessonConsolidationReport> {
  const store = service.store;
  const now = new Date((options.clock ?? { now: () => Date.now() }).now()).toISOString();
  const ledger: Ledger = {
    promoted: [],
    rejected: [],
    proposed: [],
    flags: [],
    ...(memory.getState<Ledger>(LEDGER_KEY) ?? {}),
  };
  const report: LessonConsolidationReport = {
    merged: 0,
    proposed: 0,
    flagged: 0,
    promoted: 0,
    destinations: {},
  };
  const touch = (key: string) => {
    report.destinations[key] = (report.destinations[key] ?? 0) + 1;
  };
  const live = () => store.listLessons({ status: LIVE_STATUSES, limit: 500 }).lessons;

  // 1. Merge near-duplicates into the newest lesson of each group.
  const files = new Map<string, string>();
  const read = async (path: string) => {
    const cached = files.get(path);
    if (cached !== undefined) return cached;
    const content = (await memory.readFile(path))?.content ?? "";
    files.set(path, content);
    return content;
  };
  const byHome = new Map<string, StoredLesson[]>();
  for (const l of live()) {
    const key = homeKey(l);
    if (key === undefined) continue;
    byHome.set(key, [...(byHome.get(key) ?? []), l]);
  }
  for (const group of byHome.values()) {
    const newestFirst = [...group].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const absorbed = new Set<string>();
    for (const survivor of newestFirst) {
      if (absorbed.has(survivor.id)) continue;
      const dups = newestFirst.filter(
        (o) =>
          o.id !== survivor.id &&
          !absorbed.has(o.id) &&
          o.createdAt <= survivor.createdAt &&
          similarity(o.statement, survivor.statement) >= SIMILAR,
      );
      if (dups.length === 0) continue;
      for (const d of dups) {
        absorbed.add(d.id);
        const home = lineHome(d.destination);
        if (home !== undefined) {
          const next = removeLessonLine(await read(home.path), d.id);
          if (next !== undefined) files.set(home.path, next);
        }
        store.updateLesson(d.id, { status: "superseded" });
        report.merged++;
        touch(bucket(d));
      }
      store.updateLesson(survivor.id, {
        sources: [...new Set([...dups.flatMap((d) => d.sources), ...survivor.sources])].slice(-50),
        refinedCount: survivor.refinedCount + dups.reduce((n, d) => n + d.refinedCount + 1, 0),
      });
    }
  }
  for (const [path, content] of files) {
    const before = (await memory.readFile(path))?.content ?? "";
    if (content !== before) await memory.write(path, content, JOB);
  }

  // 2. Propose a style taught for several recipients as a global one.
  const lessons = live();
  const scoped = lessons.filter((l) => l.kind === "style" && typeof l.scope.recipient === "string");
  const globalStyles = [
    ...lessons,
    ...store.listLessons({ status: ["proposed"], limit: 200 }).lessons,
  ].filter((l) => l.kind === "style" && l.scope.global === true);
  const seen = new Set<string>();
  for (const l of scoped) {
    if (seen.has(l.id)) continue;
    const alike = scoped.filter((o) => similarity(o.statement, l.statement) >= SIMILAR);
    for (const o of alike) seen.add(o.id);
    const recipients = new Set(alike.map((o) => o.scope.recipient));
    if (recipients.size < GLOBAL_STYLE_RECIPIENTS) continue;
    const key = factKey(l.statement);
    if (ledger.proposed.includes(key)) continue;
    if (globalStyles.some((g) => similarity(g.statement, l.statement) >= SIMILAR)) continue;
    const newest = [...alike].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? l;
    const proposed = await service
      .proposeInferred(
        {
          kind: "style",
          statement: newest.statement,
          value: newest.value,
          scope: { global: true },
          destination: { type: "file", path: "SOUL.md", section: SECTION.soulStyle },
        },
        alike,
        `You taught this for ${recipients.size} people`,
      )
      .catch(() => undefined);
    ledger.proposed.push(key);
    if (proposed !== undefined) {
      report.proposed++;
      touch("SOUL.md");
    }
  }

  // 3. Flag lessons a later lesson on the same section contradicts or narrows.
  const open = new Map(ledger.flags.map((f) => [f.lessonId, f]));
  const current = live();
  for (const l of current) {
    const home = lineHome(l.destination);
    if (home === undefined || open.has(l.id)) continue;
    const later = current.find((m) => {
      const h = lineHome(m.destination);
      return (
        m.id !== l.id &&
        m.supersedes !== l.id &&
        h?.path === home.path &&
        h.section === home.section &&
        m.createdAt > (l.lastConfirmedAt ?? l.createdAt) &&
        overlaps(m.scope, l.scope) &&
        similarity(m.statement, l.statement) >= TOPIC &&
        similarity(m.statement, l.statement) < SIMILAR
      );
    });
    if (later === undefined) continue;
    open.set(l.id, { lessonId: l.id, byLessonId: later.id, at: now });
    report.flagged++;
  }
  // A flag goes once either lesson is no longer live.
  const liveIds = new Set(current.map((l) => l.id));
  ledger.flags = [...open.values()].filter(
    (f) => liveIds.has(f.lessonId) && liveIds.has(f.byLessonId),
  );

  // 4. Promote lessons the owner confirmed and that then held through a use.
  let memoryMd = (await memory.readFile("MEMORY.md"))?.content ?? "# Memory\n";
  for (const id of ledger.promoted) {
    if (!memoryMd.includes(`lesson:${id}`)) {
      ledger.promoted = ledger.promoted.filter((x) => x !== id);
      // Forgotten lessons lost their bullet through the writer; only the owner's deletions count.
      const lesson = store.getLesson(id);
      if (lesson !== undefined && lesson.status !== "forgotten" && !ledger.rejected.includes(id))
        ledger.rejected.push(id);
    }
  }
  const promotable = current.filter(
    (l) =>
      l.status === "confirmed" &&
      PROMOTE_KINDS.has(l.kind) &&
      l.confirmedAt != null &&
      l.lastAppliedAt != null &&
      l.lastAppliedAt > l.confirmedAt &&
      !ledger.promoted.includes(l.id) &&
      !ledger.rejected.includes(l.id) &&
      !memoryMd.includes(`lesson:${l.id}`),
  );
  for (const l of promotable) {
    memoryMd = insertPreference(
      memoryMd,
      `- ${l.statement.replace(/\s+/g, " ").trim()} [lesson:${l.id}]`,
    );
    ledger.promoted.push(l.id);
    report.promoted++;
    touch("MEMORY.md");
  }
  if (promotable.length > 0) {
    await memory.write("MEMORY.md", memoryMd, { provenance: "agent", actor: "job", source: "job" });
  }

  // 5. One diary line, counts only.
  const dests = Object.entries(report.destinations)
    .map(([k, n]) => `${k} ${n}`)
    .join(", ");
  const line =
    report.merged + report.proposed + report.flagged + report.promoted === 0
      ? "- Lessons: nothing to consolidate."
      : `- Lessons: ${report.merged} merged, ${report.promoted} promoted to MEMORY.md, ${report.proposed} proposed for everyone, ${report.flagged} flagged for review${dests === "" ? "" : ` (${dests})`}.`;
  const dreams = (await memory.readFile("DREAMS.md"))?.content ?? "# Dreams\n";
  await memory.write("DREAMS.md", `${dreams.trimEnd()}\n${line}\n`, {
    provenance: "system",
    actor: "job",
    source: "job",
  });
  memory.setState(LEDGER_KEY, ledger);
  return report;
}

/** Appends a bullet to MEMORY.md's `## Preferences` (created at the end when missing). */
function insertPreference(content: string, line: string): string {
  const lines = content.split("\n");
  const at = lines.findIndex((l) => l.trim().toLowerCase() === "## preferences");
  if (at === -1) return `${content.trimEnd()}\n\n## Preferences\n\n${line}\n`;
  let end = at + 1;
  while (end < lines.length && !(lines[end] ?? "").startsWith("## ")) end++;
  while (end > at + 1 && (lines[end - 1] ?? "").trim() === "") end--;
  lines.splice(end, 0, line);
  return lines.join("\n");
}
