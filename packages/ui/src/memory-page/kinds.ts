import type { GraphEntityKind } from "@psyche/protocol";

/** The Memory page's kind chips, in order (docs/design/memory-everything-2026.md §6.2). */
export const MEMORY_KINDS = ["everything", "people", "projects", "due", "events", "more"] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

/** `?kind=` as a chip; anything else is Everything. */
export function parseMemoryKind(value: string | null | undefined): MemoryKind {
  return MEMORY_KINDS.find((k) => k === value) ?? "everything";
}

/** The route of a chip: Everything is the bare `/memory`. */
export function memoryHref(kind: MemoryKind): string {
  return kind === "everything" ? "/memory" : `/memory?kind=${kind}`;
}

/** `/memory?view=map`: the Map view of the Memory page (List is the bare chip routes). */
export const MEMORY_MAP_ROUTE = "/memory?view=map";

/** `?view=` as a view; anything else is the list. */
export function parseMemoryView(value: string | null | undefined): "list" | "map" {
  return value === "map" ? "map" : "list";
}

/** The route of an entity's page, which opens in the Memory page. */
export function entityHref(id: string): string {
  return `/memory?entity=${encodeURIComponent(id)}`;
}

/** The chip an entity's page goes Back to: the list it is shown in. */
export function kindForEntity(kind: GraphEntityKind): MemoryKind {
  if (kind === "project") return "projects";
  if (kind === "event") return "events";
  if (kind === "assignment") return "due";
  if (kind === "topic") return "more";
  return "people";
}
