import type {
  EntitySummary,
  GraphBlocklistEntry,
  GraphEdge,
  GraphEntity,
  GraphEntityDetail,
  GraphFact,
  GraphIdentifier,
  GraphInteraction,
  GraphLoop,
  GraphStatus,
  GraphSuggestion,
} from "@psyche/protocol";
import { toEntityView, toSuggestionView } from "../people/adapt.ts";
import type { EntityRef, EntityView, SuggestionView } from "../people/types.ts";
import { FIXTURE_NOW } from "./ids.ts";

/**
 * A small people-and-projects graph in the PG0 shapes, after the §8 acceptance fixtures in
 * docs/memory/people-and-projects-2026.md: two different Sams, a designer, a contractor, the
 * kitchen remodel and the Q4 launch, an untrusted claim from mail and an injected "you owe"
 * that stays a suggestion. Dates sit before the kit's fixture clock (2026-10-18T10:12Z).
 */

export const PEOPLE_IDS = {
  owner: "ent_owner",
  samLee: "ent_sam_lee",
  samGmail: "ent_sam_gmail",
  samOrtiz: "ent_sam_ortiz",
  dana: "ent_dana_kim",
  rivera: "ent_rivera_build",
  acme: "ent_acme",
  kitchen: "ent_kitchen_remodel",
  launch: "ent_q4_launch",
} as const;

const P = PEOPLE_IDS;
const T0 = "2026-09-01T09:00:00Z";

type Kind = GraphEntity["kind"];

function entity(
  id: string,
  kind: Kind,
  name: string,
  extra: Partial<GraphEntity> = {},
): GraphEntity {
  return {
    id,
    kind,
    name,
    aliases: [],
    status: "active",
    mergedInto: null,
    isOwner: id === P.owner,
    pinned: false,
    hidden: false,
    dueAt: null,
    summary: null,
    summaryAt: null,
    lastInteractionAt: null,
    cardPath: `${kind === "project" ? "projects" : "people"}/${id.slice(4).replace(/_/g, "-")}.md`,
    createdAt: T0,
    updatedAt: T0,
    ...extra,
  };
}

interface FactSpec {
  id: string;
  entityId: string;
  attribute: GraphFact["attribute"];
  value: string;
  provenance: GraphFact["provenance"];
  sources?: string[];
  recordedAt: string;
  evidence?: string;
  supersededBy?: string;
}

function fact(f: FactSpec): GraphFact {
  return {
    id: f.id,
    entityId: f.entityId,
    attribute: f.attribute,
    value: f.value,
    provenance: f.provenance,
    confidence: f.provenance === "owner" ? 1 : f.provenance === "untrusted" ? 0.4 : 0.85,
    sources: f.sources ?? [],
    evidence: f.evidence ?? null,
    validFrom: f.recordedAt,
    validTo: null,
    recordedAt: f.recordedAt,
    supersededBy: f.supersededBy ?? null,
    retractedAt: null,
  };
}

function edge(
  id: string,
  src: string,
  rel: GraphEdge["rel"],
  dst: string,
  provenance: GraphEdge["provenance"],
): GraphEdge {
  return {
    id,
    src,
    dst,
    rel,
    provenance,
    confidence: provenance === "owner" ? 1 : 0.8,
    sources: [],
    validFrom: T0,
    validTo: null,
    supersededBy: null,
    retractedAt: null,
  };
}

interface InteractionSpec {
  id: string;
  kind: GraphInteraction["kind"];
  subject: string;
  at: string;
  direction: GraphInteraction["direction"];
  link?: string;
  project?: string;
  participants: GraphInteraction["participants"];
}

function interaction(i: InteractionSpec): GraphInteraction {
  return {
    id: i.id,
    kind: i.kind,
    source: i.kind === "meeting" ? "calendar" : i.kind === "message" ? "messages" : "mail",
    occurredAt: i.at,
    direction: i.direction,
    subject: i.subject,
    threadKey: null,
    link: i.link ?? null,
    projectId: i.project ?? null,
    participants: i.participants,
  };
}

interface LoopSpec {
  id: string;
  direction: GraphLoop["direction"];
  text: string;
  evidence?: string;
  counterpart: string | null;
  project?: string;
  due?: string;
  status: GraphLoop["status"];
  from?: string;
  provenance: GraphLoop["provenance"];
  createdAt: string;
}

