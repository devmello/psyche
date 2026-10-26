/**
 * People and projects graph shapes for the UI (docs/memory/people-and-projects-2026.md §4, §6.1).
 * They mirror the PG0 protocol schemas (`packages/protocol/src/schemas/graph.ts`, issue #650) by
 * name and field so the components can switch to `@psyche/protocol` imports when PG0 lands;
 * until then the kit builds against these and the fixtures in `fixtures/people.ts`.
 */

export type GraphEntityKind = "person" | "org" | "project" | "place";
export type GraphEntityStatus = "active" | "archived" | "merged";
export type ProjectStatus = "active" | "paused" | "done";

/** Who a fact came from (§4.3). `untrusted` is a claim inside third-party mail or messages. */
export type GraphProvenance = "owner" | "agent" | "untrusted" | "system";

/** The v1 attribute allowlist (§4.3). There is no slot for sensitive traits. */
export type GraphFactAttribute =
  | "role"
  | "title"
  | "employer"
  | "team"
  | "email_pref"
  | "timezone"
  | "city"
  | "birthday"
  | "relationship_to_owner"
  | "preference"
  | "note"
  | "status"
  | "next_step"
  | "budget_note"
  | "deadline";

/** The relationship allowlist (§4.4). */
export type GraphRel =
  | "works_at"
  | "member_of"
  | "stakeholder_of"
  | "located_at"
  | "reports_to"
  | "related_to"
  | "part_of";

export type GraphIdentifierKind =
  | "email"
  | "phone"
  | "contact"
  | "channel"
  | "domain"
  | "calendar"
  | "url";

export interface GraphIdentifier {
  kind: GraphIdentifierKind;
  /** As shown: `sam@acme.com`, `+1 415 555 0100`. */
  value: string;
  /** Seen with two or more display names (a family or team inbox); never resolves alone. */
  shared?: boolean;
  linkedBy: "rule" | "owner" | "model";
}

/** Where a fact or loop came from: an interaction, a Contacts card, a chat turn. */
export interface GraphSourceRef {
  kind: "mail" | "message" | "meeting" | "call" | "note" | "chat" | "task" | "contacts" | "owner";
  /** The app link back (`message://…`, an event id), when there is one. */
  link?: string | null;
  /** Display name of the sender, for untrusted claims ("From Sam's mail"). */
  from?: string | null;
  at?: string | null;
}

export interface GraphFact {
  id: string;
  entityId: string;
  attribute: GraphFactAttribute;
  value: string;
  provenance: GraphProvenance;
  confidence: number;
  sources: GraphSourceRef[];
  /** The quoted span it came from, at most 200 characters. */
  evidence?: string | null;
  validFrom?: string | null;
  validTo?: string | null;
  recordedAt: string;
}

export interface GraphEdge {
  id: string;
  src: string;
  dst: string;
  rel: GraphRel;
  provenance: GraphProvenance;
  /** The other end, resolved for display. */
  other: { id: string; kind: GraphEntityKind; name: string };
  /** Free label for `related_to` (only from the owner or Contacts). */
  label?: string | null;
}

export type GraphInteractionKind =
  | "mail"
  | "message"
  | "meeting"
  | "call"
  | "note"
  | "chat"
  | "task";

export interface GraphInteraction {
  id: string;
  kind: GraphInteractionKind;
  occurredAt: string;
  direction: "in" | "out" | "both" | "none";
  /** Untrusted; at most 200 characters. */
  subject: string;
  /** `message://…`, `calendar://…` or the connector's own link. */
  link?: string | null;
  participants: { id: string; name: string }[];
}

export type GraphLoopDirection = "i_owe" | "waiting_on";
export type GraphLoopStatus = "suggested" | "open" | "snoozed" | "done" | "dismissed";

export interface GraphLoop {
  id: string;
  direction: GraphLoopDirection;
  /** Phrased by the extractor: "Send Sam the revised budget". */
  text: string;
  evidence?: string | null;
  counterpart?: { id: string; name: string } | null;
  project?: { id: string; name: string } | null;
  dueAt?: string | null;
  status: GraphLoopStatus;
  source?: GraphSourceRef | null;
  provenance: GraphProvenance;
  createdAt: string;
}

/** One row in Search, ⌘K and the sheet list. */
export interface EntitySummary {
  id: string;
  kind: GraphEntityKind;
  name: string;
  /** "Acme", "Kitchen remodel · active". */
  subtitle?: string | null;
  lastInteractionAt?: string | null;
  lastInteractionKind?: GraphInteractionKind | null;
  openLoops: number;
  projectStatus?: ProjectStatus | null;
  pinned?: boolean;
}

export interface GraphEntity {
  id: string;
  kind: GraphEntityKind;
  name: string;
  aliases: string[];
  status: GraphEntityStatus;
  isOwner?: boolean;
  pinned?: boolean;
  hidden?: boolean;
  /** Model-written, at most 400 characters, provenance `agent`. */
  summary?: string | null;
  summaryAt?: string | null;
  lastInteractionAt?: string | null;
  identifiers: GraphIdentifier[];
  facts: GraphFact[];
  edges: GraphEdge[];
  loops: GraphLoop[];
  interactions: GraphInteraction[];
  /** The owner's Notes section of the card, verbatim. */
  notes?: string | null;
  /** Projects only. */
  projectStatus?: ProjectStatus | null;
  etag: string;
}

export interface GraphSuggestion {
  id: string;
  kind: "merge" | "project";
  /** Merge: the two entities; project: the proposed name and its evidence. */
  entities: { id: string; name: string; detail?: string | null }[];
  proposedName?: string | null;
  /** Why Psyche thinks so, shown as "Because:" evidence. */
  reasons: string[];
  createdAt: string;
}

/** What a forget would remove (the `dryRun` result). */
export interface GraphForgetPreview {
  facts: number;
  loops: number;
  interactions: number;
  edges: number;
  mentions: number;
}

export interface GraphSourceStatus {
  source: "contacts" | "mail" | "calendar" | "messages" | "notes" | "chats";
  enabled: boolean;
  entities: number;
  interactions: number;
  lastIngestAt?: string | null;
}

export interface GraphStatus {
  enabled: boolean;
  sources: GraphSourceStatus[];
  lastModelPassAt?: string | null;
  /** Tokens used by the model pass tonight / the nightly cap. */
  budget: { used: number; cap: number };
  blocked: { id: string; label: string; blockedAt: string }[];
}
