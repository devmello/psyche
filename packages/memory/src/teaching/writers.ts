import type { LessonDestination, LessonKind, LessonScope, Scheduler } from "@psyche/protocol";
import type { GraphStore } from "../graph/store.ts";
import { MULTI_VALUED } from "../graph/store.ts";
import { BUDGETS } from "../layout.ts";
import { formatLearned, learnedLine, removeLearned } from "../learned.ts";
import { addDirective } from "../persona.ts";
import type { SqliteMemoryStore } from "../store.ts";
import {
  findLessonLine,
  formatLessonLine,
  lessonLineText,
  removeLessonLine,
  upsertLessonLine,
} from "./lines.ts";
import type { PlannedDestination } from "./router.ts";
import { SECTION } from "./router.ts";
import type { StoredLesson } from "./store.ts";

/**
 * Writers (docs/agent/teaching-loop-2026.md §4): one per destination, each writing only inside
 * the region a lesson owns, through the existing write paths: USER.md facts via
 * `learnUserFacts`, directives via `addDirective` plus a standing `ask` rule, the people graph
 * with `source: { kind: "owner_feedback", ref: "lesson:<id>" }`, automations via `update`, the
 * other files and a skill's `LESSONS.md` as tagged lines. Gates (cards) are the service's job:
 * a writer runs only once a lesson may be written.
 */

/** A skill's lessons file is loaded with the skill, so it stays small (§6). */
export const SKILL_LESSONS_BUDGET = 2_000;

export interface AskRules {
  add(rule: string): Promise<void>;
  remove(rule: string): Promise<void>;
}

export interface LessonWriterDeps {
  memory: SqliteMemoryStore;
  /** The people graph (S07); without it entity lessons fall back to USER.md's People. */
  graph?: GraphStore;
  scheduler?: Pick<Scheduler, "get" | "update">;
  askRules?: AskRules;
}

export interface WriteInput {
  lessonId: string;
  kind: LessonKind;
  scope: LessonScope;
  value: string;
  destination: PlannedDestination;
  /** The live lesson this one supersedes on the same destination. */
  replaces?: StoredLesson | undefined;
  /** The thread the feedback came from (USER.md learned lines name it). */
  threadId?: string | undefined;
  /** A boundary's standing ask rule. */
  askRule?: string | undefined;
}

export type WriteResult =
  | { ok: true; destination: LessonDestination; previous: string | null; value: string }
  | { ok: false; reason: string };

const JOB = { provenance: "owner", actor: "job", source: "job" } as const;

function budgetFor(path: string): number {
  if (path.endsWith("LESSONS.md")) return SKILL_LESSONS_BUDGET;
  return path === "USER.md" ? BUDGETS["USER.md"] : BUDGETS.perFile;
}

function skillHeader(skill: string): string {
  return `# Lessons for ${skill}\n\nWhat ${skill} learned from your feedback. Loaded with the skill; edit or forget a lesson from its mark.\n`;
}

/** Directive lines carry the lesson's id at the end so they can be found again. */
function directiveTag(lessonId: string): string {
  return `[${lessonId}]`;
}

export class LessonWriter {
  readonly #d: LessonWriterDeps;

  constructor(deps: LessonWriterDeps) {
    this.#d = deps;
  }

  get graph(): GraphStore | undefined {
    return this.#d.graph;
  }

