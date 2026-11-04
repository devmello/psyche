import type { GraphEntity } from "@psyche/protocol";
import type { GraphStore } from "./store.ts";

/**
 * "Continue in chat" on a Memory page (docs/design/memory-everything-2026.md §7.1 W4, §7.4): what
 * the Gateway may say about an item when the owner opens a chat about it, and whether that turn
 * starts tainted. Decided here from the store, never from what the window sent.
 *
 * - Only a **work item** (project, course, assignment, event in a project) continues in chat; a
 *   person, organization, place or topic is not offered (`work_status` is what reads an item).
 * - A work item has a **trusted title** when the owner wrote it (`titleUntrusted` is false: not a
 *   tracked suggestion, not a rule over an untrusted source) and no status, deadline or progress
 *   came from third parties. Only then may it be named in the context card and the preamble.
 * - The turn is **tainted** when anything the agent can read about the item came from someone else:
 *   an untrusted title, fact or timeline row. A tainted turn asks before a send or a write to a
 *   new target (`taint:floor`).
 * - A hidden, archived or Keep-private item (or one inside a private course) is not offered.
 */

const WORK_KINDS: ReadonlySet<string> = new Set(["project", "assignment", "event"]);

export interface MemoryItemContext {
  entity: GraphEntity;
  /** A work item the owner may see named in their own message and the transcript card. */
  titleTrusted: boolean;
  /** Anything the agent can read about it came from third parties. */
  tainted: boolean;
}

export function memoryItemContext(graph: GraphStore, id: string): MemoryItemContext | undefined {
  const entity = graph.getEntity(graph.resolveMerged(id));
  if (entity === undefined || entity.status !== "active" || entity.hidden) return undefined;
  if (entity.private === true) return undefined;
  // Only work items continue in chat: `work_status` is what reads them. A person's page has no chip.
  if (!WORK_KINDS.has(entity.kind)) return undefined;
  const parents = graph
    .edges(entity.id)
    .filter((e) => e.rel === "part_of" && e.src === entity.id)
    .map((e) => graph.getEntity(e.dst));
  if (parents.some((p) => p?.private === true)) return undefined;
  const facts = graph.facts(entity.id);
  // W4: only an owner-written title may be named. It is the owner's when the name was not read
  // from someone else's text (`titleUntrusted`) and no status, deadline or progress was either.
  const titleTrusted =
    entity.titleUntrusted !== true &&
    !facts.some(
      (f) =>
        f.provenance === "untrusted" &&
        (f.attribute === "deadline" || f.attribute === "status" || f.attribute === "progress"),
    );
  const tainted =
    !titleTrusted ||
    parents.some((p) => p?.titleUntrusted === true) ||
    facts.some((f) => f.provenance === "untrusted") ||
    graph.timeline(entity.id, { limit: 60 }).rows.some((r) => r.provenance === "untrusted");
  return { entity, titleTrusted, tainted };
}
