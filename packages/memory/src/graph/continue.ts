import type { GraphEntity } from "@psyche/protocol";
import type { GraphStore } from "./store.ts";

/**
 * "Continue in chat" on a Memory page (docs/design/memory-everything-2026.md §7.1 W4, §7.4): what
 * the Gateway may say about an item when the owner opens a chat about it, and whether that turn
 * starts tainted. Decided here from the store, never from what the window sent.
 *
 * - A **work item** (project, course, assignment, event in a project) whose status, deadline and
 *   progress all came from the owner, a rule or Psyche has a **trusted title**: it may be named in
 *   the context card and the preamble. Any untrusted fact on those attributes makes the title
 *   third-party text (W3), so it is never inlined as the owner's words.
 * - The turn is **tainted** when anything the agent can read about the item came from someone else:
 *   an untrusted fact or timeline row, or any item that is not a work item (a person's name and
 *   facts come from mail headers and messages). A tainted turn asks before a send or a write to a
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
  const parent = graph.edges(entity.id).find((e) => e.rel === "part_of" && e.src === entity.id);
  if (parent !== undefined && graph.getEntity(parent.dst)?.private === true) return undefined;
  if (!WORK_KINDS.has(entity.kind)) return { entity, titleTrusted: false, tainted: true };
  const facts = graph.facts(entity.id);
  const titleTrusted = !facts.some(
    (f) =>
      f.provenance === "untrusted" &&
      (f.attribute === "deadline" || f.attribute === "status" || f.attribute === "progress"),
  );
  const tainted =
    !titleTrusted ||
    facts.some((f) => f.provenance === "untrusted") ||
    graph.timeline(entity.id, { limit: 60 }).rows.some((r) => r.provenance === "untrusted");
  return { entity, titleTrusted, tainted };
}
