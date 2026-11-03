import type { Clock } from "@psyche/protocol";
import { normalizeName } from "./normalize.ts";
import type { GraphStore } from "./store.ts";
import { isOpenWork, namedIn, workNames } from "./work-signals.ts";

/**
 * Deterministic project work (docs/memory/people-and-projects-2026.md §5.2 "Project clustering"):
 * confirmed projects claim interactions whose subject names them and gain their people as
 * members; repeated subject phrases across several interactions and people become suggestions
 * the owner confirms. No model is needed for either.
 */

const STOP = new Set(
  "re fw fwd aw sv the and for with from your our you a an of to in on at by is are was be this that it re: fwd: invitation updated accepted declined meeting call sync notes".split(
    " ",
  ),
);
const DAY_MS = 86_400_000;

function words(subject: string): string[] {
  return normalizeName(subject)
    .split(" ")
    .filter((w) => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w));
}

export interface ProjectPassReport {
  assigned: number;
  members: number;
  suggestions: number;
  /** Assignments an interaction was tied to as a subject (§2.6 of the memory-everything plan). */
  subjects?: number;
}

/** Interactions of the last `days` that name a confirmed project join it; their people become members. */
export function assignProjects(graph: GraphStore, clock: Clock, days = 30): ProjectPassReport {
  const report: ProjectPassReport = { assigned: 0, members: 0, suggestions: 0 };
  const projects = graph.listEntities(["project"]).filter((p) => p.projectStatus !== "done");
  const now = clock.now();
  const recent = graph.interactionsBetween(
    new Date(now - days * DAY_MS).toISOString(),
    new Date(now + 14 * DAY_MS).toISOString(),
  );
  assignWork(graph, recent, report);
  for (const project of projects) {
    // A course is matched on whole tokens, digits included ("MATH 21" is not "MATH 210"); other
    // projects keep the looser word match.
    const course = project.projectType === "course";
    const courseNames = course ? workNames(graph, project) : [];
    const names = course
      ? []
      : [project.name, ...project.aliases].map((n) => words(n)).filter((w) => w.length > 0);
    for (const i of recent) {
      if (typeof i.projectId === "string" || typeof i.subject !== "string") continue;
      const text = i.subject;
      const subject = new Set(words(text));
      const hit = course
        ? courseNames.some((n) => namedIn(n, text))
        : names.some((n) => n.every((w) => subject.has(w)));
      if (!hit) continue;
      graph.setInteractionProject(i.id, project.id);
      report.assigned++;
      for (const p of i.participants) {
        const kind = graph.getEntity(p.entityId)?.kind;
        if (kind !== "person" && kind !== "org") continue;
        const added = graph.setEdge({
          src: p.entityId,
          rel: kind === "person" ? "member_of" : "stakeholder_of",
          dst: project.id,
          provenance: "system",
          confidence: 0.7,
          sources: [i.id],
        });
        if (added !== undefined && added.superseded === null) report.members++;
      }
    }
  }
  return report;
}

/**
 * Interactions that name an open assignment ("Lecture Work 7") join its timeline: the assignment
 * and its course are linked as subjects (rule, §2.6 of the memory-everything plan), and the course
 * becomes the interaction's project when it has none. A link is a pointer, not a signal: it never
 * changes a status or `last_signal_at`, so mail from anyone can sit on the timeline as data (W1).
 * A name needs two tokens ("HW7", "Report 2"), so one common word never claims a mail.
 */
function assignWork(
  graph: GraphStore,
  recent: ReturnType<GraphStore["interactionsBetween"]>,
  report: ProjectPassReport,
): void {
  const assignments = graph
    .listEntities(["assignment"])
    .filter(isOpenWork)
    .map((entity) => ({
      entity,
      names: workNames(graph, entity),
      parent: graph.edges(entity.id).find((e) => e.src === entity.id && e.rel === "part_of")?.dst,
    }));
  if (assignments.length === 0) return;
  for (const i of recent) {
    if (typeof i.subject !== "string") continue;
    const subject = i.subject;
    const hits = assignments.filter((a) => a.names.some((n) => namedIn(n, subject)));
    // Two assignments named in one subject: not clear which, so leave it to anchors and the owner.
    if (hits.length !== 1) continue;
    const { entity, parent } = hits[0] as (typeof assignments)[number];
    const known = new Set(graph.subjectsOf(i.id).map((s) => s.entityId));
    if (!known.has(entity.id)) {
      graph.linkSubject(i.id, entity.id, "rule", 0.8);
      report.subjects = (report.subjects ?? 0) + 1;
    }
    if (parent === undefined) continue;
    if (!known.has(parent)) graph.linkSubject(i.id, parent, "rule", 0.8);
    if (typeof i.projectId !== "string") {
      graph.setInteractionProject(i.id, parent);
      report.assigned++;
    }
  }
}

/**
 * Two-word phrases that appear in the subjects of at least `minInteractions` interactions with
 * at least two different people in the last `days` days become project suggestions, unless a
 * project of that name exists or the owner said it is not a project.
 */
export function suggestProjects(
  graph: GraphStore,
  clock: Clock,
  options: { days?: number; minInteractions?: number } = {},
): ProjectPassReport {
  const report: ProjectPassReport = { assigned: 0, members: 0, suggestions: 0 };
  const days = options.days ?? 30;
  const min = options.minInteractions ?? 3;
  const now = clock.now();
  const recent = graph
    .interactionsBetween(new Date(now - days * DAY_MS).toISOString(), new Date(now).toISOString())
    .filter((i) => typeof i.projectId !== "string" && typeof i.subject === "string");
  const phrases = new Map<string, { interactions: Set<string>; people: Set<string> }>();
  for (const i of recent) {
    const w = words(i.subject ?? "");
    const seen = new Set<string>();
    for (let k = 0; k + 1 < w.length; k++) {
      const phrase = `${w[k]} ${w[k + 1]}`;
      if (seen.has(phrase)) continue;
      seen.add(phrase);
      const entry = phrases.get(phrase) ?? { interactions: new Set(), people: new Set() };
      entry.interactions.add(i.id);
      for (const p of i.participants)
        if (graph.getEntity(p.entityId)?.kind === "person") entry.people.add(p.entityId);
      phrases.set(phrase, entry);
    }
  }
  const existing = new Set(
    graph
      .listEntities(["project"])
      .flatMap((p) => [p.name, ...p.aliases])
      .map(normalizeName),
  );
  const ranked = [...phrases.entries()]
    .filter(([, e]) => e.interactions.size >= min && e.people.size >= 2)
    .sort((a, b) => b[1].interactions.size - a[1].interactions.size);
  const taken = new Set<string>();
  for (const [phrase, e] of ranked) {
    if (existing.has(phrase) || [...e.interactions].every((id) => taken.has(id))) continue;
    for (const id of e.interactions) taken.add(id);
    const name = phrase.charAt(0).toUpperCase() + phrase.slice(1);
    const s = graph.suggest({
      kind: "project",
      entityIds: [...e.people],
      name,
      reason: `${e.interactions.size} conversations with ${e.people.size} people in the last ${days} days mention "${phrase}"`,
    });
    if (s !== undefined) report.suggestions++;
  }
  return report;
}
