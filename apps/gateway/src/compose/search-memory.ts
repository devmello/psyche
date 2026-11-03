import type { GraphStore } from "@psyche/memory";
import type { GraphEntityKind } from "@psyche/protocol";
import type { MemoryRecord, MemorySourceDeps } from "@psyche/search";

/**
 * What the Memory search source may index (Settings → Search sources → Memory), read from the
 * people and projects graph. This is the gate: `search`'s adapter only formats what it is handed,
 * so anything not returned here is never indexed.
 *
 * - Entities: active, not hidden ("don't track") and not kept private (those show on their Memory
 *   page only, never on a surface; Search is one).
 * - Facts: current, reviewed (accepted, auto-accepted or edited; nothing waiting for review,
 *   discarded or quarantined), not sensitive in any class, and not what a third party wrote
 *   (`untrusted`), the same line the graph's own full-text index draws.
 * - Not the model's one-line summary of a person (written from other people's mail) and not the
 *   open loops (extracted from mail and messages): neither is the owner's own memory to index.
 *
 * Nothing here reads Mail, Notes or any other app.
 */

const KINDS: GraphEntityKind[] = [
  "person",
  "org",
  "project",
  "place",
  "event",
  "topic",
  "assignment",
];

type Graph = Pick<GraphStore, "listEntities" | "getEntity" | "facts" | "edges" | "identifiers">;

export function memoryRecords(graph: Graph): MemoryRecord[] {
  const visible = (e: { status: string; hidden: boolean; private?: boolean | undefined }) =>
    e.status === "active" && !e.hidden && e.private !== true;
  const out: MemoryRecord[] = [];
  for (const e of graph.listEntities(KINDS)) {
    if (!visible(e)) continue;
    let partOf: string | null = null;
    if (e.kind === "assignment" || e.kind === "event") {
      const edge = graph.edges(e.id).find((x) => x.rel === "part_of" && x.src === e.id);
      const parent = edge === undefined ? undefined : graph.getEntity(edge.dst);
      // A parent the owner hid or kept private is not named here either.
      if (parent !== undefined && visible(parent)) partOf = parent.name;
    }
    const facts = graph
      .facts(e.id)
      .filter((f) => (f.sensitivity ?? "none") === "none" && f.provenance !== "untrusted")
      .map((f) => ({
        attribute: f.attribute,
        value: f.value,
        provenance: f.provenance === "agent" ? ("agent" as const) : ("owner" as const),
      }));
    const identifiers =
      e.kind === "person" || e.kind === "org"
        ? graph
            .identifiers(e.id)
            .filter((i) => i.kind === "email" || i.kind === "phone")
            .map((i) => i.value)
        : [];
    out.push({
      id: e.id,
      kind: e.kind,
      name: e.name,
      aliases: e.aliases,
      ...(identifiers.length > 0 ? { identifiers } : {}),
      status: e.workStatus ?? e.projectStatus ?? null,
      dueAt: e.kind === "person" || e.kind === "org" ? null : e.dueAt,
      partOf,
      facts,
      createdAt: e.createdAt,
      updatedAt: e.updatedAt,
      lastInteractionAt: e.lastInteractionAt,
    });
  }
  return out;
}

/**
 * The source's seam. While the owner has the memory graph off it reads nothing (an empty read,
 * which removes what was indexed: off means off), and while memory is still opening it says so.
 */
export function memorySourceDeps(o: {
  /** The graph while the owner has memory on; undefined while it is off. */
  graph: () => Graph | undefined;
  /** False while the memory store is still opening (it may sit behind the Mac helper's key). */
  ready?: () => boolean;
}): MemorySourceDeps {
  const ready = () => o.ready?.() ?? true;
  return {
    unavailable: () => (ready() ? undefined : "Memory is still opening"),
    read: () => {
      if (!ready()) return undefined;
      const graph = o.graph();
      return graph === undefined ? [] : memoryRecords(graph);
    },
  };
}
