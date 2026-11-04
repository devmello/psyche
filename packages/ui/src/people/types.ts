import type {
  EntitySummary,
  GraphEdgeRel,
  GraphEntityKind,
  GraphFactAttribute,
  GraphIdentifier,
  GraphInteractionKind,
  GraphLoopStatus,
  GraphProjectStatus,
  GraphProjectType,
  GraphWorkStatus,
  Provenance,
} from "@psyche/protocol";

/**
 * What the people and project cards render (docs/memory/people-and-projects-2026.md §6.5): the
 * PG0 protocol shapes (`@psyche/protocol` graph schemas) joined into one view, with names
 * resolved for the ids that facts, relations, loops and interactions point at. `adapt.ts` builds
 * it from `memory.entities.get`, `memory.entities.history` and the referenced entities.
 */

export type {
  EntitySummary,
  GraphEntityKind,
  GraphFactAttribute,
  GraphIdentifier,
  GraphInteractionKind,
  GraphLoopStatus,
};
export type ProjectStatus = GraphProjectStatus;
export type ProjectType = GraphProjectType;
export type WorkStatus = GraphWorkStatus;
export type GraphProvenance = Provenance;
export type GraphRel = GraphEdgeRel;

/** A pointer to another entity, resolved for display. */
export interface EntityRef {
  id: string;
  kind: GraphEntityKind;
  name: string;
}

/** Where a fact or loop came from, resolved from its source ids. */
export interface SourceView {
  kind: GraphInteractionKind | "contacts" | "owner";
  link?: string | null;
  /** Who sent it, for a claim in someone else's message ("From Sam's mail"). */
  from?: string | null;
  at?: string | null;
}

export interface FactView {
  id: string;
  attribute: GraphFactAttribute;
  value: string;
  provenance: GraphProvenance;
  /** The quoted span it came from (shown for untrusted claims). */
  evidence?: string | null;
  source?: SourceView | null;
  recordedAt: string;
}

export interface EdgeView {
  id: string;
  rel: GraphRel;
  /** The relationship label (`related_to`, from the owner or Contacts). */
  label?: string | null;
  provenance: GraphProvenance;
  other: EntityRef;
}

export interface InteractionView {
  id: string;
  kind: GraphInteractionKind;
  occurredAt: string;
  direction: "in" | "out" | "both" | "none";
  link?: string | null;
  /** Untrusted header text, at most 200 characters. */
  subject?: string | null;
  /** One line on what a conversation was about (people tier; sensitive ones never get here). */
  gist?: string | null;
  /** The gist was written from someone else's words (mail, messages, calls, meetings): quote it. */
  gistUntrusted?: boolean;
  /** The other people in it, by name. */
  with: string[];
}

export interface LoopView {
  id: string;
  direction: "i_owe" | "waiting_on";
  text: string;
  /** The quoted sentence it was detected from. */
  evidence?: string | null;
  counterpart?: EntityRef | null;
  project?: EntityRef | null;
  dueAt?: string | null;
  status: GraphLoopStatus;
  provenance: GraphProvenance;
  source?: SourceView | null;
}

export interface EntityView {
  id: string;
  kind: GraphEntityKind;
  name: string;
  aliases: string[];
  pinned: boolean;
  projectStatus?: ProjectStatus | null;
  /** A project or a course (docs/design/memory-everything-2026.md §2.2). */
  projectType?: ProjectType | null;
  /** An assignment's stored status; overdue, blocked and stale are computed by the card. */
  workStatus?: WorkStatus | null;
  /** When a project, course, assignment or event is due (ISO). */
  dueAt?: string | null;
  /** Keep private: shown on its Memory page only (§4). */
  private?: boolean;
  /** The last evidence the owner worked on it (§3.6). */
  lastSignalAt?: string | null;
  /** What a work item is part of: the course of an assignment, the project of an event. */
  parent?: EntityRef | null;
  /** Who set an assignment (`assigned_by`). */
  assignedBy?: EntityRef | null;
  /** A project's or course's assignments, as list rows. */
  assignments?: EntitySummary[];
  summary?: string | null;
  summaryAt?: string | null;
  lastInteractionAt?: string | null;
  identifiers: GraphIdentifier[];
  facts: FactView[];
  edges: EdgeView[];
  loops: LoopView[];
  interactions: InteractionView[];
  /** The owner's Notes section of the card file, when the host has it. */
  notes?: string | null;
}

export interface SuggestionView {
  id: string;
  kind: "merge" | "project" | "assignment";
  /** Merge: the entities; project: the proposed project; assignment: its title. */
  entities: { id: string; name: string; detail?: string | null }[];
  /** "Because:" lines, when the Gateway has them. */
  reasons: string[];
}
