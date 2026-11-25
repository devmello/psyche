import {
  type GraphLoop,
  type MethodParams,
  type MethodResult,
  PsycheError,
} from "@psyche/protocol";
import type { SqliteMemoryStore } from "../store.ts";
import type { CardSync } from "./cards.ts";
import {
  type LoopViewer,
  type LoopVisibility,
  loopsForViewer,
  scrubLoopForRemote,
} from "./loop-visibility.ts";
import type { GraphStore } from "./store.ts";

export {
  backfillLoopRemoteVisible,
  createLoopVisibility,
  type LoopViewer,
  type LoopVisibility,
  loopForViewer,
  loopsForViewer,
  markLoopRemoteVisible,
  REMOTE_LOOP_VIEWER,
  scrubLoopForRemote,
} from "./loop-visibility.ts";

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
  | "memory.entities.timeline"
  | "memory.anchors.list"
  | "memory.anchors.add"
  | "memory.anchors.remove"
  | "memory.entities.merge"
  | "memory.entities.split"
  | "memory.entities.suggestions"
  | "memory.entities.suggestions.answer"
  | "memory.entities.forget"
  | "memory.loops.list"
  | "memory.loops.update"
  | "memory.graph.status"
  | "memory.graph.map"
  | "memory.graph.forgetAll"
  | "memory.graph.deleteSource"
  | "memory.graph.blocklist.list"
  | "memory.graph.blocklist.add"
  | "memory.graph.blocklist.remove";

/**
 * `viewer` is read by `memory.loops.*` and `memory.entities.get` (its open loops): a caller that
 * is not the desktop shell passes `{ full: false }` and gets the remote scrub of the promise
 * ledger (docs/design/promise-ledger-2026.md section 7.2). Left out, the call is an in-process one
 * and sees everything; the Gateway always passes it for a connection.
 */
export type GraphHandlers = {
  [M in GraphMethod]: (params: MethodParams<M>, viewer?: LoopViewer) => Promise<MethodResult<M>>;
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
  "memory.entities.timeline",
  "memory.anchors.list",
  "memory.anchors.add",
  "memory.anchors.remove",
  "memory.entities.merge",
  "memory.entities.split",
  "memory.entities.suggestions",
  "memory.entities.suggestions.answer",
  "memory.entities.forget",
  "memory.loops.list",
  "memory.loops.update",
  "memory.graph.status",
  "memory.graph.map",
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
  /** Which loops a remote viewer may see; without it a remote viewer sees none (fail closed). */
  loopVisibility?: LoopVisibility;
}

function notFound(): never {
  throw new PsycheError("not_found", "no such entity");
}

/** How many rows a remote viewer's list reads at a time, and how many reads at most. */
const SCAN_PAGE = 200;
const MAX_SCAN_PAGES = 50;

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

    async "memory.entities.get"(p, viewer) {
      const id = graph.resolveMerged(p.id);
      const detail = graph.detail(id, await etag(id));
      if (detail === undefined) notFound();
      if (viewer === undefined || viewer.full) return detail;
      return {
        ...detail,
        openLoops: loopsForViewer(detail.openLoops, viewer, options.loopVisibility),
      };
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
        ...(p.dueAt === undefined ? {} : { dueAt: p.dueAt }),
        ...(p.projectType === undefined ? {} : { projectType: p.projectType }),
        ...(p.private === undefined ? {} : { private: p.private }),
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
        ...(p.dueAt === undefined ? {} : { dueAt: p.dueAt }),
        ...(p.projectType === undefined ? {} : { projectType: p.projectType }),
        ...(p.private === undefined ? {} : { private: p.private }),
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

    async "memory.entities.timeline"(p) {
      return graph.timeline(p.entityId, {
        ...(p.before === undefined ? {} : { before: p.before }),
        ...(p.limit === undefined ? {} : { limit: p.limit }),
      });
    },

    async "memory.anchors.list"(p) {
      return {
        anchors: graph.anchors({
          ...(p.entityId === undefined ? {} : { entityId: p.entityId }),
          ...(p.kind === undefined ? {} : { kind: p.kind }),
        }),
      };
    },

    // Admin scope: the extraction principal can never redirect signals (W6).
    async "memory.anchors.add"(p) {
      const anchor = graph.addAnchor({
        entityId: p.entityId,
        kind: p.kind,
        ref: p.ref,
        ...(p.label === undefined ? {} : { label: p.label }),
        addedBy: "owner",
      });
      return { anchor };
    },

    async "memory.anchors.remove"(p) {
      return { removed: graph.removeAnchor(p.id) };
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

    async "memory.loops.list"(p, viewer) {
      const limit = p.limit ?? 100;
      const filter = {
        ...(p.status === undefined ? {} : { status: p.status }),
        ...(p.direction === undefined ? {} : { direction: p.direction }),
        ...(p.entityId === undefined ? {} : { entityId: p.entityId }),
        ...(p.projectId === undefined ? {} : { projectId: p.projectId }),
        ...(p.dueBefore === undefined ? {} : { dueBefore: p.dueBefore }),
      };
      if (viewer === undefined || viewer.full) {
        const loops = graph.loops({
          ...filter,
          ...(p.cursor === undefined ? {} : { after: p.cursor }),
          limit,
        });
        return { loops, nextCursor: cursorOf(loops, limit) };
      }
      // A remote viewer pages over the visible rows only: the cursor is the id of the last loop
      // it was given, never of one it may not know exists. Hidden rows are skipped, not counted.
      const shown: GraphLoop[] = [];
      let after = p.cursor;
      let more = true;
      for (let i = 0; i < MAX_SCAN_PAGES && shown.length < limit && more; i += 1) {
        const page = graph.loops({
          ...filter,
          ...(after === undefined ? {} : { after }),
          limit: SCAN_PAGE,
        });
        more = page.length >= SCAN_PAGE;
        for (const l of loopsForViewer(page, viewer, options.loopVisibility)) {
          if (shown.length < limit) shown.push(l);
        }
        const last = page.at(-1);
        if (last === undefined) break;
        after = last.id;
      }
      return {
        loops: shown,
        nextCursor: shown.length >= limit ? (shown.at(-1)?.id ?? null) : null,
      };
    },

    async "memory.loops.update"(p, viewer) {
      const remote = viewer !== undefined && !viewer.full;
      // A hidden loop is unknown to a remote viewer: nothing is written, and the answer is the
      // one for an id that does not exist.
      if (remote && options.loopVisibility?.remoteVisible([p.id]).has(p.id) !== true)
        throw new PsycheError("not_found", "no such loop");
      const loop = graph.updateLoop(p.id, {
        ...(p.status === undefined ? {} : { status: p.status }),
        ...(p.dueAt === undefined ? {} : { dueAt: p.dueAt }),
        ...(p.text === undefined ? {} : { text: p.text }),
      });
      await refresh(loop.counterpartId, loop.projectId);
      return { loop: remote ? scrubLoopForRemote(loop) : loop };
    },

    async "memory.graph.status"() {
      return graph.status(options.settings?.() ?? { enabled: false, sources: {} });
    },

    async "memory.graph.map"(p) {
      return graph.memoryMap({
        ...(p.limit === undefined ? {} : { limit: p.limit }),
        ...(p.kinds === undefined ? {} : { kinds: p.kinds }),
      });
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
