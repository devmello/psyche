import { type Static, Type } from "@sinclair/typebox";
import { Id, IsoDateTime, Nullable, Provenance, StringEnum } from "../common.ts";

/**
 * People and projects memory graph (docs/memory/people-and-projects-2026.md §4, §6.1; owner
 * S07). Entities (people, organisations, projects, places), identifiers as merge keys, facts and
 * relations from allowlists with provenance and validity windows, interactions stored as
 * pointers, and open loops. Third-party text is always `untrusted`; sensitive traits have no
 * attribute and are never stored.
 */

export const GraphEntityKind = StringEnum(["person", "org", "project", "place", "event", "topic"], {
  $id: "GraphEntityKind",
  description:
    "person, organisation, project, place, event (dated, may recur) or topic (a lightweight label)",
});
export type GraphEntityKind = Static<typeof GraphEntityKind>;

export const GraphEntityStatus = StringEnum(["active", "archived", "merged"], {
  $id: "GraphEntityStatus",
});
export type GraphEntityStatus = Static<typeof GraphEntityStatus>;

export const GraphProjectStatus = StringEnum(["active", "paused", "done"], {
  $id: "GraphProjectStatus",
});
export type GraphProjectStatus = Static<typeof GraphProjectStatus>;

/** Unique merge keys (§4.2). `contact` is the Contacts card identifier. */
export const GraphIdentifierKind = StringEnum(
  ["email", "phone", "contact", "channel", "domain", "calendar", "url"],
  { $id: "GraphIdentifierKind" },
);
export type GraphIdentifierKind = Static<typeof GraphIdentifierKind>;

export const GraphIdentifier = Type.Object(
  {
    kind: GraphIdentifierKind,
    value: Type.String({
      maxLength: 512,
      description: "Display form (the stored key is normalised: lower-case email, E.164 phone)",
    }),
    entityId: Id,
    source: Type.String({ maxLength: 120, description: "Connector or origin that produced it" }),
    linkedBy: StringEnum(["rule", "owner", "model"], {
      $id: "GraphLinkedBy",
      description: "Who attached it to the entity; model links count only after the owner confirms",
    }),
    verified: Type.Boolean({ description: "From Contacts or confirmed by the owner" }),
    shared: Type.Boolean({
      description: "Seen with several display names (a family or team inbox): never resolves alone",
    }),
    createdAt: IsoDateTime,
  },
  { $id: "GraphIdentifier" },
);
export type GraphIdentifier = Static<typeof GraphIdentifier>;

/** The fact attribute allowlist (§4.3). There is no slot for sensitive traits. */
export const GraphFactAttribute = StringEnum(
  [
    "role",
    "title",
    "employer",
    "team",
    "email_pref",
    "timezone",
    "city",
    "birthday",
    "relationship_to_owner",
    "preference",
    "note",
    "status",
    "next_step",
    "budget_note",
    "deadline",
    // Everything memory "life" group (docs/design/everything-memory-2026.md §4.3).
    "anniversary",
    "hometown",
    "school",
    "pronouns",
    "partner_name",
    "children_names",
    "pet_names",
    "likes",
    "dislikes",
    "diet",
    "gift_idea",
    "languages",
    "contact_pref",
    "life_event",
  ],
  { $id: "GraphFactAttribute" },
);
export type GraphFactAttribute = Static<typeof GraphFactAttribute>;

/** Values of `relationship_to_owner` and of `related_to` edge labels (owner or Contacts only). */
export const GraphRelationshipLabel = StringEnum(
  [
    "partner",
    "parent",
    "child",
    "sibling",
    "friend",
    "colleague",
    "manager",
    "report",
    "client",
    "vendor",
    "teacher",
    "doctor",
    "other",
  ],
  { $id: "GraphRelationshipLabel" },
);
export type GraphRelationshipLabel = Static<typeof GraphRelationshipLabel>;

