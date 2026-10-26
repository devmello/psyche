import { type MethodParams, type MethodResult, PsycheError } from "@psyche/protocol";
import type { SqliteMemoryStore } from "../store.ts";
import type { CardSync } from "./cards.ts";
import type { GraphStore } from "./store.ts";

/**
 * `memory.entities.*`, `memory.loops.*` and `memory.graph.status` (docs/memory/people-and-projects-2026.md
 * §6.1). The caller is a paired device that passed the scope checks, i.e. the owner: every write
 * here is an owner write. Cards are re-rendered after each change.
 */

export type GraphMethod =
  | "memory.entities.search"
  | "memory.entities.get"
  | "memory.entities.interactions"
  | "memory.entities.create"
  | "memory.entities.update"
  | "memory.entities.facts.set"
  | "memory.entities.facts.retract"
  | "memory.entities.edges.set"
  | "memory.entities.edges.retract"
  | "memory.entities.history"
  | "memory.entities.merge"
  | "memory.entities.split"
  | "memory.entities.suggestions"
  | "memory.entities.suggestions.answer"
  | "memory.entities.forget"
  | "memory.loops.list"
  | "memory.loops.update"
  | "memory.graph.status"
  | "memory.graph.forgetAll"
  | "memory.graph.deleteSource"
  | "memory.graph.blocklist.list"
  | "memory.graph.blocklist.add"
  | "memory.graph.blocklist.remove";

export type GraphHandlers = {
  [M in GraphMethod]: (params: MethodParams<M>) => Promise<MethodResult<M>>;
};

export const GRAPH_METHODS: readonly GraphMethod[] = [
  "memory.entities.search",
  "memory.entities.get",
  "memory.entities.interactions",
  "memory.entities.create",
  "memory.entities.update",
  "memory.entities.facts.set",
  "memory.entities.facts.retract",
  "memory.entities.edges.set",
  "memory.entities.edges.retract",
  "memory.entities.history",
  "memory.entities.merge",
  "memory.entities.split",
  "memory.entities.suggestions",
  "memory.entities.suggestions.answer",
  "memory.entities.forget",
  "memory.loops.list",
  "memory.loops.update",
  "memory.graph.status",
  "memory.graph.forgetAll",
  "memory.graph.deleteSource",
  "memory.graph.blocklist.list",
  "memory.graph.blocklist.add",
  "memory.graph.blocklist.remove",
];

export interface GraphHandlerOptions {
  cards?: CardSync;
  /** Used to forget the person's mentions in notes as well (`forget(subject)` on the name). */
  memory?: SqliteMemoryStore;
  /** The `memory.graph` settings and the last model pass, for `memory.graph.status`. */
  settings?: () => Parameters<GraphStore["status"]>[0];
}

function notFound(): never {
  throw new PsycheError("not_found", "no such entity");
}

function cursorOf(items: { id: string }[], limit: number): string | null {
  return items.length >= limit ? (items.at(-1)?.id ?? null) : null;
}

