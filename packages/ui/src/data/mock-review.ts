import {
  type GraphFact,
  type MemoryRun,
  type MethodName,
  type MethodParams,
  PsycheError,
  type QuarantineItem,
  type ReviewItem,
} from "@psyche/protocol";

/**
 * The everything-memory review methods of the MockGateway (`memory.review.*`,
 * `memory.quarantine.*`, `memory.runs.list`) over a fixture `ReviewWorld`: decisions move a fact's
 * `review` state like the Gateway does, so the Review pane can be exercised without a server.
 */

export interface ReviewWorld {
  items: ReviewItem[];
  quarantine: QuarantineItem[];
  runs: MemoryRun[];
}

export function emptyReview(): ReviewWorld {
  return { items: [], quarantine: [], runs: [] };
}

type Handlers = { [M in MethodName]?: (params: MethodParams<M>) => unknown };

export function reviewHandlers(ctx: { world: () => ReviewWorld; now: () => string }): Handlers {
  const find = (id: string): ReviewItem => {
    const item = ctx.world().items.find((i) => i.fact.id === id);
    if (item === undefined) throw new PsycheError("not_found", "no such fact");
    return item;
  };
  const setReview = (fact: GraphFact, review: NonNullable<GraphFact["review"]>) => {
    fact.review = review;
  };
  const counts = () => {
    const w = ctx.world();
    const n = (state: string) => w.items.filter((i) => i.fact.review === state).length;
    return {
      pending: n("pending"),
      autoAccepted: n("auto_accepted"),
      quarantined: w.quarantine.filter((q) => q.decided === null).length,
    };
  };
  return {
    "memory.review.list": (p) => {
      const states = p.state ?? ["pending"];
      const items = ctx
        .world()
        .items.filter((i) => states.includes(i.fact.review ?? "accepted"))
        .filter((i) => p.entityId === undefined || i.fact.entityId === p.entityId);
      return { items: items.slice(0, p.limit ?? 50), counts: counts(), nextCursor: null };
    },
    "memory.review.decide": (p) => {
      const facts: GraphFact[] = [];
      for (const id of p.factIds) {
        const item = find(id);
        if (item.fact.review !== "pending")
          throw new PsycheError("conflict", "not waiting for review");
        if (p.decision === "edit") {
          item.fact.value = p.value ?? item.fact.value;
          item.fact.provenance = "owner";
          setReview(item.fact, "edited");
        } else setReview(item.fact, p.decision === "confirm" ? "accepted" : "discarded");
        facts.push(item.fact);
      }
      return { facts };
    },
    "memory.review.undo": (p) => {
      const item = find(p.factId);
      if (item.fact.review !== "auto_accepted")
        throw new PsycheError("conflict", "only auto-accepted facts can be undone");
      setReview(item.fact, "discarded");
      return { fact: item.fact };
    },
    "memory.quarantine.list": (p) => ({
      items: ctx.world().quarantine.filter((q) => p.includeDecided === true || q.decided === null),
      nextCursor: null,
    }),
    "memory.quarantine.decide": (p) => {
      const q = ctx.world().quarantine.find((x) => x.id === p.id);
      if (q === undefined) throw new PsycheError("not_found", "no such item");
      q.decided =
        p.action === "release" ? "released" : p.action === "discard" ? "discarded" : "blocked";
      q.decidedAt = ctx.now();
      return { item: q };
    },
    "memory.runs.list": (p) => ({ runs: ctx.world().runs.slice(0, p.limit ?? 14) }),
  };
}