/** Where an owner write came from; stored in the fact's or edge's `sources` (§5.4). */
export const GraphWriteSource = Type.Object(
  {
    kind: StringEnum(["owner_edit", "owner_feedback", "chat"], {
      $id: "GraphWriteSourceKind",
      description: "The card or file, the teaching loop, or the owner's chat",
    }),
    ref: Type.Optional(
      Type.String({ maxLength: 200, description: 'e.g. "lesson:<id>" or a thread id' }),
    ),
  },
  { $id: "GraphWriteSource" },
);
export type GraphWriteSource = Static<typeof GraphWriteSource>;

/** Who a fact is about, relative to the text it came from (everything memory §4.3). */
export const GraphSubjectKind = StringEnum(
  ["self_disclosure", "about_other", "owner_stated", "deterministic"],
  {
    $id: "GraphSubjectKind",
    description:
      "self_disclosure: the sender about themselves; about_other: the sender about someone else; owner_stated: the owner's own words; deterministic: Contacts, calendar, headers",
  },
);
export type GraphSubjectKind = Static<typeof GraphSubjectKind>;

/**
 * Sensitivity class of a fact (§10.2). `gov_id` and `account_numbers` are hard-blocked: they
 * exist so the classifier can name what it dropped, never so a fact is stored with them.
 */
export const GraphSensitivity = StringEnum(
  [
    "none",
    "health",
    "finance",
    "sexuality",
    "religion",
    "politics",
    "ethnicity",
    "legal",
    "precise_location",
    "gov_id",
    "account_numbers",
  ],
  { $id: "GraphSensitivity" },
);
export type GraphSensitivity = Static<typeof GraphSensitivity>;

/** Review state of a fact (§4.3, §7). */
export const GraphReviewState = StringEnum(
  ["pending", "accepted", "auto_accepted", "edited", "discarded", "quarantined"],
  { $id: "GraphReviewState" },
);
export type GraphReviewState = Static<typeof GraphReviewState>;

/** Where a citation's text came from (§4.4). */
export const GraphCitationSource = StringEnum(
  [
    "mail",
    "messages",
    "notes",
    "calendar",
    "reminders",
    "chats",
    "files",
    "browser",
    "transcripts",
    "contacts",
  ],
  { $id: "GraphCitationSource" },
);
export type GraphCitationSource = Static<typeof GraphCitationSource>;

export const GraphCitationTarget = StringEnum(["fact", "edge", "event", "entity"], {
  $id: "GraphCitationTarget",
});
export type GraphCitationTarget = Static<typeof GraphCitationTarget>;

/**
 * A verbatim span of a source that supports a fact, relation or event (§4.4). A fact without at
 * least one citation that re-verifies against its source does not exist.
 */
export const GraphCitation = Type.Object(
  {
    id: Id,
    targetKind: GraphCitationTarget,
    targetId: Id,
    source: GraphCitationSource,
    docId: Nullable(Type.String({ maxLength: 200, description: "search_docs id, when indexed" })),
    sourceRef: Type.String({
      maxLength: 1024,
      description: "Native id: Message-ID, chat guid and day, note id, event id or path",
    }),
    quote: Type.String({ maxLength: 200, description: "Verbatim from the source" }),
    start: Type.Integer({ minimum: 0, description: "Offset of the quote in the extracted text" }),
    end: Type.Integer({ minimum: 0, description: "Exclusive end offset" }),
    sourceHash: Type.String({
      maxLength: 128,
      description: "sha256 of the text the offsets refer to",
    }),
    authorEntityId: Nullable(Id),
    provenance: Provenance,
    observedAt: IsoDateTime,
    createdAt: IsoDateTime,
  },
  { $id: "GraphCitation" },
);
export type GraphCitation = Static<typeof GraphCitation>;

