import {
  type EventName,
  type EventPayload,
  type GraphEntity,
  type GraphFact,
  type MethodName,
  type MethodParams,
  PsycheError,
} from "@psyche/protocol";
import { type GraphWorld, graphDetail, graphSummary } from "../fixtures/people.ts";

/**
 * The people-and-projects methods of the MockGateway (docs/memory/people-and-projects-2026.md
 * §6.1), over a fixture `GraphWorld`: search, the card, owner facts, loops, pin and status,
 * suggestions, merge and forget (with dry runs) and status. Writes emit `memory.entity.updated`
 * or `memory.loop.updated` like the Gateway.
 */

/** A graph with nothing in it (worlds without people fixtures). */
export function emptyGraph(): GraphWorld {
  return {
    entities: [],
    identifiers: [],
    facts: [],
    edges: [],
    interactions: [],
    loops: [],
    suggestions: [],
    notes: {},
    blocklist: [],
    status: {
      enabled: false,
      sources: [],
      counts: { people: 0, orgs: 0, projects: 0, places: 0, openLoops: 0, pendingSuggestions: 0 },
      lastModelPassAt: null,
      budget: { entitiesUsed: 0, tokensUsed: 0, maxEntities: 0, maxTokens: 0 },
      loopPrecision: [],
    },
  };
}

export interface GraphMockContext {
  graph: () => GraphWorld;
  now: () => string;
  emit: <E extends EventName>(event: E, payload: EventPayload<E>) => void;
  /** The settings store, for turning `memory.graph` (or one source) off like the Gateway. */
  settings?: () => Record<string, unknown>;
}

const GRAPH_KEY = "memory.graph";

/** "sam@acme.com" → "s•••@acme.com"; phones keep their last two digits; domains show whole. */
export function maskHint(kind: "email" | "phone" | "domain", value: string): string {
  if (kind === "domain") return value.toLowerCase();
  if (kind === "phone") return `•••${value.replace(/\D/g, "").slice(-2)}`;
  const [user = "", domain = ""] = value.toLowerCase().split("@");
  return `${user.slice(0, 1)}•••@${domain}`;
}

type Handlers = { [M in MethodName]?: (params: MethodParams<M>) => unknown };

const notFound = (what: string): never => {
  throw new PsycheError("not_found", `${what} not found`);
};

function matches(world: GraphWorld, e: GraphEntity, q: string): boolean {
  if (q === "") return true;
  const needle = q.toLowerCase();
  return (
    e.name.toLowerCase().includes(needle) ||
    e.aliases.some((a) => a.toLowerCase().includes(needle)) ||
    world.identifiers.some((i) => i.entityId === e.id && i.value.toLowerCase().includes(needle))
  );
}