function loop(l: LoopSpec): GraphLoop {
  return {
    id: l.id,
    direction: l.direction,
    text: l.text,
    evidence: l.evidence ?? null,
    counterpartId: l.counterpart,
    projectId: l.project ?? null,
    dueAt: l.due ?? null,
    status: l.status,
    sourceInteractionId: l.from ?? null,
    provenance: l.provenance,
    confidence: l.provenance === "untrusted" ? 0.4 : 0.8,
    detectedBy: l.provenance === "system" ? "rule" : "model",
    createdAt: l.createdAt,
    closedAt: null,
    closedBy: null,
  };
}

function identifier(
  entityId: string,
  kind: GraphIdentifier["kind"],
  value: string,
): GraphIdentifier {
  return {
    kind,
    value,
    entityId,
    source: "contacts",
    linkedBy: "rule",
    verified: true,
    shared: false,
    createdAt: T0,
  };
}

export interface GraphWorld {
  entities: GraphEntity[];
  identifiers: GraphIdentifier[];
  facts: GraphFact[];
  edges: GraphEdge[];
  interactions: GraphInteraction[];
  loops: GraphLoop[];
  suggestions: GraphSuggestion[];
  /** Card files' Notes sections, by entity id. */
  notes: Record<string, string>;
  /** Addresses, phones and domains Psyche never models again (hints masked). */
  blocklist: GraphBlocklistEntry[];
  status: GraphStatus;
}