export const GraphFact = Type.Object(
  {
    id: Id,
    entityId: Id,
    attribute: GraphFactAttribute,
    value: Type.String({ maxLength: 2000 }),
    provenance: Provenance,
    confidence: Type.Number({ minimum: 0, maximum: 1 }),
    sources: Type.Array(Type.String(), {
      description: "Interaction, chunk, Contacts or lesson references",
    }),
    evidence: Nullable(
      Type.String({ maxLength: 200, description: "The quoted span it came from" }),
    ),
    validFrom: IsoDateTime,
    validTo: Nullable(IsoDateTime),
    recordedAt: IsoDateTime,
    supersededBy: Nullable(Id),
    retractedAt: Nullable(IsoDateTime),
    // Everything memory (§4.3). Optional so older producers stay valid; absent means the value
    // an owner or rule-written fact would have (none / accepted).
    subjectKind: Type.Optional(GraphSubjectKind),
    sensitivity: Type.Optional(GraphSensitivity),
    review: Type.Optional(GraphReviewState),
    firstSeenAt: Type.Optional(IsoDateTime),
    lastSeenAt: Type.Optional(IsoDateTime),
    runId: Type.Optional(Nullable(Id)),
    extractor: Type.Optional(
      Type.String({ maxLength: 200, description: '"rule" or the model ref that proposed it' }),
    ),
  },
  { $id: "GraphFact" },
);
export type GraphFact = Static<typeof GraphFact>;

/** The relation allowlist (§4.4). Co-occurrence is computed, never stored as an edge. */
export const GraphEdgeRel = StringEnum(
  [
    "works_at",
    "member_of",
    "stakeholder_of",
    "located_at",
    "reports_to",
    "related_to",
    "part_of",
    // Everything memory relations (§4.2). `knows` is deliberately absent: co-occurrence is a
    // query over graph_participants, never an edge.
    "family",
    "friend",
    "neighbour",
    "classmate",
    "roommate",
    "colleague",
    "manager",
    "client",
    "vendor",
    "mentor",
    "studied_at",
    "lives_in",
    "attended",
    "about",
  ],
  { $id: "GraphEdgeRel" },
);
export type GraphEdgeRel = Static<typeof GraphEdgeRel>;

/** The `role` of a `family` edge (§4.2). */
export const GraphFamilyRole = StringEnum(
  [
    "parent",
    "child",
    "sibling",
    "partner",
    "spouse",
    "grandparent",
    "grandchild",
    "cousin",
    "in_law",
    "other",
  ],
  { $id: "GraphFamilyRole" },
);
export type GraphFamilyRole = Static<typeof GraphFamilyRole>;

export const GraphEdge = Type.Object(
  {
    id: Id,
    src: Id,
    dst: Id,
    rel: GraphEdgeRel,
    label: Type.Optional(GraphRelationshipLabel),
    role: Type.Optional(GraphFamilyRole),
    review: Type.Optional(GraphReviewState),
    provenance: Provenance,
    confidence: Type.Number({ minimum: 0, maximum: 1 }),
    sources: Type.Array(Type.String()),
    validFrom: IsoDateTime,
    validTo: Nullable(IsoDateTime),
    supersededBy: Nullable(Id),
    retractedAt: Nullable(IsoDateTime),
  },
  { $id: "GraphEdge" },
);
export type GraphEdge = Static<typeof GraphEdge>;

export const GraphInteractionKind = StringEnum(
  ["mail", "message", "meeting", "call", "note", "chat", "task"],
  { $id: "GraphInteractionKind" },
);
export type GraphInteractionKind = Static<typeof GraphInteractionKind>;

export const GraphParticipantRole = StringEnum(
  ["from", "to", "cc", "attendee", "organizer", "mentioned"],
  { $id: "GraphParticipantRole" },
);
export type GraphParticipantRole = Static<typeof GraphParticipantRole>;

/** One interaction: headers and a link back, never a body (§4.5). */
export const GraphInteraction = Type.Object(
  {
    id: Id,
    kind: GraphInteractionKind,
    source: Type.String({ maxLength: 120, description: "Connector id" }),
    occurredAt: IsoDateTime,
    direction: StringEnum(["in", "out", "both", "none"], { $id: "GraphDirection" }),
    subject: Nullable(Type.String({ maxLength: 200, description: "Untrusted, truncated" })),
    threadKey: Nullable(Type.String({ maxLength: 512 })),
    link: Nullable(
      Type.String({ maxLength: 1024, description: "message://, calendar:// or the connector's" }),
    ),
    projectId: Nullable(Id),
    participants: Type.Array(Type.Object({ entityId: Id, role: GraphParticipantRole })),
  },
  { $id: "GraphInteraction" },
);
export type GraphInteraction = Static<typeof GraphInteraction>;

