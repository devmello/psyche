import type { GraphEntity } from "@psyche/protocol";
import { OWNER_SCOPE, type SearchDoc } from "./types.ts";

/**
 * People / Projects adapter (docs/memory/people-and-projects-2026.md §6.1): one document per
 * active person or project in the memory graph, owner scope only. Organisations and places are
 * found through their people. The model's summary is written from other people's mail, so a doc
 * that carries one is `untrusted`; names and aliases alone are the system's.
 */

export const GRAPH_SEARCH_SOURCE = "memory-graph";

export function graphDocId(entityId: string): string {
  return `entity:${entityId}`;
}

/** `undefined` when the entity should not be searchable (merged, hidden, owner, org, place). */
export function entityDoc(
  entity: GraphEntity,
  extra: { subtitle?: string | null } = {},
): SearchDoc | undefined {
  if (entity.kind !== "person" && entity.kind !== "project") return undefined;
  if (entity.status !== "active" || entity.hidden || entity.isOwner) return undefined;
  const summary = typeof entity.summary === "string" ? entity.summary.trim() : "";
  const text = [
    entity.name,
    ...entity.aliases,
    ...(typeof extra.subtitle === "string" ? [extra.subtitle] : []),
    ...(summary === "" ? [] : [summary]),
  ].join("\n");
  const updated = Date.parse(entity.lastInteractionAt ?? entity.updatedAt);
  return {
    id: graphDocId(entity.id),
    kind: entity.kind,
    title: entity.name,
    text,
    provenance: summary === "" ? "system" : "untrusted",
    tags: entity.kind === "project" && entity.projectStatus != null ? [entity.projectStatus] : [],
    scopeKey: OWNER_SCOPE,
    createdAt: Date.parse(entity.createdAt),
    ...(Number.isNaN(updated) ? {} : { updatedAt: updated }),
    source: GRAPH_SEARCH_SOURCE,
  };
}