export function graphWorld(): GraphWorld {
  const owner = { entityId: P.owner, role: "to" as const };
  return {
    entities: [
      entity(P.owner, "person", "Alex Rivera"),
      entity(P.samLee, "person", "Sam Lee", {
        aliases: ["Sam", "Samuel Lee"],
        pinned: true,
        summary:
          "Head of product at Acme. You work with Sam on the Q4 launch; most of it happens over mail, with a weekly Tuesday call.",
        summaryAt: "2026-10-17T03:10:00Z",
        lastInteractionAt: "2026-10-16T15:30:00Z",
      }),
      entity(P.samGmail, "person", "Sam L.", { lastInteractionAt: "2026-10-10T08:00:00Z" }),
      entity(P.samOrtiz, "person", "Sam Ortiz", { lastInteractionAt: "2026-09-28T11:00:00Z" }),
      entity(P.dana, "person", "Dana Kim", { lastInteractionAt: "2026-10-13T20:10:00Z" }),
      entity(P.rivera, "org", "Rivera Build", { lastInteractionAt: "2026-10-14T12:00:00Z" }),
      entity(P.acme, "org", "Acme"),
      entity(P.kitchen, "project", "Kitchen remodel", {
        aliases: ["kitchen"],
        projectStatus: "active",
        summary:
          "Cabinets are chosen; Rivera Build is waiting on the deposit before ordering. Dana is pulling tile options.",
        summaryAt: "2026-10-17T03:10:00Z",
        lastInteractionAt: "2026-10-14T12:00:00Z",
      }),
      entity(P.launch, "project", "Q4 launch", {
        projectStatus: "active",
        lastInteractionAt: "2026-10-16T15:30:00Z",
      }),
    ],
    identifiers: [
      identifier(P.samLee, "email", "sam@acme.com"),
      identifier(P.samLee, "phone", "+1 415 555 0100"),
      identifier(P.samGmail, "email", "samlee.home@gmail.com"),
      identifier(P.acme, "domain", "acme.com"),
    ],
    interactions: [
      interaction({
        id: "int_launch_weekly",
        kind: "meeting",
        subject: "Q4 launch weekly",
        at: "2026-10-16T15:30:00Z",
        direction: "both",
        link: "calendar://event/launch-weekly-1016",
        project: P.launch,
        participants: [
          { entityId: P.samLee, role: "attendee" },
          { entityId: P.owner, role: "organizer" },
        ],
      }),
      interaction({
        id: "int_budget",
        kind: "mail",
        subject: "Re: Budget for the launch",
        at: "2026-10-15T09:20:00Z",
        direction: "out",
        link: "message://%3Cbudget-1%40acme.com%3E",
        project: P.launch,
        participants: [
          { entityId: P.owner, role: "from" },
          { entityId: P.samLee, role: "to" },
        ],
      }),
      interaction({
        id: "int_sow",
        kind: "mail",
        subject: "SOW and next steps",
        at: "2026-10-12T16:02:00Z",
        direction: "in",
        link: "message://%3Csow-2%40psyche.local%3E",
        project: P.launch,
        participants: [{ entityId: P.samLee, role: "from" }, owner],
      }),
      interaction({
        id: "int_invoice",
        kind: "mail",
        subject: "Invoice reminder",
        at: "2026-10-17T07:40:00Z",
        direction: "in",
        link: "message://%3Cinvoice-9%40acme-billing.example%3E",
        participants: [{ entityId: P.samLee, role: "from" }, owner],
      }),
      interaction({
        id: "int_quote",
        kind: "mail",
        subject: "Quote and deposit for cabinets",
        at: "2026-10-14T12:00:00Z",
        direction: "in",
        link: "message://%3Cquote-3%40riverabuild.example%3E",
        project: P.kitchen,
        participants: [{ entityId: P.rivera, role: "from" }, owner],
      }),
      interaction({
        id: "int_tiles",
        kind: "message",
        subject: "Tile options",
        at: "2026-10-13T20:10:00Z",
        direction: "both",
        project: P.kitchen,
        participants: [{ entityId: P.dana, role: "from" }, owner],
      }),
      interaction({
        id: "int_site",
        kind: "meeting",
        subject: "Site visit",
        at: "2026-10-09T17:00:00Z",
        direction: "both",
        link: "calendar://event/site-visit",
        project: P.kitchen,
        participants: [
          { entityId: P.dana, role: "attendee" },
          { entityId: P.rivera, role: "attendee" },
          { entityId: P.owner, role: "organizer" },
        ],
      }),
    ],
    facts: [
      fact({
        id: "fact_sam_employer",
        entityId: P.samLee,
        attribute: "employer",
        value: "Acme",
        provenance: "owner",
        sources: ["contact:ABCD-1"],
        recordedAt: "2026-09-02T10:00:00Z",
      }),
      fact({
        id: "fact_sam_role",
        entityId: P.samLee,
        attribute: "role",
        value: "Head of product",
        provenance: "agent",
        sources: ["int_sow"],
        recordedAt: "2026-10-13T03:00:00Z",
        evidence: "Sam Lee · Head of Product · Acme",
      }),
      fact({
        id: "fact_sam_role_old",
        entityId: P.samLee,
        attribute: "role",
        value: "Product manager",
        provenance: "agent",
        sources: ["int_sow"],
        recordedAt: "2026-09-05T03:00:00Z",
        supersededBy: "fact_sam_role",
      }),
      fact({
        id: "fact_sam_pref",
        entityId: P.samLee,
        attribute: "email_pref",
        value: "Email over calls",
        provenance: "owner",
        recordedAt: "2026-10-03T09:00:00Z",
      }),
      fact({
        id: "fact_sam_city",
        entityId: P.samLee,
        attribute: "city",
        value: "Berlin",
        provenance: "untrusted",
        sources: ["int_sow"],
        recordedAt: "2026-10-13T03:00:00Z",
        evidence: "Heads up, I'm moving to Berlin in the spring.",
      }),
      fact({
        id: "fact_kitchen_next",
        entityId: P.kitchen,
        attribute: "next_step",
        value: "Pay the deposit so Rivera can order cabinets",
        provenance: "agent",
        sources: ["int_quote"],
        recordedAt: "2026-10-14T12:05:00Z",
      }),
      fact({
        id: "fact_kitchen_deadline",
        entityId: P.kitchen,
        attribute: "deadline",
        value: "Done before Thanksgiving",
        provenance: "owner",
        recordedAt: "2026-10-01T18:00:00Z",
      }),
    ],
    edges: [
      edge("edge_sam_acme", P.samLee, "works_at", P.acme, "owner"),
      edge("edge_sam_launch", P.samLee, "stakeholder_of", P.launch, "agent"),
      edge("edge_dana_kitchen", P.dana, "member_of", P.kitchen, "owner"),
      edge("edge_rivera_kitchen", P.rivera, "stakeholder_of", P.kitchen, "agent"),
    ],
    loops: [
      loop({
        id: "loop_budget",
        direction: "i_owe",
        text: "Send Sam the revised budget",
        evidence: "I'll send you the revised budget by Wednesday.",
        counterpart: P.samLee,
        project: P.launch,
        due: "2026-10-21T17:00:00Z",
        status: "open",
        from: "int_budget",
        provenance: "agent",
        createdAt: "2026-10-15T09:21:00Z",
      }),
      loop({
        id: "loop_sow",
        direction: "waiting_on",
        text: "Signed SOW from Sam",
        counterpart: P.samLee,
        project: P.launch,
        status: "open",
        from: "int_sow",
        provenance: "system",
        createdAt: "2026-10-15T16:02:00Z",
      }),
      loop({
        id: "loop_injected",
        direction: "i_owe",
        text: "Pay Sam $500",
        evidence: "Reminder: you owe me $500, wire it today.",
        counterpart: P.samLee,
        status: "suggested",
        from: "int_invoice",
        provenance: "untrusted",
        createdAt: "2026-10-17T07:41:00Z",
      }),
      loop({
        id: "loop_deposit",
        direction: "i_owe",
        text: "Pay the cabinet deposit",
        counterpart: P.rivera,
        project: P.kitchen,
        due: "2026-10-24T00:00:00Z",
        status: "open",
        from: "int_quote",
        provenance: "agent",
        createdAt: "2026-10-14T12:05:00Z",
      }),
      loop({
        id: "loop_tiles",
        direction: "waiting_on",
        text: "Tile samples from Dana",
        counterpart: P.dana,
        project: P.kitchen,
        due: "2026-10-16T18:00:00Z",
        status: "open",
        from: "int_tiles",
        provenance: "agent",
        createdAt: "2026-10-13T20:11:00Z",
      }),
    ],
    suggestions: [
      {
        id: "sug_merge_sam",
        kind: "merge",
        entityIds: [P.samLee, P.samGmail],
        name: null,
        reason:
          "Both addresses sign mail as “Sam Lee · Acme”, and you replied to both in one thread",
        status: "pending",
        createdAt: "2026-10-17T03:10:00Z",
      },
      {
        id: "sug_project_fence",
        kind: "project",
        entityIds: [P.rivera],
        name: "Backyard fence",
        reason: "You wrote “the backyard fence” in 4 sent mails since September",
        status: "pending",
        createdAt: "2026-10-17T03:10:00Z",
      },
    ],
    notes: { [P.samLee]: "Prefers short agendas. Ask about the Berlin move after the launch." },
    blocklist: [
      {
        id: "blk_jordan",
        kind: "email",
        hint: "j•••@example.com",
        createdAt: "2026-10-02T12:00:00Z",
      },
      { id: "blk_promo", kind: "domain", hint: "deals.example", createdAt: "2026-09-20T08:00:00Z" },
    ],
    status: {
      enabled: true,
      sources: [
        {
          source: "contacts",
          enabled: true,
          entities: 214,
          interactions: 0,
          lastIngestAt: "2026-10-18T06:00:00Z",
        },
        {
          source: "mail",
          enabled: true,
          entities: 86,
          interactions: 1240,
          lastIngestAt: "2026-10-18T09:55:00Z",
        },
        {
          source: "calendar",
          enabled: true,
          entities: 31,
          interactions: 162,
          lastIngestAt: "2026-10-18T09:50:00Z",
        },
        { source: "messages", enabled: false, entities: 0, interactions: 0, lastIngestAt: null },
        { source: "notes", enabled: false, entities: 0, interactions: 0, lastIngestAt: null },
        {
          source: "chats",
          enabled: true,
          entities: 12,
          interactions: 48,
          lastIngestAt: "2026-10-18T10:00:00Z",
        },
      ],
      counts: { people: 5, orgs: 2, projects: 2, places: 0, openLoops: 4, pendingSuggestions: 2 },
      lastModelPassAt: "2026-10-18T03:10:00Z",
      budget: { entitiesUsed: 38, tokensUsed: 41200, maxEntities: 200, maxTokens: 150000 },
      loopPrecision: [
        { source: "mail", confirmed: 14, dismissed: 3 },
        { source: "chats", confirmed: 6, dismissed: 0 },
      ],
    },
  };
}

