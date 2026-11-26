import { type ForgetCounts, type ForgetMatcher, mentions } from "../forget-cascade.ts";
import { isSkillFile } from "../layout.ts";
import type { SqliteMemoryStore } from "../store.ts";
import { parseLessonLines } from "./lines.ts";
import type { TeachingService } from "./service.ts";
import type { TeachingStore } from "./store.ts";

/**
 * Forget a phrase in what the teaching loop kept (memory wave 3A; owner decision 2026-11-25:
 * forget also reaches lessons):
 *
 * - Lessons whose statement, value, previous value or scope names it are forgotten the way the
 *   owner forgets one (`TeachingService.forget`: the line goes, what it replaced comes back, a
 *   tombstone keeps only the id, kind and a hash), and the feedback they came from is deleted.
 * - Feedback events whose text, reason, scope, detail or target names it are deleted.
 * - Lesson lines (`- date [ls_... scope] text`) in AGENTS.md and a skill's LESSONS.md that name
 *   it are removed. Only tagged lesson lines: the owner's own instructions in AGENTS.md, and the
 *   persona files, are never edited.
 */

type Part = Pick<ForgetCounts, "lessons" | "lessonLines" | "feedback">;

export interface LessonForgetDeps {
  store: TeachingStore;
  service: Pick<TeachingService, "forget">;
  memory: SqliteMemoryStore;
}

const JOB = { provenance: "owner", actor: "job", source: "job" } as const;

/** AGENTS.md and the skills' LESSONS.md: the files that hold lesson lines `forget` never walks. */
async function lessonFiles(memory: SqliteMemoryStore): Promise<string[]> {
  const files = await memory.listFiles();
  return files.filter((p) => p === "AGENTS.md" || (isSkillFile(p) && /(^|\/)LESSONS\.md$/.test(p)));
}

async function matchingLines(
  memory: SqliteMemoryStore,
  m: ForgetMatcher,
): Promise<{ path: string; content: string; indexes: number[] }[]> {
  const out: { path: string; content: string; indexes: number[] }[] = [];
  for (const path of await lessonFiles(memory)) {
    const content = (await memory.readFile(path))?.content;
    if (content === undefined) continue;
    const indexes = parseLessonLines(content)
      .filter((l) => mentions(m, l.text))
      .map((l) => l.index);
    if (indexes.length > 0) out.push({ path, content, indexes });
  }
  return out;
}

function selection(store: TeachingStore, m: ForgetMatcher) {
  const lessons = store
    .allLessons()
    .filter(
      (l) =>
        l.status !== "forgotten" &&
        [
          l.statement,
          l.value,
          l.previous,
          JSON.stringify(l.scope),
          JSON.stringify(l.destination),
        ].some((t) => mentions(m, t)),
    );
  const events = store
    .allEvents()
    .filter((e) =>
      [e.text, e.reason, e.scope, JSON.stringify(e.detail ?? null), JSON.stringify(e.target)].some(
        (t) => mentions(m, t),
      ),
    );
  const eventIds = new Set(events.map((e) => e.id));
  for (const l of lessons)
    for (const id of l.sources) if (store.getEvent(id) !== undefined) eventIds.add(id);
  return { lessons, eventIds };
}

export async function previewLessonForget(deps: LessonForgetDeps, m: ForgetMatcher): Promise<Part> {
  const { lessons, eventIds } = selection(deps.store, m);
  const lines = await matchingLines(deps.memory, m);
  return {
    lessons: lessons.length,
    lessonLines: lines.reduce((n, f) => n + f.indexes.length, 0),
    feedback: eventIds.size,
  };
}

export async function applyLessonForget(deps: LessonForgetDeps, m: ForgetMatcher): Promise<Part> {
  const counts = await previewLessonForget(deps, m);
  const { lessons, eventIds } = selection(deps.store, m);
  let firstError: unknown;
  // Newest first, so each forget restores the line its predecessor had (as "forget all" does).
  for (const l of [...lessons].reverse()) {
    try {
      await deps.service.forget(l.id, { purgeSources: true });
      deps.store.scrubTombstone(l.id, { destination: mentions(m, JSON.stringify(l.destination)) });
    } catch (err) {
      firstError ??= err;
    }
  }
  for (const id of eventIds) deps.store.deleteEvent(id);
  // Lines the lessons above did not own (derived lines, a lesson with no row left).
  for (const f of await matchingLines(deps.memory, m)) {
    const drop = new Set(f.indexes);
    const next = f.content
      .split("\n")
      .filter((_, i) => !drop.has(i))
      .join("\n");
    try {
      await deps.memory.write(f.path, next, { ...JOB, link: { tool: "forget" } });
    } catch (err) {
      firstError ??= err;
    }
  }
  if (firstError !== undefined) throw firstError;
  return counts;
}
