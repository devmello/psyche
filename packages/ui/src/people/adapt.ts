import type {
  GraphEntityDetail,
  GraphFact,
  GraphInteraction,
  GraphLoop,
  GraphSuggestion,
} from "@psyche/protocol";
import type {
  EdgeView,
  EntityRef,
  EntityView,
  FactView,
  InteractionView,
  LoopView,
  SourceView,
  SuggestionView,
} from "./types.ts";

/**
 * Joins one `memory.entities.get` result (docs/memory/people-and-projects-2026.md §6.1) into what
 * a card renders (§6.5): facts and relations with their sources resolved, loops and interactions
 * with names for the ids they point at (from `related`).
 */

/** A fact or relation is current when nothing superseded or retracted it and it hasn't expired. */
export function isCurrent(
  row: { supersededBy?: string | null; retractedAt?: string | null; validTo?: string | null },
  now: number,
): boolean {
  return (
    row.supersededBy == null &&
    row.retractedAt == null &&
    (row.validTo == null || Date.parse(row.validTo) > now)
  );
}

export type NameLookup = ReadonlyMap<string, EntityRef>;

function sourceOf(
  interaction: GraphInteraction | undefined,
  names: NameLookup,
  self: EntityRef,
): SourceView | null {
  if (!interaction) return null;
  const sender = interaction.participants.find((p) => p.role === "from");
  const from = sender
    ? sender.entityId === self.id
      ? self.name
      : names.get(sender.entityId)?.name
    : null;
  return {
    kind: interaction.kind,
    link: interaction.link ?? null,
    at: interaction.occurredAt,
    from: from ?? null,
  };
}

function factSource(
  fact: GraphFact,
  byId: ReadonlyMap<string, GraphInteraction>,
  names: NameLookup,
  self: EntityRef,
): SourceView | null {
  for (const ref of fact.sources) {
    const interaction = byId.get(ref);
    if (interaction) return sourceOf(interaction, names, self);
    if (/^contact/i.test(ref)) return { kind: "contacts" };
  }
  if (fact.provenance === "owner") return { kind: "owner", at: fact.recordedAt };
  return null;
}

export interface AdaptInput {
  /** `memory.entities.get`. */
  detail: GraphEntityDetail;
  /** The owner's Notes section of the card file, when the host read it. */
  notes?: string | null;
  now: number;
}

export function toEntityView({ detail, notes = null, now }: AdaptInput): EntityView {
  const { entity } = detail;
  const self: EntityRef = { id: entity.id, kind: entity.kind, name: entity.name };
  const names: NameLookup = new Map(
    detail.related.map((r) => [r.id, { id: r.id, kind: r.kind, name: r.name }] as const),
  );
  const byId = new Map(detail.recentInteractions.map((i) => [i.id, i]));
  const ref = (id: string | null | undefined): EntityRef | null =>
    id == null ? null : (names.get(id) ?? (id === entity.id ? self : null));

  const facts: FactView[] = detail.facts
    .filter((f) => f.entityId === entity.id && isCurrent(f, now))
    .map((f) => ({
      id: f.id,
      attribute: f.attribute,
      value: f.value,
      provenance: f.provenance,
      evidence: f.evidence ?? null,
      source: factSource(f, byId, names, self),
      recordedAt: f.recordedAt,
    }));

  const edges: EdgeView[] = [];
  for (const e of detail.edges) {
    if (!isCurrent(e, now) || (e.src !== entity.id && e.dst !== entity.id)) continue;
    const other = ref(e.src === entity.id ? e.dst : e.src);
    if (!other) continue;
    edges.push({ id: e.id, rel: e.rel, label: e.label ?? null, provenance: e.provenance, other });
  }

  const loops: LoopView[] = detail.openLoops.map((l: GraphLoop) => ({
    id: l.id,
    direction: l.direction,
    text: l.text,
    evidence: l.evidence ?? null,
    counterpart: ref(l.counterpartId),
    project: ref(l.projectId),
    dueAt: l.dueAt ?? null,
    status: l.status,
    provenance: l.provenance,
    source: l.sourceInteractionId ? sourceOf(byId.get(l.sourceInteractionId), names, self) : null,
  }));

  const interactions: InteractionView[] = detail.recentInteractions.map((i) => ({
    id: i.id,
    kind: i.kind,
    occurredAt: i.occurredAt,
    direction: i.direction,
    link: i.link ?? null,
    subject: i.subject ?? null,
    ...(i.gist == null
      ? {}
      : {
          gist: i.gist,
          ...(i.gistDocId === undefined ? {} : { gistDocId: i.gistDocId }),
          gistUntrusted:
            (i.kind === "mail" ||
              i.kind === "message" ||
              i.kind === "call" ||
              i.kind === "meeting") &&
            i.direction !== "out",
        }),
    with: i.participants
      .filter((p) => p.entityId !== entity.id)
      .map((p) => names.get(p.entityId)?.name)
      .filter((n): n is string => typeof n === "string"),
  }));

  const parentEdge = detail.edges.find(
    (e) => e.rel === "part_of" && e.src === entity.id && isCurrent(e, now),
  );
  const assignedByEdge = detail.edges.find(
    (e) => e.rel === "assigned_by" && e.src === entity.id && isCurrent(e, now),
  );
  const assignmentIds = new Set(
    detail.edges
      .filter((e) => e.rel === "part_of" && e.dst === entity.id && isCurrent(e, now))
      .map((e) => e.src),
  );
  const work = ["project", "assignment", "event"].includes(entity.kind);

  return {
    id: entity.id,
    kind: entity.kind,
    name: entity.name,
    aliases: entity.aliases,
    pinned: entity.pinned,
    projectStatus: entity.projectStatus ?? null,
    ...(work
      ? {
          projectType: entity.projectType ?? null,
          workStatus: entity.workStatus ?? null,
          dueAt: entity.dueAt,
          private: entity.private === true,
          lastSignalAt: entity.lastSignalAt ?? null,
          parent: ref(parentEdge?.dst),
          assignedBy: ref(assignedByEdge?.dst),
          assignments: detail.related.filter(
            (r) => r.kind === "assignment" && assignmentIds.has(r.id),
          ),
        }
      : {}),
    summary: entity.summary ?? null,
    summaryAt: entity.summaryAt ?? null,
    lastInteractionAt: entity.lastInteractionAt ?? null,
    identifiers: detail.identifiers,
    facts,
    edges,
    loops,
    interactions,
    notes,
  };
}

/** A suggestion with its entities named; the detail line is an email when one is known. */
export function toSuggestionView(
  suggestion: GraphSuggestion,
  names: NameLookup,
  details: ReadonlyMap<string, string> = new Map(),
): SuggestionView {
  const entities =
    suggestion.kind !== "merge" && suggestion.name
      ? [{ id: suggestion.entityIds[0] ?? suggestion.id, name: suggestion.name, detail: null }]
      : suggestion.entityIds.map((id) => ({
          id,
          name: names.get(id)?.name ?? id,
          detail: details.get(id) ?? null,
        }));
  return {
    id: suggestion.id,
    kind: suggestion.kind,
    entities,
    reasons: suggestion.reason ? [suggestion.reason] : [],
  };
}
