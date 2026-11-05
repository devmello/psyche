import {
  type EventName,
  type EventPayload,
  type GraphAnchor,
  type GraphCitationSource,
  type GraphEdge,
  type GraphEntity,
  type GraphFact,
  type GraphInteraction,
  type GraphTimelineRow,
  type GraphWorkStatus,
  type MethodName,
  type MethodParams,
  type Provenance,
  PsycheError,
  type WorkHistoryEntry,
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
    anchors: [],
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

// --- work items (docs/design/memory-everything-2026.md §3) ---------------------------------------

const WORK_STATUSES: readonly string[] = [
  "not_started",
  "in_progress",
  "submitted",
  "done",
  "dropped",
];
const WORK_KINDS: readonly string[] = ["project", "assignment", "event"];
/** The facts the timeline draws as history. */
const WORK_FACTS: readonly string[] = [
  "status",
  "deadline",
  "next_step",
  "stopped_at",
  "progress",
  "blocked_on",
];
/** The facts that say the owner was at work on the item (they refresh `lastSignalAt`). */
const SIGNAL_FACTS: readonly string[] = ["progress", "stopped_at", "next_step", "blocked_on"];
const STATUS_WORDS: Record<string, string> = {
  not_started: "not started",
  in_progress: "in progress",
  submitted: "handed in",
  done: "done",
  dropped: "dropped",
};
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** An ISO instant, or null when the text is not a date (the store keeps such a deadline as text). */
function isoOrNull(value: string): string | null {
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

function shortDate(value: string): string {
  const iso = isoOrNull(value);
  if (iso === null) return value;
  const d = new Date(iso);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

const SOURCE_OF: Partial<Record<GraphInteraction["kind"], GraphCitationSource>> = {
  mail: "mail",
  message: "messages",
  call: "messages",
  meeting: "calendar",
  note: "notes",
  chat: "chats",
  file: "files",
  reminder: "reminders",
};

function interactionProvenance(i: GraphInteraction): Provenance {
  if (i.kind === "task" || i.kind === "work") return "agent";
  if (i.kind === "note" || i.kind === "chat" || i.kind === "file" || i.kind === "reminder")
    return "owner";
  return i.direction === "out" ? "owner" : "untrusted";
}

/** The row text the store builds from templates, titles as data (§3.5). */
function interactionText(i: GraphInteraction): string {
  const title = i.subject ?? "";
  const quoted = title === "" ? "" : `: “${title}”`;
  switch (i.kind) {
    case "mail":
      return i.direction === "out" ? `You sent mail${quoted}` : `New mail${quoted}`;
    case "message":
    case "call":
      return i.direction === "out" ? `You messaged${quoted}` : `New message${quoted}`;
    case "meeting":
      return `Meeting${quoted}`;
    case "note":
      return `Note${quoted}`;
    case "chat":
      return i.gist ? `Chat: ${i.gist}` : `Chat with Psyche${quoted}`;
    case "file":
      return title === "" ? "Edited files" : `Edited ${title}`;
    case "reminder":
      return `Reminders${quoted}`;
    default:
      return title === "" ? "Psyche worked on this" : `Psyche worked on this${quoted}`;
  }
}

function factText(f: GraphFact, prior: GraphFact | undefined): string {
  const value = f.attribute === "deadline" ? shortDate(f.value) : f.value;
  switch (f.attribute) {
    case "deadline":
      return prior === undefined
        ? `Due ${value}`
        : `Due date moved ${shortDate(prior.value)} → ${value}`;
    case "status":
      return prior === undefined
        ? `Marked ${STATUS_WORDS[f.value] ?? f.value}`
        : `Status ${STATUS_WORDS[prior.value] ?? prior.value} → ${STATUS_WORDS[f.value] ?? f.value}`;
    case "progress":
      return `Progress: ${value}`;
    case "stopped_at":
      return `Stopped at ${value}`;
    case "next_step":
      return `Next step: ${value}`;
    default:
      return `Blocked on ${value}`;
  }
}

/** `memory.entities.timeline`: interactions, work-fact history and loops, newest first (§3.5). */
function timelineOf(
  w: GraphWorld,
  id: string,
  before: string | undefined,
  limit: number,
): { rows: GraphTimelineRow[]; nextBefore: string | null } {
  const root = w.entities.find((e) => e.id === id) ?? notFound(`entity ${id}`);
  const owners = new Set([id]);
  if (root.kind === "project")
    for (const x of w.edges)
      if (x.dst === id && x.rel === "part_of" && x.supersededBy == null && x.retractedAt == null)
        owners.add(x.src);
  const keep = (at: string) => before === undefined || at < before;
  const nameOf = (eid: string) => w.entities.find((e) => e.id === eid)?.name;
  const rows: GraphTimelineRow[] = [];

  for (const i of w.interactions) {
    const owner = i.projectId != null && owners.has(i.projectId) ? i.projectId : undefined;
    if (owner === undefined || !keep(i.occurredAt)) continue;
    const source = SOURCE_OF[i.kind];
    const sender = i.participants.find((p) => p.role === "from");
    rows.push({
      id: i.id,
      at: i.occurredAt,
      kind: "interaction",
      interactionKind: i.kind,
      entityId: owner,
      text: interactionText(i),
      provenance: interactionProvenance(i),
      chip:
        source === undefined
          ? null
          : {
              source,
              label: (sender && nameOf(sender.entityId)) || i.source,
              citationId: null,
              link: i.link ?? null,
            },
    });
  }

  for (const owner of owners) {
    const facts = w.facts
      .filter(
        (f) =>
          f.entityId === owner &&
          WORK_FACTS.includes(f.attribute) &&
          f.retractedAt == null &&
          keep(f.recordedAt),
      )
      .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
    for (const f of facts) {
      const prior = w.facts.find((x) => x.supersededBy === f.id);
      const ref = f.sources[0];
      const from = ref ? w.interactions.find((i) => i.id === ref) : undefined;
      const source = from ? SOURCE_OF[from.kind] : undefined;
      const sender = from?.participants.find((p) => p.role === "from");
      rows.push({
        id: f.id,
        at: f.recordedAt,
        kind: "fact",
        entityId: owner,
        text: factText(f, prior),
        provenance: f.provenance,
        change: { attribute: f.attribute, from: prior?.value ?? null, to: f.value },
        chip:
          source === undefined || from === undefined
            ? null
            : {
                source,
                label: (sender && nameOf(sender.entityId)) || from.source,
                citationId: null,
                link: from.link ?? null,
              },
      });
    }
  }

  for (const l of w.loops) {
    if (!l.projectId || !owners.has(l.projectId) || !keep(l.createdAt)) continue;
    if (l.status !== "open" && l.status !== "snoozed" && l.status !== "done") continue;
    const who = l.counterpartId ? nameOf(l.counterpartId) : undefined;
    const lead =
      l.direction === "waiting_on"
        ? who
          ? `Waiting on ${who}`
          : "Waiting on a reply"
        : who
          ? `You owe ${who}`
          : "You owe";
    rows.push({
      id: l.id,
      at: l.createdAt,
      kind: "loop",
      entityId: l.projectId,
      text: `${lead}: ${l.text}${l.status === "done" ? " (done)" : ""}`,
      provenance: l.provenance,
      chip: null,
    });
  }

  rows.sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id));
  const page = rows.slice(0, limit);
  return { rows: page, nextBefore: rows.length > limit ? (page.at(-1)?.at ?? null) : null };
}

export function graphHandlers(ctx: GraphMockContext): Handlers {
  /** An owner (or rule) fact: supersede the last value, update what the row caches, start work. */
  const setOwnerFact = (
    e: GraphEntity,
    attribute: GraphFact["attribute"],
    value: string,
    provenance: GraphFact["provenance"] = "owner",
    sources: string[] = [],
  ) => {
    const w = ctx.graph();
    const now = ctx.now();
    const single = attribute !== "progress";
    const previous = single
      ? w.facts.find(
          (f) =>
            f.entityId === e.id &&
            f.attribute === attribute &&
            f.supersededBy == null &&
            f.retractedAt == null,
        )
      : undefined;
    const fact: GraphFact = {
      id: `fact_owner_${w.facts.length + 1}`,
      entityId: e.id,
      attribute,
      value,
      provenance,
      confidence: 1,
      sources,
      evidence: null,
      validFrom: now,
      validTo: null,
      recordedAt: now,
      supersededBy: null,
      retractedAt: null,
    };
    if (previous) previous.supersededBy = fact.id;
    w.facts.push(fact);
    if (WORK_KINDS.includes(e.kind) && provenance !== "untrusted") {
      if (attribute === "status" && e.kind === "assignment")
        e.workStatus = value as GraphWorkStatus;
      if (attribute === "deadline") {
        const iso = isoOrNull(value);
        if (iso !== null) e.dueAt = iso;
      }
      if (SIGNAL_FACTS.includes(attribute)) e.lastSignalAt = now;
      // Real work on a not-started assignment starts it (§3.4).
      if (
        e.kind === "assignment" &&
        e.workStatus === "not_started" &&
        (attribute === "progress" || attribute === "stopped_at")
      )
        setOwnerFact(e, "status", "in_progress", "system");
    }
    return { fact, superseded: previous?.id ?? null };
  };
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
    "memory.entities.create": (p) => {
      const w = ctx.graph();
      const now = ctx.now();
      const work = WORK_KINDS.includes(p.kind);
      const dueAt = p.dueAt === undefined ? null : isoOrNull(p.dueAt);
      if (p.dueAt !== undefined && dueAt === null)
        throw new PsycheError("invalid_params", "dueAt must be a date and time");
      if (dueAt !== null && !work)
        throw new PsycheError("invalid_params", "only a project, to-do or event has a due date");
      const entity: GraphEntity = {
        id: `ent_new_${w.entities.length + 1}`,
        kind: p.kind,
        name: p.name,
        aliases: p.aliases ?? [],
        status: "active",
        mergedInto: null,
        isOwner: false,
        pinned: false,
        hidden: false,
        ...(p.kind === "project" ? { projectStatus: p.projectStatus ?? "active" } : {}),
        dueAt,
        ...(p.kind === "project" ? { projectType: p.projectType ?? "project" } : {}),
        ...(p.kind === "assignment" ? { workStatus: "not_started" as const } : {}),
        // Making a work item is the owner saying it exists: it starts fresh, not stale.
        ...(p.kind === "project" || p.kind === "assignment" ? { lastSignalAt: now } : {}),
        ...(p.private === true && work ? { private: true } : {}),
        summary: null,
        summaryAt: null,
        lastInteractionAt: null,
        cardPath: null,
        createdAt: now,
        updatedAt: now,
      };
      w.entities.push(entity);
      if (dueAt !== null && p.kind !== "event") setOwnerFact(entity, "deadline", dueAt);
      ctx.emit("memory.entity.updated", { id: entity.id, kind: entity.kind, changed: ["created"] });
      return { entity };
    },
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
      if (p.dueAt !== undefined) {
        if (!WORK_KINDS.includes(e.kind))
          throw new PsycheError("invalid_params", "only a work item has a due date");
        if (p.dueAt === null) {
          e.dueAt = null;
          // Cleared: the deadline stops being current, with no "wrong fact" recorded.
          const open = ctx
            .graph()
            .facts.find(
              (f) =>
                f.entityId === e.id &&
                f.attribute === "deadline" &&
                f.supersededBy == null &&
                f.retractedAt == null &&
                f.validTo == null,
            );
          if (open) open.validTo = ctx.now();
        } else {
          const iso = isoOrNull(p.dueAt);
          if (iso === null)
            throw new PsycheError("invalid_params", "dueAt must be a date and time");
          setOwnerFact(e, "deadline", iso);
        }
        changed.push("due");
      }
      if (p.projectType !== undefined) e.projectType = p.projectType;
      if (p.private !== undefined) {
        if (p.private) e.private = true;
        else delete e.private;
        changed.push("private");
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
      const e = entityOf(p.entityId);
      if (e.kind === "assignment" && p.attribute === "status" && !WORK_STATUSES.includes(p.value))
        throw new PsycheError("invalid_params", `${p.value} is not a status`);
      const result = setOwnerFact(
        e,
        p.attribute,
        p.value,
        "owner",
        p.source?.ref ? [p.source.ref] : [],
      );
      touched(e, ["facts"]);
      return result;
    },
    "memory.entities.edges.set": (p) => {
      const w = ctx.graph();
      const src = entityOf(p.src);
      const dst = entityOf(p.dst);
      const live = (x: GraphEdge) => x.supersededBy == null && x.retractedAt == null;
      const existing = w.edges.find(
        (x) => x.src === src.id && x.dst === dst.id && x.rel === p.rel && live(x),
      );
      // An assignment or event is part of one course or project: a new parent replaces the old.
      if (p.rel === "part_of" && (src.kind === "assignment" || src.kind === "event"))
        for (const x of w.edges)
          if (x.src === src.id && x.rel === "part_of" && live(x) && x !== existing)
            x.retractedAt = ctx.now();
      const edge: GraphEdge = existing ?? {
        id: `edge_owner_${w.edges.length + 1}`,
        src: src.id,
        dst: dst.id,
        rel: p.rel,
        ...(p.label === undefined ? {} : { label: p.label }),
        provenance: "owner",
        confidence: 1,
        sources: [],
        validFrom: ctx.now(),
        validTo: null,
        supersededBy: null,
        retractedAt: null,
      };
      if (!existing) w.edges.push(edge);
      touched(src, ["edges"]);
      touched(dst, ["edges"]);
      return { edge, superseded: null };
    },
    "memory.entities.edges.retract": (p) => {
      const w = ctx.graph();
      const edge = w.edges.find((x) => x.id === p.edgeId) ?? notFound(`edge ${p.edgeId}`);
      edge.retractedAt = ctx.now();
      touched(entityOf(edge.src), ["edges"]);
      touched(entityOf(edge.dst), ["edges"]);
      return { edge };
    },
    // Home's "Catching up": the fixture list as the Gateway ranked it; acting on a line answers it.
    "memory.catchup.list": (p) => ({
      items: (ctx.graph().catchUp ?? []).slice(0, p.limit ?? 3),
      pendingCount: ctx.graph().catchUpPending ?? 0,
      hiddenCount: 0,
      asOf: ctx.now(),
    }),
    "memory.catchup.act": (p) => {
      const w = ctx.graph();
      const e = entityOf(p.entityId);
      w.catchUp = (w.catchUp ?? []).filter((i) => i.entityId !== p.entityId);
      touched(e, [p.action]);
      return { entity: e };
    },
    "memory.catchup.seen": (p) => ({ seen: p.entityIds.length }),
    // The demo has no Microsoft 365 connection unless a story adds lists: the helper's are all.
    "memory.work.lists": () => ({ lists: ctx.graph().workLists ?? [] }),
    "memory.work.history": (p) => ({
      entries: ctx
        .graph()
        .facts.filter(
          (f) =>
            f.entityId === p.entityId &&
            f.retractedAt == null &&
            ["status", "progress", "stopped_at", "next_step", "deadline"].includes(f.attribute),
        )
        .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt))
        .slice(0, p.limit ?? 20)
        .map((f) => ({
          factId: f.id,
          attribute: f.attribute as WorkHistoryEntry["attribute"],
          value: f.value,
          from: ctx.graph().facts.find((x) => x.supersededBy === f.id)?.value ?? null,
          at: f.recordedAt,
          origin: f.provenance === "owner" ? ("you" as const) : ("nightly" as const),
          chip: null,
          undoable: false,
        })),
    }),
    "memory.entities.timeline": (p) => timelineOf(ctx.graph(), p.entityId, p.before, p.limit ?? 50),
    "memory.anchors.list": (p) => ({
      anchors: ctx
        .graph()
        .anchors.filter(
          (a) => (!p.entityId || a.entityId === p.entityId) && (!p.kind || a.kind === p.kind),
        ),
    }),
    "memory.anchors.add": (p) => {
      const w = ctx.graph();
      const e = entityOf(p.entityId);
      const same = w.anchors.find(
        (a) => a.entityId === e.id && a.kind === p.kind && a.ref === p.ref,
      );
      if (same) return { anchor: same };
      const anchor: GraphAnchor = {
        id: `anc_${w.anchors.length + 1}`,
        entityId: e.id,
        kind: p.kind,
        ref: p.ref,
        label: p.label ?? p.ref,
        addedBy: "owner",
        confirmed: true,
        createdAt: ctx.now(),
      };
      w.anchors.push(anchor);
      touched(e, ["anchors"]);
      return { anchor };
    },
    "memory.anchors.remove": (p) => {
      const w = ctx.graph();
      const found = w.anchors.find((a) => a.id === p.id);
      if (!found) return { removed: false };
      w.anchors = w.anchors.filter((a) => a.id !== p.id);
      touched(entityOf(found.entityId), ["anchors"]);
      return { removed: true };
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