export function createGraphHandlers(
  graph: GraphStore,
  options: GraphHandlerOptions = {},
): GraphHandlers {
  const refresh = async (...ids: (string | null | undefined)[]) => {
    for (const id of new Set(ids)) {
      if (typeof id === "string") await options.cards?.write(id).catch(() => undefined);
    }
  };
  const etag = async (id: string) => {
    const path = graph.getEntity(id)?.cardPath;
    if (path === null || path === undefined || options.memory === undefined) return "";
    return (await options.memory.readFile(path))?.etag ?? "";
  };
  return {
    async "memory.entities.search"(p) {
      return {
        entities: graph.search(p.q, {
          ...(p.kinds === undefined ? {} : { kinds: p.kinds }),
          ...(p.limit === undefined ? {} : { limit: p.limit }),
        }),
      };
    },

    async "memory.entities.get"(p) {
      const id = graph.resolveMerged(p.id);
      const detail = graph.detail(id, await etag(id));
      if (detail === undefined) notFound();
      return detail;
    },

    async "memory.entities.interactions"(p) {
      const limit = p.limit ?? 50;
      const before = p.cursor === undefined ? undefined : graph.interaction(p.cursor)?.occurredAt;
      const interactions = graph.interactions(graph.resolveMerged(p.id), {
        limit,
        ...(before === undefined ? {} : { before }),
      });
      return { interactions, nextCursor: cursorOf(interactions, limit) };
    },

    async "memory.entities.create"(p) {
      const entity = graph.createEntity({
        kind: p.kind,
        name: p.name,
        ...(p.aliases === undefined ? {} : { aliases: p.aliases }),
        ...(p.identifiers === undefined ? {} : { identifiers: p.identifiers }),
        ...(p.projectStatus === undefined ? {} : { projectStatus: p.projectStatus }),
        source: "owner",
        linkedBy: "owner",
        verified: true,
      });
      await refresh(entity.id);
      return { entity: graph.getEntity(entity.id) ?? entity };
    },

    async "memory.entities.update"(p) {
      if (p.etag !== undefined && p.etag !== (await etag(p.id))) {
        throw new PsycheError("conflict", "the card changed since it was read");
      }
      const before = graph.getEntity(p.id);
      if (before === undefined) notFound();
      const entity = graph.updateEntity(p.id, {
        ...(p.name === undefined ? {} : { name: p.name }),
        ...(p.aliases === undefined ? {} : { aliases: p.aliases }),
        ...(p.status === undefined ? {} : { status: p.status }),
        ...(p.projectStatus === undefined ? {} : { projectStatus: p.projectStatus }),
        ...(p.pinned === undefined ? {} : { pinned: p.pinned }),
        ...(p.hidden === undefined ? {} : { hidden: p.hidden }),
      });
      if (entity.hidden || entity.status !== "active")
        await options.cards?.remove(entity.cardPath ?? null);
      else await refresh(entity.id);
      return { entity: graph.getEntity(entity.id) ?? entity };
    },

    async "memory.entities.facts.set"(p) {
      const result = graph.setFact({
        entityId: p.entityId,
        attribute: p.attribute,
        value: p.value,
        provenance: "owner",
        // The owner's write confirms the value, even one Contacts already had (entity recall).
        source: p.source ?? { kind: "owner_edit" },
      });
      if (result === undefined)
        throw new PsycheError("policy_denied", "that fact cannot be stored");
      await refresh(p.entityId);
      return result;
    },

    async "memory.entities.facts.retract"(p) {
      const fact = graph.retractFact(p.factId, p.source);
      await refresh(fact.entityId);
      return { fact };
    },

    async "memory.entities.edges.set"(p) {
      const result = graph.setEdge({
        src: p.src,
        rel: p.rel,
        dst: p.dst,
        provenance: "owner",
        ...(p.label === undefined ? {} : { label: p.label }),
        source: p.source ?? { kind: "owner_edit" },
      });
      if (result === undefined)
        throw new PsycheError("policy_denied", "that relation cannot be stored");
      await refresh(p.src, p.dst);
      return result;
    },

    async "memory.entities.edges.retract"(p) {
      const edge = graph.retractEdge(p.edgeId, p.source);
      await refresh(edge.src, edge.dst);
      return { edge };
    },

    async "memory.entities.history"(p) {
      return graph.history(graph.resolveMerged(p.entityId), p.attribute);
    },

    async "memory.entities.merge"(p) {
      const dryRun = p.dryRun === true;
      const removed = dryRun
        ? []
        : p.ids.filter((id) => id !== p.into).map((id) => graph.getEntity(id)?.cardPath ?? null);
      const result = graph.merge(p.ids, p.into, dryRun);
      if (!dryRun) {
        for (const path of removed) await options.cards?.remove(path);
        await refresh(p.into);
      }
      return result;
    },

    async "memory.entities.split"(p) {
      const result = graph.split(p.id, p.identifiers, p.name, p.dryRun === true);
      if (p.dryRun !== true) await refresh(p.id, result.entity.id);
      return result;
    },

    async "memory.entities.suggestions"(p) {
      return { suggestions: graph.suggestions(p.status === undefined ? ["pending"] : [p.status]) };
    },

    async "memory.entities.suggestions.answer"(p) {
      const before = graph.getSuggestion(p.id);
      const paths =
        before?.kind === "merge"
          ? before.entityIds.slice(1).map((id) => graph.getEntity(id)?.cardPath ?? null)
          : [];
      const result = graph.answerSuggestion(p.id, p.answer);
      if (p.answer === "accept") {
        for (const path of paths) await options.cards?.remove(path);
        await refresh(result.entity?.id, ...(before?.entityIds ?? []));
      }
      return result;
    },

    async "memory.entities.forget"(p) {
      const dryRun = p.dryRun === true;
      const result = graph.forget(p.id, dryRun);
      if (!dryRun) {
        await options.cards?.remove(result.cardPath);
        // Mentions of the person in notes go too (the UI showed the dry-run counts first).
        const name = result.names[0];
        if (options.memory !== undefined && name !== undefined && name.trim().length >= 3) {
          await options.memory.forget(name).catch(() => undefined);
        }
      }
      return { removed: result.removed, cardPath: result.cardPath, dryRun };
    },

    async "memory.loops.list"(p) {
      const limit = p.limit ?? 100;
      const loops = graph.loops({
        ...(p.status === undefined ? {} : { status: p.status }),
        ...(p.direction === undefined ? {} : { direction: p.direction }),
        ...(p.entityId === undefined ? {} : { entityId: p.entityId }),
        ...(p.projectId === undefined ? {} : { projectId: p.projectId }),
        ...(p.dueBefore === undefined ? {} : { dueBefore: p.dueBefore }),
        ...(p.cursor === undefined ? {} : { after: p.cursor }),
        limit,
      });
      return { loops, nextCursor: cursorOf(loops, limit) };
    },

    async "memory.loops.update"(p) {
      const loop = graph.updateLoop(p.id, {
        ...(p.status === undefined ? {} : { status: p.status }),
        ...(p.dueAt === undefined ? {} : { dueAt: p.dueAt }),
        ...(p.text === undefined ? {} : { text: p.text }),
      });
      await refresh(loop.counterpartId, loop.projectId);
      return { loop };
    },

    async "memory.graph.status"() {
      return graph.status(options.settings?.() ?? { enabled: false, sources: {} });
    },

    async "memory.graph.forgetAll"(p) {
      if (p.confirm !== "forget everything")
        throw new PsycheError("invalid_params", 'confirm must be "forget everything"');
      const result = graph.forgetAll(p.dryRun === true);
      if (!result.dryRun) for (const path of result.cardPaths) await options.cards?.remove(path);
      return result;
    },

    async "memory.graph.deleteSource"(p) {
      const result = graph.deleteSource(p.source, p.dryRun === true);
      if (!result.dryRun) for (const path of result.cardPaths) await options.cards?.remove(path);
      return result;
    },

    async "memory.graph.blocklist.list"() {
      return { entries: graph.blocklist() };
    },

    async "memory.graph.blocklist.add"(p) {
      return { entry: graph.block(p.kind, p.value) };
    },

    async "memory.graph.blocklist.remove"(p) {
      return { removed: graph.unblockId(p.id) };
    },
  };
}