export const GraphLoopStatus = StringEnum(["suggested", "open", "snoozed", "done", "dismissed"], {
  $id: "GraphLoopStatus",
});
export type GraphLoopStatus = Static<typeof GraphLoopStatus>;

/** An open loop: something the owner owes, or is waiting on (§4.6). */
export const GraphLoop = Type.Object(
  {
    id: Id,
    direction: StringEnum(["i_owe", "waiting_on"], { $id: "GraphLoopDirection" }),
    text: Type.String({ maxLength: 200 }),
    evidence: Nullable(Type.String({ maxLength: 200, description: "The quoted sentence" })),
    counterpartId: Nullable(Id),
    projectId: Nullable(Id),
    dueAt: Nullable(IsoDateTime),
    status: GraphLoopStatus,
    sourceInteractionId: Nullable(Id),
    provenance: Provenance,
    confidence: Type.Number({ minimum: 0, maximum: 1 }),
    detectedBy: StringEnum(["rule", "model", "owner"], { $id: "GraphLoopDetectedBy" }),
    createdAt: IsoDateTime,
    closedAt: Nullable(IsoDateTime),
    closedBy: Nullable(
      StringEnum(["owner", "reply_seen", "due_passed"], { $id: "GraphLoopClosedBy" }),
    ),
  },
  { $id: "GraphLoop" },
);
export type GraphLoop = Static<typeof GraphLoop>;

export const GraphEntity = Type.Object(
  {
    id: Id,
    kind: GraphEntityKind,
    name: Type.String({ maxLength: 200 }),
    aliases: Type.Array(Type.String({ maxLength: 200 })),
    status: GraphEntityStatus,
    mergedInto: Nullable(Id),
    isOwner: Type.Boolean({ description: "The owner's own person entity (exactly one)" }),
    pinned: Type.Boolean(),
    hidden: Type.Boolean({ description: "Don't track: nothing new is stored about them" }),
    projectStatus: Type.Optional(GraphProjectStatus),
    dueAt: Nullable(IsoDateTime),
    summary: Nullable(
      Type.String({ maxLength: 400, description: "Model-written (agent provenance), dated" }),
    ),
    summaryAt: Nullable(IsoDateTime),
    lastInteractionAt: Nullable(IsoDateTime),
    cardPath: Nullable(Type.String({ description: 'Workspace card, e.g. "people/sam-lee.md"' })),
    createdAt: IsoDateTime,
    updatedAt: IsoDateTime,
  },
  { $id: "GraphEntity" },
);
export type GraphEntity = Static<typeof GraphEntity>;

/** A compact row for lists, search and chips. */
export const EntitySummary = Type.Object(
  {
    id: Id,
    kind: GraphEntityKind,
    name: Type.String(),
    subtitle: Nullable(
      Type.String({ description: 'One line, e.g. "Acme" or "Active · 3 people"' }),
    ),
    summary: Nullable(Type.String()),
    status: GraphEntityStatus,
    projectStatus: Type.Optional(GraphProjectStatus),
    lastInteractionAt: Nullable(IsoDateTime),
    openLoops: Type.Integer({ minimum: 0 }),
    pinned: Type.Boolean(),
    isOwner: Type.Boolean(),
  },
  { $id: "EntitySummary" },
);
export type EntitySummary = Static<typeof EntitySummary>;

/** Everything a card shows (`memory.entities.get`). */
export const GraphEntityDetail = Type.Object(
  {
    entity: GraphEntity,
    identifiers: Type.Array(GraphIdentifier),
    facts: Type.Array(GraphFact, { description: "Current facts, owner first, newest first" }),
    edges: Type.Array(GraphEdge, { description: "Current relations from or to this entity" }),
    related: Type.Array(EntitySummary, { description: "Every entity the edges point to" }),
    openLoops: Type.Array(GraphLoop),
    recentInteractions: Type.Array(GraphInteraction, { maxItems: 10 }),
    etag: Type.String({ description: "Of the card; for memory.entities.update if-match" }),
  },
  { $id: "GraphEntityDetail" },
);
export type GraphEntityDetail = Static<typeof GraphEntityDetail>;