// --- What the Gateway would return --------------------------------------------------------------

const NOW = Date.parse(FIXTURE_NOW);

export function graphRef(world: GraphWorld, id: string): EntityRef | null {
  const e = world.entities.find((x) => x.id === id);
  return e ? { id: e.id, kind: e.kind, name: e.name } : null;
}

/** `memory.entities.search` row for an entity. */
export function graphSummary(world: GraphWorld, e: GraphEntity): EntitySummary {
  const current = (x: GraphEdge) => x.supersededBy == null && x.retractedAt == null;
  const employer = world.edges.find((x) => x.src === e.id && x.rel === "works_at" && current(x));
  const members = world.edges
    .filter((x) => x.dst === e.id && x.rel !== "works_at" && current(x))
    .map((x) => graphRef(world, x.src)?.name)
    .filter((n): n is string => typeof n === "string");
  const openLoops = world.loops.filter(
    (l) => (l.counterpartId === e.id || l.projectId === e.id) && l.status === "open",
  ).length;
  return {
    id: e.id,
    kind: e.kind,
    name: e.name,
    subtitle:
      e.kind === "project"
        ? members.join(", ") || null
        : employer
          ? (graphRef(world, employer.dst)?.name ?? null)
          : null,
    summary: e.summary ?? null,
    status: e.status,
    ...(e.projectStatus ? { projectStatus: e.projectStatus } : {}),
    lastInteractionAt: e.lastInteractionAt ?? null,
    openLoops,
    pinned: e.pinned,
    isOwner: e.isOwner,
  };
}