export function graphHandlers(ctx: GraphMockContext): Handlers {
  const entityOf = (id: string) =>
    ctx.graph().entities.find((e) => e.id === id) ?? notFound(`entity ${id}`);
  const touched = (e: GraphEntity, changed: string[]) => {
    e.updatedAt = ctx.now();
    ctx.emit("memory.entity.updated", { id: e.id, kind: e.kind, changed });
  };
  const forgetCounts = (id: string) => {
    const w = ctx.graph();
    return {
      identifiers: w.identifiers.filter((i) => i.entityId === id).length,
      facts: w.facts.filter((f) => f.entityId === id).length,
      edges: w.edges.filter((x) => x.src === id || x.dst === id).length,
      interactions: w.interactions.filter((i) => i.participants.some((p) => p.entityId === id))
        .length,
      loops: w.loops.filter((l) => l.counterpartId === id || l.projectId === id).length,
    };
  };

  return {
    "memory.entities.search": (p) => {
      const w = ctx.graph();
      const rank = (e: GraphEntity) =>
        (e.name.toLowerCase().startsWith(p.q.toLowerCase()) ? 2 : 0) + (e.pinned ? 1 : 0);
      return {
        entities: w.entities
          .filter(
            (e) =>
              e.status === "active" && (!p.kinds || p.kinds.includes(e.kind)) && matches(w, e, p.q),
          )
          .sort((a, b) => rank(b) - rank(a))
          .slice(0, p.limit ?? 20)
          .map((e) => graphSummary(w, e)),
      };
    },
    "memory.entities.get": (p) => graphDetail(ctx.graph(), p.id) ?? notFound(`entity ${p.id}`),
    "memory.entities.update": (p) => {
      const e = entityOf(p.id);
      const changed: string[] = [];
      if (p.name !== undefined) e.name = p.name;
      if (p.aliases !== undefined) e.aliases = p.aliases;
      if (p.status !== undefined) e.status = p.status;
      if (p.projectStatus !== undefined) {
        e.projectStatus = p.projectStatus;
        changed.push("status");
      }
      if (p.pinned !== undefined) {
        e.pinned = p.pinned;
        changed.push("pinned");
      }
      if (p.hidden !== undefined) e.hidden = p.hidden;
      touched(e, changed);
      return { entity: e };
    },
    "memory.entities.facts.set": (p) => {
      const w = ctx.graph();
      const e = entityOf(p.entityId);
      const now = ctx.now();
      const previous = w.facts.find(
        (f) =>
          f.entityId === e.id &&
          f.attribute === p.attribute &&
          f.supersededBy == null &&
          f.retractedAt == null,
      );
      const fact: GraphFact = {
        id: `fact_owner_${w.facts.length + 1}`,
        entityId: e.id,
        attribute: p.attribute,
        value: p.value,
        provenance: "owner",
        confidence: 1,
        sources: p.source?.ref ? [p.source.ref] : [],
        evidence: null,
        validFrom: now,
        validTo: null,
        recordedAt: now,
        supersededBy: null,
        retractedAt: null,
      };
      if (previous) previous.supersededBy = fact.id;
      w.facts.push(fact);
      touched(e, ["facts"]);
      return { fact, superseded: previous?.id ?? null };
    },
    "memory.entities.facts.retract": (p) => {
      const w = ctx.graph();
      const fact = w.facts.find((f) => f.id === p.factId) ?? notFound(`fact ${p.factId}`);
      fact.retractedAt = ctx.now();
      touched(entityOf(fact.entityId), ["facts"]);
      return { fact };
    },
    "memory.loops.list": (p) => {
      const statuses = p.status ?? ["suggested", "open"];
      return {
        loops: ctx
          .graph()
          .loops.filter(
            (l) =>
              statuses.includes(l.status) &&
              (!p.direction || l.direction === p.direction) &&
              (!p.entityId || l.counterpartId === p.entityId) &&
              (!p.projectId || l.projectId === p.projectId),
          )
          .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)),
        nextCursor: null,
      };
    },
    "memory.loops.update": (p) => {
      const loop = ctx.graph().loops.find((l) => l.id === p.id) ?? notFound(`loop ${p.id}`);
      if (p.status !== undefined) {
        loop.status = p.status;
        const closed = p.status === "done" || p.status === "dismissed";
        loop.closedAt = closed ? ctx.now() : null;
        loop.closedBy = closed ? "owner" : null;
      }
      if (p.dueAt !== undefined) loop.dueAt = p.dueAt;
      if (p.text !== undefined) loop.text = p.text;
      ctx.emit("memory.loop.updated", { loop });
      return { loop };
    },
    "memory.entities.suggestions": (p) => ({
      suggestions: ctx.graph().suggestions.filter((s) => s.status === (p.status ?? "pending")),
    }),
    "memory.entities.suggestions.answer": (p) => {
      const s =
        ctx.graph().suggestions.find((x) => x.id === p.id) ?? notFound(`suggestion ${p.id}`);
      s.status = p.answer === "accept" ? "accepted" : p.answer === "reject" ? "rejected" : "later";
      const first = s.entityIds[0];
      return {
        suggestion: s,
        entity: p.answer === "accept" && first ? entityOf(first) : null,
      };
    },
    "memory.entities.merge": (p) => {
      const into = entityOf(p.into);
      const w = ctx.graph();
      const from = p.ids.filter((id) => id !== p.into);
      const movedIdentifiers = w.identifiers.filter((i) => from.includes(i.entityId)).length;
      const movedFacts = w.facts.filter((f) => from.includes(f.entityId)).length;
      if (!p.dryRun) {
        for (const i of w.identifiers) if (from.includes(i.entityId)) i.entityId = into.id;
        for (const f of w.facts) if (from.includes(f.entityId)) f.entityId = into.id;
        for (const e of w.entities)
          if (from.includes(e.id)) {
            e.status = "merged";
            e.mergedInto = into.id;
          }
        touched(into, ["merged"]);
      }
      return { entity: into, movedIdentifiers, movedFacts, dryRun: p.dryRun === true };
    },
    "memory.entities.forget": (p) => {
      const e = entityOf(p.id);
      const removed = forgetCounts(e.id);
      if (!p.dryRun) {
        const w = ctx.graph();
        w.entities = w.entities.filter((x) => x.id !== e.id);
        w.identifiers = w.identifiers.filter((i) => i.entityId !== e.id);
        w.facts = w.facts.filter((f) => f.entityId !== e.id);
        w.edges = w.edges.filter((x) => x.src !== e.id && x.dst !== e.id);
        w.loops = w.loops.filter((l) => l.counterpartId !== e.id && l.projectId !== e.id);
        w.interactions = w.interactions.filter(
          (i) => !i.participants.some((x) => x.entityId === e.id),
        );
        ctx.emit("memory.entity.updated", { id: e.id, kind: e.kind, changed: ["forgotten"] });
      }
      return { removed, cardPath: e.cardPath ?? null, dryRun: p.dryRun === true };
    },
    "memory.graph.status": () => ctx.graph().status,

    "memory.graph.blocklist.list": () => ({ entries: ctx.graph().blocklist }),
    "memory.graph.blocklist.add": (p) => {
      const w = ctx.graph();
      const entry = {
        id: `blk_${w.blocklist.length + 1}_${p.kind}`,
        kind: p.kind,
        hint: maskHint(p.kind, p.value),
        createdAt: ctx.now(),
      };
      w.blocklist.push(entry);
      return { entry };
    },
    "memory.graph.blocklist.remove": (p) => {
      const w = ctx.graph();
      const before = w.blocklist.length;
      w.blocklist = w.blocklist.filter((e) => e.id !== p.id);
      return { removed: w.blocklist.length < before };
    },
    "memory.graph.deleteSource": (p) => {
      const w = ctx.graph();
      // Fixture interactions carry "mail" / "calendar" / "messages"; identifiers carry their source.
      const gone = new Set(w.interactions.filter((i) => i.source === p.source).map((i) => i.id));
      const facts = w.facts.filter(
        (f) =>
          f.provenance !== "owner" && f.sources.length > 0 && f.sources.every((s) => gone.has(s)),
      );
      const loops = w.loops.filter(
        (l) => l.sourceInteractionId != null && gone.has(l.sourceInteractionId),
      );
      const identifiers = w.identifiers.filter((i) => i.source === p.source);
      const factIds = new Set(facts.map((f) => f.id));
      const keeps = (id: string) =>
        w.interactions.some(
          (i) => !gone.has(i.id) && i.participants.some((x) => x.entityId === id),
        ) ||
        w.facts.some((f) => f.entityId === id && !factIds.has(f.id)) ||
        w.identifiers.some((i) => i.entityId === id && i.source !== p.source);
      const entities = w.entities.filter((e) => !e.isOwner && e.kind !== "project" && !keeps(e.id));
      const removed = {
        entities: entities.length,
        identifiers: identifiers.length,
        facts: facts.length,
        interactions: gone.size,
        loops: loops.length,
      };
      const cardPaths = entities
        .map((e) => e.cardPath)
        .filter((x): x is string => typeof x === "string");
      if (!p.dryRun) {
        const entityIds = new Set(entities.map((e) => e.id));
        w.interactions = w.interactions.filter((i) => !gone.has(i.id));
        w.facts = w.facts.filter((f) => !factIds.has(f.id));
        w.loops = w.loops.filter((l) => !loops.includes(l));
        w.identifiers = w.identifiers.filter((i) => i.source !== p.source);
        w.entities = w.entities.filter((e) => !entityIds.has(e.id));
        const row = w.status.sources.find((x) => x.source === p.source);
        if (row) Object.assign(row, { enabled: false, entities: 0, interactions: 0 });
        const settings = ctx.settings?.();
        const current = settings?.[GRAPH_KEY] as { sources?: Record<string, boolean> } | undefined;
        if (settings && current) {
          const value = { ...current, sources: { ...current.sources, [p.source]: false } };
          settings[GRAPH_KEY] = value;
          ctx.emit("settings.changed", {
            entries: [{ key: GRAPH_KEY, value, updatedAt: ctx.now() }],
          });
        }
      }
      return { removed, cardPaths, dryRun: p.dryRun === true };
    },
    "memory.graph.forgetAll": (p) => {
      const w = ctx.graph();
      const people = w.entities.filter((e) => !e.isOwner);
      const removed = {
        entities: people.length,
        identifiers: w.identifiers.length,
        facts: w.facts.length,
        interactions: w.interactions.length,
        loops: w.loops.length,
      };
      const cardPaths = people
        .map((e) => e.cardPath)
        .filter((x): x is string => typeof x === "string");
      if (!p.dryRun) {
        const owner = w.entities.filter((e) => e.isOwner);
        Object.assign(w, {
          ...emptyGraph(),
          entities: owner,
          status: { ...w.status, enabled: false },
        });
        const settings = ctx.settings?.();
        if (settings) {
          const value = { ...((settings[GRAPH_KEY] as object | undefined) ?? {}), enabled: false };
          settings[GRAPH_KEY] = value;
          ctx.emit("settings.changed", {
            entries: [{ key: GRAPH_KEY, value, updatedAt: ctx.now() }],
          });
        }
      }
      return { removed, cardPaths, dryRun: p.dryRun === true };
    },
  };
}
