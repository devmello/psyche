import type { Clock } from "@psyche/protocol";
import { normalizeName } from "./normalize.ts";
import type { GraphStore } from "./store.ts";

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
}

/** Interactions of the last `days` that name a confirmed project join it; their people become members. */
export function assignProjects(graph: GraphStore, clock: Clock, days = 30): ProjectPassReport {
  const report: ProjectPassReport = { assigned: 0, members: 0, suggestions: 0 };
  const projects = graph.listEntities(["project"]).filter((p) => p.projectStatus !== "done");
  if (projects.length === 0) return report;
  const now = clock.now();
  const recent = graph.interactionsBetween(
    new Date(now - days * DAY_MS).toISOString(),
    new Date(now + 14 * DAY_MS).toISOString(),
  );
  for (const project of projects) {
    const names = [project.name, ...project.aliases]
      .map((n) => words(n))
      .filter((w) => w.length > 0);
    for (const i of recent) {
      if (typeof i.projectId === "string" || typeof i.subject !== "string") continue;
      const subject = new Set(words(i.subject));
      if (!names.some((n) => n.every((w) => subject.has(w)))) continue;
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