/** A merge or project the owner is asked to confirm (§5.1, §5.2). */
export const GraphSuggestion = Type.Object(
  {
    id: Id,
    kind: StringEnum(["merge", "project"], { $id: "GraphSuggestionKind" }),
    entityIds: Type.Array(Id, {
      description: "merge: the entities; project: the proposed members",
    }),
    name: Nullable(Type.String({ maxLength: 200, description: "project: the proposed name" })),
    reason: Type.String({ maxLength: 300, description: "Why it was suggested, in plain words" }),
    status: StringEnum(["pending", "accepted", "rejected", "later"], {
      $id: "GraphSuggestionStatus",
    }),
    createdAt: IsoDateTime,
  },
  { $id: "GraphSuggestion" },
);
export type GraphSuggestion = Static<typeof GraphSuggestion>;

/** Sources the owner turns on one by one (all off by default; chats follow the learner). */
export const GraphSource = StringEnum(
  ["contacts", "mail", "calendar", "messages", "notes", "chats"],
  { $id: "GraphSource" },
);
export type GraphSource = Static<typeof GraphSource>;

/**
 * A blocklisted identifier (§4.9): ingest never models it again. Only a hash of the value is
 * kept, so `hint` is a masked form ("s•••@acme.com"; a domain is shown whole).
 */
export const GraphBlocklistEntry = Type.Object(
  {
    id: Type.String({ description: "Opaque; for memory.graph.blocklist.remove" }),
    kind: GraphIdentifierKind,
    hint: Nullable(Type.String({ maxLength: 200 })),
    createdAt: IsoDateTime,
  },
  { $id: "GraphBlocklistEntry" },
);
export type GraphBlocklistEntry = Static<typeof GraphBlocklistEntry>;

/** What a graph-wide or per-source delete removed (or would remove, on a dry run). */
export const GraphRemovedCounts = Type.Object(
  {
    entities: Type.Integer({ minimum: 0 }),
    identifiers: Type.Integer({ minimum: 0 }),
    facts: Type.Integer({ minimum: 0 }),
    interactions: Type.Integer({ minimum: 0 }),
    loops: Type.Integer({ minimum: 0 }),
  },
  { $id: "GraphRemovedCounts" },
);
export type GraphRemovedCounts = Static<typeof GraphRemovedCounts>;

export const GraphStatus = Type.Object(
  {
    enabled: Type.Boolean(),
    sources: Type.Array(
      Type.Object({
        source: GraphSource,
        enabled: Type.Boolean(),
        entities: Type.Integer({ minimum: 0 }),
        interactions: Type.Integer({ minimum: 0 }),
        lastIngestAt: Nullable(IsoDateTime),
      }),
    ),
    counts: Type.Object({
      people: Type.Integer({ minimum: 0 }),
      orgs: Type.Integer({ minimum: 0 }),
      projects: Type.Integer({ minimum: 0 }),
      places: Type.Integer({ minimum: 0 }),
      openLoops: Type.Integer({ minimum: 0 }),
      pendingSuggestions: Type.Integer({ minimum: 0 }),
    }),
    lastModelPassAt: Nullable(IsoDateTime),
    budget: Type.Object({
      entitiesUsed: Type.Integer({ minimum: 0 }),
      tokensUsed: Type.Integer({ minimum: 0 }),
      maxEntities: Type.Integer({ minimum: 0 }),
      maxTokens: Type.Integer({ minimum: 0 }),
    }),
    loopPrecision: Type.Array(
      Type.Object({
        source: GraphSource,
        confirmed: Type.Integer({ minimum: 0 }),
        dismissed: Type.Integer({ minimum: 0 }),
      }),
      { description: "Suggested loops confirmed vs dismissed per source over 30 days" },
    ),
  },
  { $id: "GraphStatus" },
);
export type GraphStatus = Static<typeof GraphStatus>;