  #today(): string {
    return this.#d.memory.now().date;
  }

  async #read(path: string): Promise<string> {
    return (await this.#d.memory.readFile(path))?.content ?? "";
  }

  async #writeChecked(path: string, before: string, next: string): Promise<string | undefined> {
    if (next.length > budgetFor(path) && next.length > before.length) return "over_budget";
    await this.#d.memory.write(path, next, JOB);
    return undefined;
  }

  /** The before / after lines a card shows (`memory.lessons.get` diff too). */
  async preview(input: WriteInput): Promise<{ before: string | null; after: string }> {
    const d = input.destination;
    const date = this.#today();
    switch (d.type) {
      case "file": {
        const content = await this.#read(d.path);
        if (d.section === SECTION.userLearned) {
          const line = input.replaces?.destination;
          const before = line?.type === "file" ? (learnedLine(content, line.lineId) ?? null) : null;
          return { before, after: `- ${date} ${input.value}` };
        }
        if (d.section === SECTION.userDirectives) {
          const before =
            input.replaces === undefined
              ? null
              : (content
                  .split("\n")
                  .find((l) => l.includes(directiveTag(input.replaces?.id ?? ""))) ?? null);
          return { before, after: `- ${date} active: ${input.value}` };
        }
        const before =
          input.replaces === undefined
            ? null
            : (findLessonLine(content, input.replaces.id) ?? null);
        return { before, after: formatLessonLine(date, input.lessonId, input.scope, input.value) };
      }
      case "skill": {
        const content = await this.#read(d.path);
        const before =
          input.replaces === undefined
            ? null
            : (findLessonLine(content, input.replaces.id) ?? null);
        return { before, after: formatLessonLine(date, input.lessonId, input.scope, input.value) };
      }
      case "graph": {
        const graph = this.#d.graph;
        const prior =
          graph === undefined || d.attribute === undefined || MULTI_VALUED.has(d.attribute)
            ? undefined
            : graph.facts(d.entityId).find((f) => f.attribute === d.attribute);
        return { before: prior?.value ?? null, after: input.value };
      }
      case "automation": {
        const a = await this.#d.scheduler?.get(d.automationId);
        const prior =
          a === undefined ? null : String((a as Record<string, unknown>)[d.field] ?? "");
        return { before: prior, after: input.value };
      }
    }
  }

  async write(input: WriteInput): Promise<WriteResult> {
    const d = input.destination;
    const date = this.#today();
    switch (d.type) {
      case "file": {
        if (d.section === SECTION.userLearned) return this.#learned(input);
        if (d.section === SECTION.userDirectives) return this.#directive(input);
        const content = await this.#read(d.path);
        const previous =
          input.replaces === undefined
            ? null
            : (findLessonLine(content, input.replaces.id) ?? null);
        const line = formatLessonLine(date, input.lessonId, input.scope, input.value);
        const next = upsertLessonLine(content, d.section, line, input.replaces?.id);
        const refused = await this.#writeChecked(d.path, content, next);
        if (refused !== undefined) return { ok: false, reason: refused };
        return {
          ok: true,
          destination: { type: "file", path: d.path, section: d.section, lineId: input.lessonId },
          previous,
          value: input.value,
        };
      }
      case "skill": {
        const existing = await this.#read(d.path);
        const content = existing === "" ? skillHeader(d.skill) : existing;
        const previous =
          input.replaces === undefined
            ? null
            : (findLessonLine(content, input.replaces.id) ?? null);
        const line = formatLessonLine(date, input.lessonId, input.scope, input.value);
        const next = upsertLessonLine(content, SECTION.agentsLessons, line, input.replaces?.id);
        const refused = await this.#writeChecked(d.path, existing, next);
        if (refused !== undefined) return { ok: false, reason: refused };
        return {
          ok: true,
          destination: { type: "skill", skill: d.skill, path: d.path, lineId: input.lessonId },
          previous,
          value: input.value,
        };
      }
      case "graph":
        return this.#graph(input, d);
      case "automation": {
        const scheduler = this.#d.scheduler;
        const a = await scheduler?.get(d.automationId);
        if (scheduler === undefined || a === undefined)
          return { ok: false, reason: "no_automation" };
        const previous = String((a as Record<string, unknown>)[d.field] ?? "");
        await scheduler.update(d.automationId, { [d.field]: input.value });
        return {
          ok: true,
          destination: { type: "automation", automationId: d.automationId, field: d.field },
          previous,
          value: input.value,
        };
      }
    }
  }

  async #learned(input: WriteInput): Promise<WriteResult> {
    const content = await this.#read("USER.md");
    const replaced =
      input.replaces?.destination.type === "file" ? input.replaces.destination.lineId : undefined;
    const previous = replaced === undefined ? null : (learnedLine(content, replaced) ?? null);
    const { written, refused } = await this.#d.memory.learnUserFacts(
      [{ text: input.value, kind: "other", lessonId: input.lessonId }],
      {
        threadId: input.threadId ?? "teaching",
        ...(replaced === undefined ? {} : { replaces: replaced }),
      },
    );
    const fact = written[0];
    if (fact === undefined) return { ok: false, reason: refused[0]?.reason ?? "refused" };
    return {
      ok: true,
      destination: {
        type: "file",
        path: "USER.md",
        section: SECTION.userLearned,
        lineId: fact.factId,
      },
      previous,
      value: fact.text,
    };
  }

  async #directive(input: WriteInput): Promise<WriteResult> {
    const content = await this.#read("USER.md");
    const prevTag = input.replaces === undefined ? undefined : directiveTag(input.replaces.id);
    const previous =
      prevTag === undefined ? null : (content.split("\n").find((l) => l.includes(prevTag)) ?? null);
    const text = `${input.value.replace(/\s+/g, " ").trim()} ${directiveTag(input.lessonId)}`;
    const next = addDirective(content, {
      date: this.#today(),
      text,
      ...(prevTag === undefined ? {} : { supersedes: [prevTag] }),
    });
    const refused = await this.#writeChecked("USER.md", content, next);
    if (refused !== undefined) return { ok: false, reason: refused };
    if (input.askRule !== undefined) await this.#d.askRules?.add(input.askRule);
    return {
      ok: true,
      destination: {
        type: "file",
        path: "USER.md",
        section: SECTION.userDirectives,
        lineId: input.lessonId,
      },
      previous,
      value: input.value,
    };
  }

  #graph(input: WriteInput, d: Extract<PlannedDestination, { type: "graph" }>): WriteResult {
    const graph = this.#d.graph;
    if (graph === undefined) return { ok: false, reason: "no_graph" };
    const source = { kind: "owner_feedback" as const, ref: `lesson:${input.lessonId}` };
    if (d.rel !== undefined && d.dst !== undefined) {
      const r = graph.setEdge({
        src: d.entityId,
        rel: d.rel,
        dst: d.dst,
        provenance: "owner",
        confidence: 1,
        source,
      });
      if (r === undefined) return { ok: false, reason: "refused_by_graph" };
      return {
        ok: true,
        destination: { type: "graph", entityId: d.entityId, rel: d.rel, versionId: r.edge.id },
        previous: null,
        value: input.value,
      };
    }
    const attribute = d.attribute ?? "note";
    const prior = MULTI_VALUED.has(attribute)
      ? undefined
      : graph.facts(d.entityId).find((f) => f.attribute === attribute);
    const r = graph.setFact({
      entityId: d.entityId,
      attribute,
      value: input.value,
      provenance: "owner",
      confidence: 1,
      source,
    });
    if (r === undefined) return { ok: false, reason: "refused_by_graph" };
    return {
      ok: true,
      destination: { type: "graph", entityId: d.entityId, attribute, versionId: r.fact.id },
      previous: prior?.value ?? null,
      value: input.value,
    };
  }

  /** The lesson's current text at its destination, or `undefined` when its line is gone. */
  async current(lesson: StoredLesson): Promise<string | undefined> {
    const d = lesson.destination;
    switch (d.type) {
      case "file": {
        const content = await this.#read(d.path);
        if (d.section === SECTION.userLearned) {
          const line = learnedLine(content, d.lineId);
          return line?.replace(/^- \d{4}-\d{2}-\d{2} \[[^\]]*\] /, "");
        }
        if (d.section === SECTION.userDirectives) {
          const line = content.split("\n").find((l) => l.includes(directiveTag(lesson.id)));
          return line
            ?.replace(/^- \S+ (?:active|superseded by \S+): /, "")
            .replace(/ \[ls_[^\]]+\]$/, "");
        }
        return lessonLineText(content, lesson.id);
      }
      case "skill":
        return lessonLineText(await this.#read(d.path), lesson.id);
      case "graph": {
        if (d.versionId === undefined || this.#d.graph === undefined) return undefined;
        if (d.attribute !== undefined) {
          const f = this.#d.graph.getFact(d.versionId);
          return f === undefined || f.retractedAt != null || f.supersededBy != null
            ? undefined
            : f.value;
        }
        return lesson.value;
      }
      case "automation": {
        const a = await this.#d.scheduler?.get(d.automationId);
        return a === undefined ? undefined : String((a as Record<string, unknown>)[d.field] ?? "");
      }
    }
  }

  /**
   * Removes a lesson from its destination, putting back what it replaced (`previous`), and its
   * standing ask rule (§3.5 "Forget a lesson"). Missing lines are not an error: the owner may
   * have deleted the line by hand.
   */
  async remove(
    lesson: StoredLesson,
    options: { askRule?: string | undefined } = {},
  ): Promise<void> {
    const d = lesson.destination;
    const restore = lesson.previous ?? undefined;
    switch (d.type) {
      case "file": {
        const content = await this.#read(d.path);
        let next: string | undefined;
        if (d.section === SECTION.userLearned) {
          next = removeLearned(content, d.lineId, restore);
        } else if (d.section === SECTION.userDirectives) {
          const lines = content.split("\n");
          const own = lines.findIndex((l) => l.includes(directiveTag(lesson.id)));
          if (own >= 0) lines.splice(own, 1);
          if (lesson.supersedes != null && restore !== undefined) {
            const prev = lines.findIndex((l) => l.includes(directiveTag(lesson.supersedes ?? "")));
            if (prev >= 0) lines[prev] = restore;
          }
          next = own >= 0 ? lines.join("\n") : undefined;
        } else {
          next = removeLessonLine(content, lesson.id, restore);
        }
        if (next !== undefined) await this.#d.memory.write(d.path, next, JOB);
        break;
      }
      case "skill": {
        const content = await this.#read(d.path);
        const next = removeLessonLine(content, lesson.id, restore);
        if (next !== undefined) await this.#d.memory.write(d.path, next, JOB);
        break;
      }
      case "graph": {
        const graph = this.#d.graph;
        if (graph === undefined || d.versionId === undefined) break;
        const source = { kind: "owner_feedback" as const, ref: `lesson:${lesson.id}` };
        try {
          if (d.attribute !== undefined) {
            graph.retractFact(d.versionId, source);
            if (restore !== undefined && !MULTI_VALUED.has(d.attribute as never)) {
              graph.setFact({
                entityId: d.entityId,
                attribute: d.attribute as never,
                value: restore,
                provenance: "owner",
                confidence: 1,
                source,
              });
            }
          } else {
            graph.retractEdge(d.versionId, source);
          }
        } catch {
          // Already retracted or merged away: nothing left to remove.
        }
        break;
      }
      case "automation": {
        if (restore !== undefined && (await this.#d.scheduler?.get(d.automationId)) !== undefined) {
          await this.#d.scheduler?.update(d.automationId, { [d.field]: restore });
        }
        break;
      }
    }
    if (options.askRule !== undefined) await this.#d.askRules?.remove(options.askRule);
  }

  /** The owner's edit of a lesson's line or value, in place (`memory.lessons.edit`). */
  async rewrite(lesson: StoredLesson, value: string): Promise<WriteResult> {
    const d = lesson.destination;
    const date = this.#today();
    switch (d.type) {
      case "file": {
        const content = await this.#read(d.path);
        let next: string | undefined;
        if (d.section === SECTION.userLearned) {
          const line = learnedLine(content, d.lineId);
          const m = line === undefined ? null : /^- (\S+) \[\S+ thread:(\S+) (\w+)/.exec(line);
          next =
            m === null
              ? undefined
              : removeLearned(
                  content,
                  d.lineId,
                  formatLearned({
                    factId: d.lineId,
                    date: m[1] as string,
                    threadId: m[2] as string,
                    kind: m[3] as never,
                    text: value,
                    lessonId: lesson.id,
                  }),
                );
        } else if (d.section === SECTION.userDirectives) {
          const lines = content.split("\n");
          const at = lines.findIndex((l) => l.includes(directiveTag(lesson.id)));
          if (at >= 0) {
            lines[at] =
              `- ${date} active: ${value.replace(/\s+/g, " ").trim()} ${directiveTag(lesson.id)}`;
            next = lines.join("\n");
          }
        } else {
          const line = formatLessonLine(date, lesson.id, lesson.scope, value);
          next =
            findLessonLine(content, lesson.id) === undefined
              ? undefined
              : upsertLessonLine(content, d.section, line, lesson.id);
        }
        if (next === undefined) return { ok: false, reason: "line_missing" };
        const refused = await this.#writeChecked(d.path, content, next);
        if (refused !== undefined) return { ok: false, reason: refused };
        return { ok: true, destination: d, previous: lesson.previous ?? null, value };
      }
      case "skill": {
        const content = await this.#read(d.path);
        if (findLessonLine(content, lesson.id) === undefined)
          return { ok: false, reason: "line_missing" };
        const next = upsertLessonLine(
          content,
          SECTION.agentsLessons,
          formatLessonLine(date, lesson.id, lesson.scope, value),
          lesson.id,
        );
        const refused = await this.#writeChecked(d.path, content, next);
        if (refused !== undefined) return { ok: false, reason: refused };
        return { ok: true, destination: d, previous: lesson.previous ?? null, value };
      }
      case "graph": {
        const r = this.#graph(
          {
            lessonId: lesson.id,
            kind: lesson.kind,
            scope: lesson.scope,
            value,
            destination: {
              type: "graph",
              entityId: d.entityId,
              ...(d.attribute === undefined ? {} : { attribute: d.attribute as never }),
            },
          },
          {
            type: "graph",
            entityId: d.entityId,
            ...(d.attribute === undefined ? {} : { attribute: d.attribute as never }),
          },
        );
        return r.ok ? { ...r, previous: lesson.previous ?? null } : r;
      }
      case "automation": {
        const scheduler = this.#d.scheduler;
        if (scheduler === undefined || (await scheduler.get(d.automationId)) === undefined)
          return { ok: false, reason: "no_automation" };
        await scheduler.update(d.automationId, { [d.field]: value });
        return { ok: true, destination: d, previous: lesson.previous ?? null, value };
      }
    }
  }

  /** Lines dreaming derived from a lesson (MEMORY.md bullets citing `lesson:<id>`) go with it. */
  async removeDerived(lessonId: string): Promise<number> {
    const content = await this.#read("MEMORY.md");
    if (!content.includes(`lesson:${lessonId}`)) return 0;
    const lines = content.split("\n");
    const kept = lines.filter((l) => !l.includes(`lesson:${lessonId}`));
    await this.#d.memory.write("MEMORY.md", kept.join("\n"), JOB);
    return lines.length - kept.length;
  }
}