/** `memory.entities.get` for one entity. */
export function graphDetail(world: GraphWorld, id: string): GraphEntityDetail | null {
  const e = world.entities.find((x) => x.id === id);
  if (!e) return null;
  const edges = world.edges.filter(
    (x) => (x.src === id || x.dst === id) && x.supersededBy == null && x.retractedAt == null,
  );
  const openLoops = world.loops.filter(
    (l) =>
      (l.counterpartId === id || l.projectId === id) &&
      (l.status === "open" || l.status === "suggested" || l.status === "snoozed"),
  );
  const recentInteractions = world.interactions
    .filter((i) => i.projectId === id || i.participants.some((p) => p.entityId === id))
    .sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt))
    .slice(0, 10);
  const related = new Set<string>();
  for (const x of edges) related.add(x.src === id ? x.dst : x.src);
  for (const l of openLoops) {
    if (l.counterpartId) related.add(l.counterpartId);
    if (l.projectId) related.add(l.projectId);
  }
  for (const i of recentInteractions) for (const p of i.participants) related.add(p.entityId);
  related.delete(id);
  return {
    entity: e,
    identifiers: world.identifiers.filter((i) => i.entityId === id),
    facts: world.facts.filter(
      (f) => f.entityId === id && f.supersededBy == null && f.retractedAt == null,
    ),
    edges,
    related: world.entities.filter((x) => related.has(x.id)).map((x) => graphSummary(world, x)),
    openLoops,
    recentInteractions,
    etag: `etag-${id}-${e.updatedAt}`,
  };
}

/** The card view for an entity, built the way the connected card builds it. */
export function graphView(world: GraphWorld, id: string, now = NOW): EntityView | null {
  const detail = graphDetail(world, id);
  return detail ? toEntityView({ detail, notes: world.notes[id] ?? null, now }) : null;
}

const world = graphWorld();
const names = new Map(
  world.entities.map((e) => [e.id, { id: e.id, kind: e.kind, name: e.name }] as const),
);

/** Ready-made views for stories and component tests. */
export const samLee = graphView(world, P.samLee) as EntityView;
export const kitchen = graphView(world, P.kitchen) as EntityView;
export const summaries: EntitySummary[] = [P.samLee, P.samOrtiz, P.dana, P.kitchen, P.launch].map(
  (id) => graphSummary(world, world.entities.find((e) => e.id === id) as GraphEntity),
);
export const suggestions: SuggestionView[] = world.suggestions.map((s) =>
  toSuggestionView(
    s,
    names,
    new Map(world.identifiers.filter((i) => i.kind === "email").map((i) => [i.entityId, i.value])),
  ),
);
