import {
  type Clock,
  type EntitySummary,
  type EventPayload,
  type GraphAnchor,
  type GraphAnchorKind,
  type GraphBlocklistEntry,
  type GraphCitationSource,
  type GraphEdge,
  type GraphEdgeRel,
  GraphEdgeRel as GraphEdgeRelSchema,
  type GraphEntity,
  type GraphEntityDetail,
  type GraphEntityKind,
  type GraphFact,
  type GraphFactAttribute,
  GraphFactAttribute as GraphFactAttributeSchema,
  type GraphIdentifier,
  type GraphIdentifierKind,
  type GraphInteraction,
  type GraphInteractionKind,
  type GraphLoop,
  type GraphLoopStatus,
  type GraphParticipantRole,
  type GraphProjectStatus,
  type GraphProjectType,
  type GraphRelationshipLabel,
  type GraphRemovedCounts,
  type GraphReviewState,
  type GraphSensitivity,
  type GraphSource,
  type GraphStatus,
  type GraphSubjectKind,
  type GraphSuggestion,
  type GraphTimelineRow,
  type GraphWorkStatus,
  type GraphWriteSource,
  type Provenance,
  PsycheError,
} from "@psyche/protocol";
import type Database from "better-sqlite3";
import { monotonicFactory } from "ulid";
import { oneLine } from "../daily.ts";
import { cleanItemText } from "../extraction/clean.ts";
import { blockingKinds, looksLikeInstruction } from "../filters.ts";
import { trustRank } from "../provenance.ts";
import { safeName } from "./clean.ts";
import { blockHash, normalizeIdentifier, normalizeName, sha256, slugify } from "./normalize.ts";
import {
  isWorkKind,
  isWorkStatus,
  nextWorkStatus,
  PROGRESS_ATTRIBUTES,
  type WorkCause,
} from "./work.ts";

/**
 * The people and projects graph (docs/memory/people-and-projects-2026.md §4). The database is the
 * source of truth; card files are a projection (cards.ts). Every write enforces the allowlists,
 * the provenance rules and the sensitive filters, and keeps history instead of overwriting.
 */

/**
 * The attributes and relations the store accepts today. The protocol enums grew for everything
 * memory (docs/design/everything-memory-2026.md §4); the extra values stay refused here until
 * the phase that adds their supersession and review rules (EM1+), so adding them to the protocol
 * changes no behaviour.
 */
export const LIFE_ATTRIBUTES: ReadonlySet<string> = new Set([
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
]);
const LIFE_RELS: ReadonlySet<string> = new Set([
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
]);
export const FACT_ATTRIBUTES = (
  GraphFactAttributeSchema.enum as readonly GraphFactAttribute[]
).filter((a) => !LIFE_ATTRIBUTES.has(a));
export const EDGE_RELS = (GraphEdgeRelSchema.enum as readonly GraphEdgeRel[]).filter(
  (r) => !LIFE_RELS.has(r),
);

/** Set only by the owner (or Contacts, which the owner maintains): never inferred (§4.3). */
export const OWNER_ONLY_ATTRIBUTES: ReadonlySet<GraphFactAttribute> = new Set([
  "birthday",
  "relationship_to_owner",
  "preference",
  "note",
  "budget_note",
]);
/** Attributes that hold several values at once (the rest supersede). */
export const MULTI_VALUED: ReadonlySet<GraphFactAttribute> = new Set([
  "preference",
  "note",
  "progress",
]);
/**
 * Work state on an assignment (docs/design/memory-everything-2026.md §3.4, W1): written only by
 * the owner or a rule (`system`). Text from others reaches these through suggestions and asks.
 */
const ASSIGNMENT_STATE_ATTRIBUTES: ReadonlySet<GraphFactAttribute> = new Set([
  "status",
  "deadline",
  "next_step",
  "stopped_at",
  "progress",
  "blocked_on",
]);
/** Attributes that say the owner was at work on the item: they refresh `last_signal_at`. */
const SIGNAL_ATTRIBUTES: ReadonlySet<GraphFactAttribute> = new Set([
  "progress",
  "stopped_at",
  "next_step",
  "blocked_on",
]);
/** Relations that carry a personal label: owner or Contacts only (§4.4). */
export const OWNER_ONLY_RELS: ReadonlySet<GraphEdgeRel> = new Set(["related_to", "reports_to"]);
/** Which kinds each relation connects. */
const REL_KINDS: Partial<Record<GraphEdgeRel, [GraphEntityKind[], GraphEntityKind[]]>> = {
  works_at: [["person"], ["org"]],
  member_of: [["person"], ["project"]],
  stakeholder_of: [["person", "org"], ["project"]],
  located_at: [["person", "org", "project"], ["place"]],
  reports_to: [["person"], ["person"]],
  related_to: [["person"], ["person"]],
  part_of: [["project", "assignment", "event"], ["project"]],
  assigned_by: [["assignment"], ["person", "org"]],
  teaches: [["person"], ["project"]],
};
/** Relations where a source has one target at a time (a new one replaces the old). */
const SINGLE_TARGET_RELS: ReadonlySet<GraphEdgeRel> = new Set([
  "works_at",
  "reports_to",
  "assigned_by",
]);

/** Review states that count as known (everything memory §4.3). */
export const ACCEPTED_REVIEW_SQL = "('accepted', 'auto_accepted', 'edited')";

const SUMMARY_CHARS = 400;
const SUBJECT_CHARS = 200;
const EVIDENCE_CHARS = 200;
const DAY_MS = 86_400_000;

export type GraphEvent =
  | { event: "memory.entity.updated"; payload: EventPayload<"memory.entity.updated"> }
  | { event: "memory.loop.updated"; payload: EventPayload<"memory.loop.updated"> }
  | { event: "memory.suggestion.created"; payload: EventPayload<"memory.suggestion.created"> };

export interface GraphStoreOptions {
  sqlite: Database.Database;
  clock?: Clock;
  newId?: () => string;
  onEvent?: (event: GraphEvent) => void;
  /** Country code for national phone numbers (default "1"). */
  defaultCountry?: string;
  /** Interaction retention (default 540 days, §4.9). */
  interactionRetentionDays?: number;
}

export interface FactInput {
  entityId: string;
  attribute: GraphFactAttribute;
  value: string;
  provenance: Provenance;
  confidence?: number;
  sources?: string[];
  evidence?: string | null;
  source?: GraphWriteSource;
  /** `deterministic` for a rule's fact; the default is the owner's words. */
  subjectKind?: GraphSubjectKind;
}

export interface EdgeInput {
  src: string;
  rel: GraphEdgeRel;
  dst: string;
  label?: GraphRelationshipLabel;
  provenance: Provenance;
  confidence?: number;
  sources?: string[];
  source?: GraphWriteSource;
}

export interface ParticipantInput {
  entityId: string;
  role: GraphParticipantRole;
}

export interface InteractionInput {
  kind: GraphInteractionKind;
  source: string;
  externalRef: string;
  occurredAt: string;
  direction: GraphInteraction["direction"];
  subject?: string | null;
  threadKey?: string | null;
  link?: string | null;
  projectId?: string | null;
  participants: ParticipantInput[];
  /** Other items this belongs to (an assignment as well as its course), §2.6. */
  subjects?: SubjectInput[];
  /** One line on what a conversation was about (≤ 120 characters). */
  gist?: string | null;
}

export interface SubjectInput {
  entityId: string;
  linkedBy?: GraphInteractionSubjectLinkedBy;
  confidence?: number;
}

export type GraphInteractionSubjectLinkedBy = "rule" | "owner" | "model";

export interface LoopInput {
  direction: GraphLoop["direction"];
  text: string;
  evidence?: string | null;
  counterpartId?: string | null;
  projectId?: string | null;
  dueAt?: string | null;
  status: GraphLoopStatus;
  sourceInteractionId?: string | null;
  provenance: Provenance;
  confidence?: number;
  detectedBy: GraphLoop["detectedBy"];
}

interface EntityRow {
  id: string;
  kind: GraphEntityKind;
  name: string;
  sort_name: string;
  status: GraphEntity["status"];
  merged_into: string | null;
  is_owner: number;
  pinned: number;
  hidden: number;
  project_status: GraphProjectStatus | null;
  due_at: string | null;
  summary: string | null;
  summary_at: string | null;
  summary_hash: string | null;
  notes: string | null;
  last_interaction_at: string | null;
  card_path: string | null;
  created_at: string;
  updated_at: string;
  project_type: GraphProjectType;
  work_status: GraphWorkStatus | null;
  last_signal_at: string | null;
  private: number;
}

interface FactRow {
  id: string;
  entity_id: string;
  attribute: GraphFactAttribute;
  value: string;
  provenance: Provenance;
  confidence: number;
  sources: string;
  evidence: string | null;
  valid_from: string;
  valid_to: string | null;
  recorded_at: string;
  superseded_by: string | null;
  retracted_at: string | null;
  subject_kind: GraphSubjectKind;
  sensitivity: GraphSensitivity;
  review: GraphReviewState;
  first_seen_at: string | null;
  last_seen_at: string | null;
  run_id: string | null;
  extractor: string | null;
}

interface EdgeRow {
  id: string;
  src: string;
  dst: string;
  rel: GraphEdgeRel;
  label: GraphRelationshipLabel | null;
  provenance: Provenance;
  confidence: number;
  sources: string;
  valid_from: string;
  valid_to: string | null;
  superseded_by: string | null;
  retracted_at: string | null;
}

interface LoopRow {
  id: string;
  direction: GraphLoop["direction"];
  text: string;
  evidence: string | null;
  counterpart_id: string | null;
  project_id: string | null;
  due_at: string | null;
  status: GraphLoopStatus;
  source_interaction_id: string | null;
  provenance: Provenance;
  confidence: number;
  detected_by: GraphLoop["detectedBy"];
  dedupe_key: string;
  created_at: string;
  closed_at: string | null;
  closed_by: GraphLoop["closedBy"] | null;
}

function fail(code: PsycheError["code"], message: string): never {
  throw new PsycheError(code, message);
}

/** Thrown inside a transaction to roll back a dry run. */
class RollbackSignal extends Error {}

/** Interaction kinds each source produces (`memory.graph.status`, `deleteSource`). */
export const SOURCE_KINDS: Record<GraphSource, GraphInteractionKind[]> = {
  contacts: [],
  mail: ["mail"],
  calendar: ["meeting"],
  messages: ["message", "call"],
  notes: ["note"],
  chats: ["chat"],
};

/** Prefixes of fact and relation sources that are not interactions. */
const SOURCE_REF_PREFIX: Partial<Record<GraphSource, string>> = {
  contacts: "contact:",
  chats: "chat:",
};

/** SQL over `source` of identifiers and aliases written by a source's ingest. */
const SOURCE_COLUMN_MATCH: Record<GraphSource, string> = {
  contacts: "source = 'contacts'",
  mail: "(source = 'mail' OR source LIKE '%mail%')",
  calendar: "(source = 'calendar' OR source LIKE '%calendar%')",
  // Messages identifiers carry the channel's connector id (imessage, telegram, ...).
  messages:
    "(source NOT IN ('contacts', 'mail', 'calendar', 'owner', 'system', 'model', 'rule') AND source NOT LIKE '%mail%' AND source NOT LIKE '%calendar%' AND source NOT LIKE '%note%' AND source NOT LIKE 'chat:%')",
  notes: "source LIKE '%note%'",
  chats: "source LIKE 'chat:%'",
};

/** What Settings shows for a hashed blocklist entry: never the whole address or number. */
function maskHint(kind: string, norm: string): string | null {
  if (kind === "domain") return norm;
  if (kind === "email") {
    const [local = "", domain = ""] = norm.split("@");
    return `${local.slice(0, 1)}•••@${domain}`;
  }
  if (kind === "phone") return `•••${norm.slice(-2)}`;
  return null;
}

function clip(text: string | null | undefined, max: number): string | null {
  if (text === null || text === undefined) return null;
  const t = oneLine(text);
  return t.length === 0 ? null : t.slice(0, max);
}

const toBool = (n: number) => n === 1;

const isControlChar = (ch: string): boolean => {
  const c = ch.codePointAt(0) as number;
  return c < 0x20 || c === 0x7f;
};

const ISO_LIKE =
  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

/**
 * A due date as a UTC ISO string, or null when the text is not an ISO date or date-time. A bare
 * date is midnight UTC and a time without a zone is UTC, so the result never depends on the host.
 */
export function normalizeDueAt(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const text = value.trim();
  const m = ISO_LIKE.exec(text);
  if (m === null) return null;
  const withZone = m[1] === undefined && text.length > 10 ? `${text.replace(" ", "T")}Z` : text;
  const t = Date.parse(withZone);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

function toEntity(r: EntityRow, aliases: string[]): GraphEntity {
  return {
    id: r.id,
    kind: r.kind,
    name: r.name,
    aliases,
    status: r.status,
    mergedInto: r.merged_into,
    isOwner: toBool(r.is_owner),
    pinned: toBool(r.pinned),
    hidden: toBool(r.hidden),
    ...(r.project_status === null ? {} : { projectStatus: r.project_status }),
    dueAt: r.due_at,
    ...(r.kind === "project" ? { projectType: r.project_type } : {}),
    ...(r.kind === "assignment" ? { workStatus: r.work_status } : {}),
    ...(r.last_signal_at === null ? {} : { lastSignalAt: r.last_signal_at }),
    ...(r.private === 1 ? { private: true } : {}),
    summary: r.summary,
    summaryAt: r.summary_at,
    lastInteractionAt: r.last_interaction_at,
    cardPath: r.card_path,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toFact(r: FactRow): GraphFact {
  return {
    id: r.id,
    entityId: r.entity_id,
    attribute: r.attribute,
    value: r.value,
    provenance: r.provenance,
    confidence: r.confidence,
    sources: JSON.parse(r.sources) as string[],
    evidence: r.evidence,
    validFrom: r.valid_from,
    validTo: r.valid_to,
    recordedAt: r.recorded_at,
    supersededBy: r.superseded_by,
    retractedAt: r.retracted_at,
    subjectKind: r.subject_kind,
    sensitivity: r.sensitivity,
    review: r.review,
    ...(r.first_seen_at === null ? {} : { firstSeenAt: r.first_seen_at }),
    ...(r.last_seen_at === null ? {} : { lastSeenAt: r.last_seen_at }),
    runId: r.run_id,
    ...(r.extractor === null ? {} : { extractor: r.extractor }),
  };
}

function toEdge(r: EdgeRow): GraphEdge {
  return {
    id: r.id,
    src: r.src,
    dst: r.dst,
    rel: r.rel,
    ...(r.label === null ? {} : { label: r.label }),
    provenance: r.provenance,
    confidence: r.confidence,
    sources: JSON.parse(r.sources) as string[],
    validFrom: r.valid_from,
    validTo: r.valid_to,
    supersededBy: r.superseded_by,
    retractedAt: r.retracted_at,
  };
}

function toLoop(r: LoopRow): GraphLoop {
  return {
    id: r.id,
    direction: r.direction,
    text: r.text,
    evidence: r.evidence,
    counterpartId: r.counterpart_id,
    projectId: r.project_id,
    dueAt: r.due_at,
    status: r.status,
    sourceInteractionId: r.source_interaction_id,
    provenance: r.provenance,
    confidence: r.confidence,
    detectedBy: r.detected_by,
    createdAt: r.created_at,
    closedAt: r.closed_at,
    closedBy: r.closed_by ?? null,
  };
}

interface AnchorRow {
  id: string;
  entity_id: string;
  kind: GraphAnchorKind;
  ref: string;
  label: string;
  added_by: GraphAnchor["addedBy"];
  confirmed: number;
  created_at: string;
}

function toAnchor(r: AnchorRow): GraphAnchor {
  return {
    id: r.id,
    entityId: r.entity_id,
    kind: r.kind,
    ref: r.ref,
    label: r.label,
    addedBy: r.added_by,
    confirmed: r.confirmed === 1,
    createdAt: r.created_at,
  };
}

interface InteractionRow {
  id: string;
  kind: GraphInteractionKind;
  source: string;
  occurred_at: string;
  direction: GraphInteraction["direction"];
  subject: string | null;
  link: string | null;
  gist: string | null;
}

const WORK_FACTS_SQL = "'status', 'deadline', 'next_step', 'stopped_at', 'progress', 'blocked_on'";

const STATUS_LABELS: Record<string, string> = {
  not_started: "not started",
  in_progress: "in progress",
  submitted: "handed in",
  done: "done",
  dropped: "dropped",
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `Nov 9` for an ISO date; anything else is cleaned and shown as written. */
function shortDate(value: string): string {
  const iso = normalizeDueAt(value);
  if (iso === null) return safeName(value, 60);
  const d = new Date(iso);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

const INTERACTION_SOURCE: Partial<Record<GraphInteractionKind, GraphCitationSource>> = {
  mail: "mail",
  message: "messages",
  call: "messages",
  meeting: "calendar",
  note: "notes",
  chat: "chats",
  file: "files",
  reminder: "reminders",
};

/**
 * Whose words a row carries. Mail, messages and calendar items are others' text until the owner
 * says otherwise; the owner's own sent mail, notes, chats, files and reminders are theirs, and
 * Psyche's runs are the agent's.
 */
function interactionProvenance(kind: GraphInteractionKind, direction: string): Provenance {
  if (kind === "task" || kind === "work") return "agent";
  if (kind === "note" || kind === "chat" || kind === "file" || kind === "reminder") return "owner";
  return direction === "out" ? "owner" : "untrusted";
}

function interactionTimelineRow(
  r: InteractionRow,
  entityId: string,
  sender: string | undefined,
): GraphTimelineRow {
  const title = r.subject === null ? "" : safeName(r.subject, 120);
  const quoted = title === "" ? "" : `: “${title}”`;
  let text: string;
  switch (r.kind) {
    case "mail":
      text = r.direction === "out" ? `You sent mail${quoted}` : `New mail${quoted}`;
      break;
    case "message":
    case "call":
      text = r.direction === "out" ? `You messaged${quoted}` : `New message${quoted}`;
      break;
    case "meeting":
      text = `Meeting${quoted}`;
      break;
    case "note":
      text = `Note${quoted}`;
      break;
    case "chat":
      text = r.gist === null ? `Chat with Psyche${quoted}` : `Chat: ${safeName(r.gist, 120)}`;
      break;
    case "file":
      text = title === "" ? "Edited files" : `Edited ${title}`;
      break;
    case "reminder":
      text = `Reminders${quoted}`;
      break;
    default:
      text = title === "" ? "Psyche worked on this" : `Psyche worked on this${quoted}`;
  }
  const source = INTERACTION_SOURCE[r.kind];
  return {
    id: r.id,
    at: r.occurred_at,
    kind: "interaction",
    interactionKind: r.kind,
    entityId,
    text: text.slice(0, 400),
    provenance: interactionProvenance(r.kind, r.direction),
    chip:
      source === undefined
        ? null
        : {
            source,
            label: safeName(sender ?? r.source, 200),
            citationId: null,
            link: r.link,
          },
  };
}

function factTimelineRow(
  f: FactRow,
  entityId: string,
  prior: FactRow | undefined,
  cite:
    | {
        id: string;
        source: GraphCitationSource;
        source_ref: string;
        author_entity_id: string | null;
      }
    | undefined,
  author: string | undefined,
): GraphTimelineRow {
  const value = f.attribute === "deadline" ? shortDate(f.value) : safeName(f.value, 160);
  const from = prior?.value ?? null;
  let text: string;
  switch (f.attribute) {
    case "deadline":
      text =
        prior === undefined
          ? `Due ${value}`
          : `Due date moved ${shortDate(prior.value)} → ${value}`;
      break;
    case "status":
      text =
        prior === undefined
          ? `Marked ${STATUS_LABELS[f.value] ?? safeName(f.value, 40)}`
          : `Status ${STATUS_LABELS[prior.value] ?? safeName(prior.value, 40)} → ${STATUS_LABELS[f.value] ?? safeName(f.value, 40)}`;
      break;
    case "progress":
      text = `Progress: ${value}`;
      break;
    case "stopped_at":
      text = `Stopped at ${value}`;
      break;
    case "next_step":
      text = `Next step: ${value}`;
      break;
    default:
      text = `Blocked on ${value}`;
  }
  return {
    id: f.id,
    at: f.recorded_at,
    kind: "fact",
    entityId,
    text: text.slice(0, 400),
    provenance: f.provenance,
    change: { attribute: f.attribute, from, to: f.value },
    chip:
      cite === undefined
        ? null
        : {
            source: cite.source,
            label: safeName(author ?? cite.source_ref, 200),
            citationId: cite.id,
            link: null,
          },
  };
}

function loopTimelineRow(l: LoopRow & { counterpart_name: string | null }): GraphTimelineRow {
  const who = l.counterpart_name === null ? "" : safeName(l.counterpart_name, 60);
  const what = safeName(l.text, 200);
  const lead =
    l.direction === "waiting_on"
      ? who === ""
        ? "Waiting on a reply"
        : `Waiting on ${who}`
      : who === ""
        ? "You owe"
        : `You owe ${who}`;
  return {
    id: l.id,
    at: l.created_at,
    kind: "loop",
    entityId: l.project_id ?? "",
    text: `${lead}: ${what}${l.status === "done" ? " (done)" : ""}`.slice(0, 400),
    provenance: l.provenance,
    chip: null,
  };
}

function sourceRef(source: GraphWriteSource | undefined): string[] {
  if (source === undefined) return [];
  return [source.ref === undefined ? source.kind : `${source.kind}:${source.ref}`];
}

/** The value key of a correction: never holds third-party text, only a hash. */
export function factKeyHash(attribute: string, value: string): string {
  return sha256(`${attribute}\n${normalizeName(value)}`);
}

export class GraphStore {
  readonly #db: Database.Database;
  readonly #clock: Clock;
  readonly #newId: () => string;
  readonly #onEvent: ((e: GraphEvent) => void) | undefined;
  readonly #country: string;
  readonly #retentionDays: number;

  constructor(options: GraphStoreOptions) {
    this.#db = options.sqlite;
    this.#clock = options.clock ?? { now: () => Date.now() };
    const ulid = monotonicFactory();
    this.#newId = options.newId ?? (() => ulid());
    this.#onEvent = options.onEvent;
    this.#country = options.defaultCountry ?? "1";
    this.#retentionDays = options.interactionRetentionDays ?? 540;
  }

  #now(): string {
    return new Date(this.#clock.now()).toISOString();
  }

  #id(prefix: string): string {
    return `${prefix}_${this.#newId()}`;
  }

  #emit(event: GraphEvent): void {
    try {
      this.#onEvent?.(event);
    } catch {
      // listeners never break writes
    }
  }

  #touched(id: string, changed: string[]): void {
    const row = this.#entityRow(id);
    if (row === undefined) return;
    this.#db.prepare("UPDATE graph_entities SET updated_at = ? WHERE id = ?").run(this.#now(), id);
    this.#reindex(id);
    this.#emit({ event: "memory.entity.updated", payload: { id, kind: row.kind, changed } });
  }

  /** Reindexes an entity and emits `memory.entity.updated` after a write made outside this class. */
  touch(id: string, changed: string[]): void {
    this.#touched(id, changed);
  }

  // --- entities --------------------------------------------------------------------------------

  #entityRow(id: string): EntityRow | undefined {
    return this.#db.prepare("SELECT * FROM graph_entities WHERE id = ?").get(id) as
      | EntityRow
      | undefined;
  }

  #aliases(id: string): string[] {
    return (
      this.#db
        .prepare("SELECT alias FROM graph_aliases WHERE entity_id = ? ORDER BY created_at, alias")
        .all(id) as { alias: string }[]
    ).map((r) => r.alias);
  }

  getEntity(id: string): GraphEntity | undefined {
    const row = this.#entityRow(id);
    return row === undefined ? undefined : toEntity(row, this.#aliases(id));
  }

  /** The entity a merged id now lives in. */
  resolveMerged(id: string): string {
    let current = id;
    for (let i = 0; i < 10; i++) {
      const row = this.#entityRow(current);
      if (row?.merged_into === null || row?.merged_into === undefined) return current;
      current = row.merged_into;
    }
    return current;
  }

  createEntity(input: {
    kind: GraphEntityKind;
    name: string;
    aliases?: string[];
    identifiers?: { kind: GraphIdentifierKind; value: string }[];
    projectStatus?: GraphProjectStatus;
    /** Project, assignment or event: when it is due (an ISO date-time). */
    dueAt?: string | null;
    projectType?: GraphProjectType;
    private?: boolean;
    isOwner?: boolean;
    source?: string;
    linkedBy?: GraphIdentifier["linkedBy"];
    verified?: boolean;
  }): GraphEntity {
    const name = clip(input.name, 200);
    if (name === null) fail("invalid_params", "an entity needs a name");
    if (blockingKinds(name, true).length > 0)
      fail("policy_denied", "names cannot hold credentials");
    const source = input.source ?? "owner";
    for (const ident of input.identifiers ?? []) {
      const norm = normalizeIdentifier(ident.kind, ident.value, this.#country);
      if (norm === undefined) fail("invalid_params", `invalid ${ident.kind}`);
      const owner = this.resolveIdentifier(ident.kind, ident.value);
      if (owner !== undefined) fail("conflict", `that ${ident.kind} already belongs to ${owner}`);
      if (input.linkedBy !== "owner" && this.isBlocked(ident.kind, ident.value)) {
        fail("policy_denied", `that ${ident.kind} was forgotten`);
      }
    }
    if (input.isOwner === true && this.ownerEntity() !== undefined) {
      fail("conflict", "the owner already has an entity");
    }
    const dueAt = normalizeDueAt(input.dueAt);
    if (input.dueAt !== undefined && input.dueAt !== null && dueAt === null)
      fail("invalid_params", "dueAt must be a date and time");
    if (dueAt !== null && !isWorkKind(input.kind))
      fail("invalid_params", "only a project, to-do or event has a due date");
    if (input.projectType === "course" && input.kind !== "project")
      fail("invalid_params", "only a project can be a course");
    const id = this.#id("ent");
    const now = this.#now();
    this.#db.transaction(() => {
      this.#db
        .prepare(
          `INSERT INTO graph_entities (id, kind, name, sort_name, is_owner, project_status, due_at, project_type,
             work_status, last_signal_at, private, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.kind,
          name,
          normalizeName(name),
          input.isOwner === true ? 1 : 0,
          input.kind === "project" ? (input.projectStatus ?? "active") : null,
          dueAt,
          input.kind === "project" ? (input.projectType ?? "project") : "project",
          input.kind === "assignment" ? "not_started" : null,
          // Creating a work item is the owner (or an accepted suggestion) saying it exists; it
          // starts fresh instead of stale.
          input.kind === "project" || input.kind === "assignment" ? now : null,
          input.private === true && isWorkKind(input.kind) ? 1 : 0,
          now,
          now,
        );
      if (dueAt !== null && input.kind !== "event") {
        this.setFact({
          entityId: id,
          attribute: "deadline",
          value: dueAt,
          provenance: "owner",
          source: { kind: "owner_edit" },
        });
      }
      for (const a of input.aliases ?? []) this.addAlias(id, a, source);
      for (const ident of input.identifiers ?? []) {
        this.linkIdentifier(id, ident.kind, ident.value, {
          source,
          linkedBy: input.linkedBy ?? "owner",
          verified: input.verified ?? input.linkedBy === "owner",
        });
      }
    })();
    this.#reindex(id);
    this.#emit({
      event: "memory.entity.updated",
      payload: { id, kind: input.kind, changed: ["created"] },
    });
    return this.getEntity(id) as GraphEntity;
  }

  ownerEntity(): GraphEntity | undefined {
    const row = this.#db.prepare("SELECT * FROM graph_entities WHERE is_owner = 1").get() as
      | EntityRow
      | undefined;
    return row === undefined ? undefined : toEntity(row, this.#aliases(row.id));
  }

  updateEntity(
    id: string,
    patch: {
      name?: string;
      aliases?: string[];
      status?: GraphEntity["status"];
      projectStatus?: GraphProjectStatus;
      dueAt?: string | null;
      projectType?: GraphProjectType;
      private?: boolean;
      pinned?: boolean;
      hidden?: boolean;
      notes?: string | null;
    },
  ): GraphEntity {
    const row = this.#entityRow(id);
    if (row === undefined) fail("not_found", "no such entity");
    const changed: string[] = [];
    const now = this.#now();
    this.#db.transaction(() => {
      if (patch.name !== undefined) {
        const name = clip(patch.name, 200);
        if (name === null) fail("invalid_params", "an entity needs a name");
        if (name !== row.name) {
          // The old name stays findable as an alias.
          this.addAlias(id, row.name, "owner");
          this.#db
            .prepare("UPDATE graph_entities SET name = ?, sort_name = ? WHERE id = ?")
            .run(name, normalizeName(name), id);
          this.#feedback("rename", id, null, null);
          changed.push("name");
        }
      }
      if (patch.aliases !== undefined) {
        this.#db.prepare("DELETE FROM graph_aliases WHERE entity_id = ?").run(id);
        for (const a of patch.aliases) this.addAlias(id, a, "owner");
        changed.push("aliases");
      }
      const dueAt = normalizeDueAt(patch.dueAt);
      if (patch.dueAt !== undefined && patch.dueAt !== null && dueAt === null)
        fail("invalid_params", "dueAt must be a date and time");
      if (patch.projectType === "course" && row.kind !== "project")
        fail("invalid_params", "only a project can be a course");
      const flags: [keyof typeof patch, string, unknown][] = [
        ["status", "status", patch.status],
        ["projectStatus", "project_status", patch.projectStatus],
        ["dueAt", "due_at", patch.dueAt === undefined ? undefined : dueAt],
        ["projectType", "project_type", patch.projectType],
        ["private", "private", patch.private === undefined ? undefined : patch.private ? 1 : 0],
        ["pinned", "pinned", patch.pinned === undefined ? undefined : patch.pinned ? 1 : 0],
        ["hidden", "hidden", patch.hidden === undefined ? undefined : patch.hidden ? 1 : 0],
        ["notes", "notes", patch.notes],
      ];
      for (const [key, column, value] of flags) {
        if (value === undefined) continue;
        if ((key === "projectStatus" || key === "projectType") && row.kind !== "project") continue;
        if (key === "private" && !isWorkKind(row.kind)) continue;
        if (key === "dueAt" && !isWorkKind(row.kind)) {
          fail("invalid_params", "only a project, to-do or event has a due date");
        }
        if (
          key === "notes" &&
          typeof value === "string" &&
          blockingKinds(value, false).length > 0
        ) {
          fail(
            "policy_denied",
            "notes cannot hold credentials, card or account numbers, ids or health details",
          );
        }
        this.#db.prepare(`UPDATE graph_entities SET ${column} = ? WHERE id = ?`).run(value, id);
        changed.push(key);
        if (key === "dueAt" && row.kind !== "event") this.#recordDeadline(id, dueAt);
      }
      if (
        patch.projectStatus === "done" &&
        row.kind === "project" &&
        row.project_status !== "done"
      ) {
        this.#closeAssignmentsOf(id);
      }
      if (patch.hidden === true) {
        // Don't track: block every identifier so ingest stores nothing new about them.
        for (const ident of this.identifiers(id)) this.#block(ident.kind, ident.value);
      }
      this.#db.prepare("UPDATE graph_entities SET updated_at = ? WHERE id = ?").run(now, id);
    })();
    if (changed.length > 0) this.#touched(id, changed);
    return this.getEntity(id) as GraphEntity;
  }

  setSummary(id: string, summary: string, inputHash: string): void {
    const text = clip(summary, SUMMARY_CHARS);
    if (text === null || blockingKinds(text, false).length > 0 || looksLikeInstruction(text)) {
      return;
    }
    this.#db
      .prepare(
        "UPDATE graph_entities SET summary = ?, summary_at = ?, summary_hash = ? WHERE id = ?",
      )
      .run(text, this.#now(), inputHash, id);
    this.#touched(id, ["summary"]);
  }

  /** Records a model pass that produced no usable summary, so unchanged input is skipped. */
  markModelPass(id: string, inputHash: string): void {
    this.#db
      .prepare("UPDATE graph_entities SET summary_at = ?, summary_hash = ? WHERE id = ?")
      .run(this.#now(), inputHash, id);
  }

  summaryHash(id: string): string | null {
    return this.#entityRow(id)?.summary_hash ?? null;
  }

  notes(id: string): string | null {
    return this.#entityRow(id)?.notes ?? null;
  }

  setCardPath(id: string, path: string | null): void {
    this.#db.prepare("UPDATE graph_entities SET card_path = ? WHERE id = ?").run(path, id);
  }

  entityByCardPath(path: string): GraphEntity | undefined {
    const row = this.#db.prepare("SELECT * FROM graph_entities WHERE card_path = ?").get(path) as
      | EntityRow
      | undefined;
    return row === undefined ? undefined : toEntity(row, this.#aliases(row.id));
  }

  /** A free card path for an entity: `people/sam-lee.md`, `people/sam-lee-2.md`, … */
  cardPathFor(entity: GraphEntity): string {
    const dir =
      entity.kind === "project"
        ? "projects"
        : entity.kind === "person"
          ? "people"
          : entity.kind === "org"
            ? "people/orgs"
            : "people/places";
    const base = slugify(entity.name);
    for (let n = 1; n < 1000; n++) {
      const path = `${dir}/${n === 1 ? base : `${base}-${n}`}.md`;
      const owner = this.entityByCardPath(path);
      if (owner === undefined || owner.id === entity.id) return path;
    }
    return `${dir}/${entity.id}.md`;
  }

  addAlias(id: string, alias: string, source: string): void {
    const text = clip(alias, 200);
    if (text === null) return;
    const norm = normalizeName(text);
    if (norm.length === 0) return;
    this.#db
      .prepare(
        "INSERT OR IGNORE INTO graph_aliases (entity_id, alias_norm, alias, source, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(id, norm, text, source, this.#now());
  }

  // --- identifiers -----------------------------------------------------------------------------

  identifiers(id: string): GraphIdentifier[] {
    return (
      this.#db
        .prepare("SELECT * FROM graph_identifiers WHERE entity_id = ? ORDER BY kind, value_display")
        .all(id) as {
        kind: GraphIdentifierKind;
        value_norm: string;
        value_display: string;
        entity_id: string;
        source: string;
        linked_by: GraphIdentifier["linkedBy"];
        verified: number;
        shared: number;
        created_at: string;
      }[]
    ).map((r) => ({
      kind: r.kind,
      value: r.value_display,
      entityId: r.entity_id,
      source: r.source,
      linkedBy: r.linked_by,
      verified: toBool(r.verified),
      shared: toBool(r.shared),
      createdAt: r.created_at,
    }));
  }

  /** The entity an identifier belongs to (shared identifiers resolve to nobody on their own). */
  resolveIdentifier(kind: GraphIdentifierKind, value: string): string | undefined {
    const norm = normalizeIdentifier(kind, value, this.#country);
    if (norm === undefined) return undefined;
    const row = this.#db
      .prepare("SELECT entity_id, shared FROM graph_identifiers WHERE kind = ? AND value_norm = ?")
      .get(kind, norm) as { entity_id: string; shared: number } | undefined;
    if (row === undefined || row.shared === 1) return undefined;
    return this.resolveMerged(row.entity_id);
  }

  linkIdentifier(
    id: string,
    kind: GraphIdentifierKind,
    value: string,
    opts: { source: string; linkedBy: GraphIdentifier["linkedBy"]; verified?: boolean },
  ): void {
    const norm = normalizeIdentifier(kind, value, this.#country);
    if (norm === undefined) fail("invalid_params", `invalid ${kind}`);
    const existing = this.#db
      .prepare("SELECT entity_id FROM graph_identifiers WHERE kind = ? AND value_norm = ?")
      .get(kind, norm) as { entity_id: string } | undefined;
    if (existing !== undefined) {
      if (this.resolveMerged(existing.entity_id) === id) return;
      fail("conflict", `that ${kind} already belongs to another entity`);
    }
    this.#db
      .prepare(
        `INSERT INTO graph_identifiers (kind, value_norm, value_display, entity_id, source, linked_by, verified, shared, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      )
      .run(
        kind,
        norm,
        value.trim(),
        id,
        opts.source,
        opts.linkedBy,
        opts.verified === true ? 1 : 0,
        this.#now(),
      );
  }

  unlinkIdentifier(kind: GraphIdentifierKind, value: string): void {
    const norm = normalizeIdentifier(kind, value, this.#country);
    if (norm === undefined) return;
    this.#db
      .prepare("DELETE FROM graph_identifiers WHERE kind = ? AND value_norm = ?")
      .run(kind, norm);
  }

  /** An address seen with several display names (a family or team inbox) never resolves alone. */
  markShared(kind: GraphIdentifierKind, value: string): void {
    const norm = normalizeIdentifier(kind, value, this.#country);
    if (norm === undefined) return;
    this.#db
      .prepare("UPDATE graph_identifiers SET shared = 1 WHERE kind = ? AND value_norm = ?")
      .run(kind, norm);
  }

  #block(kind: string, valueDisplay: string): GraphBlocklistEntry | undefined {
    const norm = normalizeIdentifier(kind as GraphIdentifierKind, valueDisplay, this.#country);
    if (norm === undefined) return undefined;
    const hash = blockHash(kind, norm);
    this.#db
      .prepare(
        "INSERT OR IGNORE INTO graph_blocklist (kind, value_hash, created_at, hint) VALUES (?, ?, ?, ?)",
      )
      .run(kind, hash, this.#now(), maskHint(kind, norm));
    return this.blocklist().find((e) => e.id === `${kind}:${hash}`);
  }

  /** A blocked email's domain blocks it too ("never model anyone at acme.com"). */
  isBlocked(kind: GraphIdentifierKind, value: string): boolean {
    const norm = normalizeIdentifier(kind, value, this.#country);
    if (norm === undefined) return false;
    const has = (k: string, v: string) =>
      this.#db
        .prepare("SELECT 1 FROM graph_blocklist WHERE kind = ? AND value_hash = ?")
        .get(k, blockHash(k, v)) !== undefined;
    if (has(kind, norm)) return true;
    const domain = kind === "email" ? norm.split("@")[1] : undefined;
    return domain !== undefined && has("domain", domain);
  }

  /** Every blocklisted identifier, newest first, with its masked hint (§4.9). */
  blocklist(): GraphBlocklistEntry[] {
    const rows = this.#db
      .prepare(
        "SELECT kind, value_hash, created_at, hint FROM graph_blocklist ORDER BY created_at DESC, kind, value_hash",
      )
      .all() as { kind: string; value_hash: string; created_at: string; hint: string | null }[];
    return rows.map((r) => ({
      id: `${r.kind}:${r.value_hash}`,
      kind: r.kind as GraphIdentifierKind,
      hint: r.hint,
      createdAt: r.created_at,
    }));
  }

  /** The owner blocks an address, phone or domain; an existing card stays until forgotten. */
  block(kind: "email" | "phone" | "domain", value: string): GraphBlocklistEntry {
    if (
      kind === "domain" &&
      !/^(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}\.?$/i.test(value.trim())
    )
      fail("invalid_params", "not a valid domain");
    const entry = this.#block(kind, value);
    if (entry === undefined) fail("invalid_params", `not a valid ${kind}`);
    return entry;
  }

  /** Removes a blocklist entry by its id (`memory.graph.blocklist.remove`). */
  unblockId(id: string): boolean {
    const at = id.indexOf(":");
    if (at <= 0) return false;
    return (
      this.#db
        .prepare("DELETE FROM graph_blocklist WHERE kind = ? AND value_hash = ?")
        .run(id.slice(0, at), id.slice(at + 1)).changes > 0
    );
  }

  unblock(kind: GraphIdentifierKind, value: string): boolean {
    const norm = normalizeIdentifier(kind, value, this.#country);
    if (norm === undefined) return false;
    return (
      this.#db
        .prepare("DELETE FROM graph_blocklist WHERE kind = ? AND value_hash = ?")
        .run(kind, blockHash(kind, norm)).changes > 0
    );
  }

  // --- facts -----------------------------------------------------------------------------------

  #factRows(entityId: string, current: boolean, attribute?: GraphFactAttribute): FactRow[] {
    const where = [
      "entity_id = ?",
      ...(current
        ? [
            "superseded_by IS NULL",
            "retracted_at IS NULL",
            "(valid_to IS NULL OR valid_to > ?)",
            // Proposed, discarded and quarantined facts are not part of what Psyche knows.
            `review IN ${ACCEPTED_REVIEW_SQL}`,
          ]
        : []),
      ...(attribute === undefined ? [] : ["attribute = ?"]),
    ].join(" AND ");
    const params: unknown[] = [entityId];
    if (current) params.push(this.#now());
    if (attribute !== undefined) params.push(attribute);
    return this.#db
      .prepare(`SELECT * FROM graph_facts WHERE ${where} ORDER BY recorded_at DESC, id DESC`)
      .all(...params) as FactRow[];
  }

  /** Current facts: owner first, then newest. */
  facts(entityId: string): GraphFact[] {
    return this.#factRows(entityId, true)
      .map(toFact)
      .sort(
        (a, b) =>
          trustRank(b.provenance) - trustRank(a.provenance) ||
          b.recordedAt.localeCompare(a.recordedAt),
      );
  }

  #rejected(kind: "wrong_fact" | "wrong_edge", entityId: string, keyHash: string): boolean {
    return (
      this.#db
        .prepare("SELECT 1 FROM graph_feedback WHERE kind = ? AND entity_id = ? AND key_hash = ?")
        .get(kind, entityId, keyHash) !== undefined
    );
  }

  /** The owner marked this value wrong for this entity (Contacts re-ingest respects it too). */
  isRejectedFact(entityId: string, attribute: GraphFactAttribute, value: string): boolean {
    return this.#rejected("wrong_fact", entityId, factKeyHash(attribute, value));
  }

  #feedback(
    kind: string,
    entityId: string | null,
    otherId: string | null,
    keyHash: string | null,
  ): void {
    this.#db
      .prepare(
        "INSERT INTO graph_feedback (id, kind, entity_id, other_id, key_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(this.#id("fb"), kind, entityId, otherId, keyHash, this.#now());
  }

  /**
   * Adds or supersedes a fact. Owner writes throw on a rule violation; non-owner writes that the
   * rules refuse return `undefined` (counted by the caller), so a model pass never fails whole.
   */
  setFact(input: FactInput): { fact: GraphFact; superseded: string | null } | undefined {
    const entity = this.#entityRow(input.entityId);
    if (entity === undefined) fail("not_found", "no such entity");
    const owner = input.provenance === "owner";
    const refuse = (code: PsycheError["code"], message: string): undefined => {
      if (owner) fail(code, message);
      return undefined;
    };
    if (!FACT_ATTRIBUTES.includes(input.attribute))
      return refuse("invalid_params", "unknown attribute");
    if (
      entity.kind === "assignment" &&
      ASSIGNMENT_STATE_ATTRIBUTES.has(input.attribute) &&
      !owner &&
      input.provenance !== "system"
    ) {
      return refuse("policy_denied", `${input.attribute} is set by the owner or a rule`);
    }
    let value = clip(input.value, 2000);
    if (value === null) return refuse("invalid_params", "a fact needs a value");
    if (entity.kind === "assignment" && input.attribute === "status" && !isWorkStatus(value)) {
      return refuse(
        "invalid_params",
        "a to-do is not started, in progress, handed in, done or dropped",
      );
    }
    // A deadline is a date; an assignment's is stored in one form so changes compare.
    const deadlineAt =
      input.attribute === "deadline" && isWorkKind(entity.kind) ? normalizeDueAt(value) : null;
    if (input.attribute === "deadline" && entity.kind === "assignment") {
      if (deadlineAt === null) return refuse("invalid_params", "a deadline needs a date");
      value = deadlineAt;
    }
    if (OWNER_ONLY_ATTRIBUTES.has(input.attribute) && !owner && input.provenance !== "system") {
      return refuse("policy_denied", `${input.attribute} is set by the owner only`);
    }
    if (blockingKinds(value, false).length > 0) {
      return refuse(
        "policy_denied",
        "facts cannot hold credentials, card or account numbers, government ids or health details",
      );
    }
    if (!owner && looksLikeInstruction(value))
      return refuse("policy_denied", "instruction-like text");
    const keyHash = factKeyHash(input.attribute, value);
    if (!owner && this.#rejected("wrong_fact", entity.id, keyHash)) return undefined;
    const now = this.#now();
    const sources = [...new Set([...(input.sources ?? []), ...sourceRef(input.source)])];
    const evidence = clip(input.evidence, EVIDENCE_CHARS);
    const current = MULTI_VALUED.has(input.attribute)
      ? this.#factRows(entity.id, true, input.attribute).filter(
          (r) => normalizeName(r.value) === normalizeName(value),
        )
      : this.#factRows(entity.id, true, input.attribute);
    const same = current.find((r) => normalizeName(r.value) === normalizeName(value));
    if (same !== undefined && trustRank(same.provenance) >= trustRank(input.provenance)) {
      // Refresh the evidence; an expiring inference gets a new year (§4.3 expiry).
      const merged = [...new Set([...(JSON.parse(same.sources) as string[]), ...sources])];
      this.#db
        .prepare(
          "UPDATE graph_facts SET sources = ?, evidence = COALESCE(?, evidence), valid_to = ?, updated_at = ? WHERE id = ?",
        )
        .run(JSON.stringify(merged), evidence, this.#expiry(input.provenance), now, same.id);
      return { fact: toFact(this.#factRow(same.id) as FactRow), superseded: null };
    }
    const prior = current[0];
    if (prior !== undefined && !MULTI_VALUED.has(input.attribute)) {
      // A model never overrides what the owner said. A status change made by the state machine
      // (work.ts) is code, not a model: it follows the owner's last word by design.
      const byStateMachine =
        input.attribute === "status" &&
        input.provenance === "system" &&
        input.subjectKind === "deterministic";
      if (
        !byStateMachine &&
        trustRank(prior.provenance) > trustRank(input.provenance) &&
        prior.provenance === "owner"
      ) {
        return undefined;
      }
    }
    const id = this.#id("fact");
    this.#db.transaction(() => {
      this.#db
        .prepare(
          `INSERT INTO graph_facts (id, entity_id, attribute, value, provenance, confidence, sources, evidence,
             valid_from, valid_to, recorded_at, created_at, updated_at, subject_kind)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          entity.id,
          input.attribute,
          value,
          input.provenance,
          Math.min(1, Math.max(0, input.confidence ?? (owner ? 1 : 0.6))),
          JSON.stringify(sources),
          evidence,
          now,
          this.#expiry(input.provenance),
          now,
          now,
          now,
          input.subjectKind ?? "owner_stated",
        );
      if (prior !== undefined && !MULTI_VALUED.has(input.attribute)) {
        this.#db
          .prepare(
            "UPDATE graph_facts SET superseded_by = ?, valid_to = ?, updated_at = ? WHERE id = ?",
          )
          .run(id, now, now, prior.id);
      }
      this.#cacheWorkFact(entity, input, value, deadlineAt, now);
    })();
    this.#touched(entity.id, ["facts"]);
    return {
      fact: toFact(this.#factRow(id) as FactRow),
      superseded: prior !== undefined && !MULTI_VALUED.has(input.attribute) ? prior.id : null,
    };
  }

  /**
   * The entity row caches the newest value of a few work facts (§2.3). Only the owner's and a
   * rule's facts move the cache (W1), and only for the kinds that carry it.
   */
  #cacheWorkFact(
    entity: EntityRow,
    input: FactInput,
    value: string,
    deadlineAt: string | null,
    now: string,
  ): void {
    if (!isWorkKind(entity.kind)) return;
    const trusted = input.provenance === "owner" || input.provenance === "system";
    if (trusted && input.attribute === "status" && entity.kind === "assignment") {
      this.#db
        .prepare("UPDATE graph_entities SET work_status = ? WHERE id = ?")
        .run(value, entity.id);
    }
    if (trusted && deadlineAt !== null) {
      this.#db
        .prepare("UPDATE graph_entities SET due_at = ? WHERE id = ?")
        .run(deadlineAt, entity.id);
    }
    if (input.provenance !== "untrusted" && SIGNAL_ATTRIBUTES.has(input.attribute)) {
      this.#db
        .prepare(
          "UPDATE graph_entities SET last_signal_at = MAX(COALESCE(last_signal_at, ''), ?) WHERE id = ?",
        )
        .run(now, entity.id);
    }
    if (
      PROGRESS_ATTRIBUTES.has(input.attribute) &&
      entity.kind === "assignment" &&
      (input.provenance === "owner" || input.provenance === "agent")
    ) {
      this.#startWork(entity.id);
    }
  }

  // --- work items (docs/design/memory-everything-2026.md §3) -------------------------------------

  /**
   * Applies a cause to an assignment's status through the state machine (work.ts) and writes the
   * `status` fact when it changes: the owner's word as `owner_stated`, a rule as `deterministic`.
   * Third-party text never changes it; the result says whether to ask the owner instead.
   */
  setWorkStatus(
    entityId: string,
    cause: WorkCause,
    source?: GraphWriteSource,
  ): ReturnType<typeof nextWorkStatus> & { entity: GraphEntity } {
    const row = this.#entityRow(entityId);
    if (row === undefined) fail("not_found", "no such entity");
    if (row.kind !== "assignment" || row.work_status === null) {
      fail("invalid_params", "only a to-do has a status");
    }
    const transition = nextWorkStatus(row.work_status, cause);
    if (transition.changed) {
      const owner = transition.via === "owner_stated";
      this.setFact({
        entityId,
        attribute: "status",
        value: transition.status,
        provenance: owner ? "owner" : "system",
        subjectKind: owner ? "owner_stated" : "deterministic",
        ...(source === undefined ? {} : { source }),
      });
    }
    return { ...transition, entity: this.getEntity(entityId) as GraphEntity };
  }

  /**
   * Records evidence that the owner (or a Psyche run) worked on an item: refreshes
   * `last_signal_at` and, when `startsWork`, moves a not-started assignment to in progress.
   */
  recordSignal(
    entityId: string,
    opts: { at?: string; provenance?: "owner" | "agent"; startsWork?: boolean } = {},
  ): GraphEntity {
    const row = this.#entityRow(entityId);
    if (row === undefined) fail("not_found", "no such entity");
    if (!isWorkKind(row.kind)) fail("invalid_params", "only a work item has signals");
    const at = opts.at ?? this.#now();
    this.#db
      .prepare(
        "UPDATE graph_entities SET last_signal_at = MAX(COALESCE(last_signal_at, ''), ?) WHERE id = ?",
      )
      .run(at, entityId);
    if (opts.startsWork !== false && row.kind === "assignment")
      this.#startWork(entityId, opts.provenance);
    this.#touched(entityId, ["signal"]);
    return this.getEntity(entityId) as GraphEntity;
  }

  #startWork(entityId: string, provenance: "owner" | "agent" = "owner"): void {
    const row = this.#entityRow(entityId);
    if (row?.work_status !== "not_started") return;
    this.setWorkStatus(entityId, { type: "signal", provenance });
  }

  /** Keeps a project's or assignment's deadline fact in step with an owner edit of `dueAt`. */
  #recordDeadline(id: string, dueAt: string | null): void {
    if (dueAt !== null) {
      this.setFact({
        entityId: id,
        attribute: "deadline",
        value: dueAt,
        provenance: "owner",
        source: { kind: "owner_edit" },
      });
      return;
    }
    // Cleared: the deadline stops being current, with no "wrong fact" correction recorded.
    const now = this.#now();
    this.#db
      .prepare(
        `UPDATE graph_facts SET valid_to = ?, updated_at = ?
         WHERE entity_id = ? AND attribute = 'deadline' AND superseded_by IS NULL
           AND retracted_at IS NULL AND valid_to IS NULL`,
      )
      .run(now, now, id);
  }

  /** The parent was marked done: its open assignments are done too (deterministic, §3.4). */
  #closeAssignmentsOf(projectId: string): void {
    const children = this.#db
      .prepare(
        `SELECT e.id FROM graph_edges g JOIN graph_entities e ON e.id = g.src
          WHERE g.dst = ? AND g.rel = 'part_of' AND g.superseded_by IS NULL AND g.retracted_at IS NULL
            AND e.kind = 'assignment'`,
      )
      .all(projectId) as { id: string }[];
    for (const c of children) this.setWorkStatus(c.id, { type: "parent_done" });
  }

  /** Inferences expire after 12 months without new evidence; owner and system facts never do. */
  #expiry(provenance: Provenance): string | null {
    if (provenance === "owner" || provenance === "system") return null;
    return new Date(this.#clock.now() + 365 * DAY_MS).toISOString();
  }

  #factRow(id: string): FactRow | undefined {
    return this.#db.prepare("SELECT * FROM graph_facts WHERE id = ?").get(id) as
      | FactRow
      | undefined;
  }

  getFact(id: string): GraphFact | undefined {
    const row = this.#factRow(id);
    return row === undefined ? undefined : toFact(row);
  }

  /** The owner marks a fact wrong: retracted, and never proposed again for that entity. */
  retractFact(id: string, source?: GraphWriteSource): GraphFact {
    const row = this.#factRow(id);
    if (row === undefined) fail("not_found", "no such fact");
    const now = this.#now();
    const sources = [...new Set([...(JSON.parse(row.sources) as string[]), ...sourceRef(source)])];
    this.#db.transaction(() => {
      this.#db
        .prepare(
          "UPDATE graph_facts SET retracted_at = ?, valid_to = COALESCE(valid_to, ?), sources = ?, updated_at = ? WHERE id = ?",
        )
        .run(now, now, JSON.stringify(sources), now, id);
      this.#feedback("wrong_fact", row.entity_id, null, factKeyHash(row.attribute, row.value));
    })();
    this.#touched(row.entity_id, ["facts"]);
    return toFact(this.#factRow(id) as FactRow);
  }

  /** Every version, newest first (`memory.entities.history`). */
  history(
    entityId: string,
    attribute?: GraphFactAttribute,
  ): { facts: GraphFact[]; edges: GraphEdge[] } {
    const facts = this.#factRows(entityId, false, attribute).map(toFact);
    const edges =
      attribute === undefined
        ? (
            this.#db
              .prepare(
                "SELECT * FROM graph_edges WHERE src = ? OR dst = ? ORDER BY created_at DESC, id DESC",
              )
              .all(entityId, entityId) as EdgeRow[]
          ).map(toEdge)
        : [];
    return { facts, edges };
  }

  // --- edges -----------------------------------------------------------------------------------

  #edgeRow(id: string): EdgeRow | undefined {
    return this.#db.prepare("SELECT * FROM graph_edges WHERE id = ?").get(id) as
      | EdgeRow
      | undefined;
  }

  edges(entityId: string): GraphEdge[] {
    return (
      this.#db
        .prepare(
          `SELECT * FROM graph_edges WHERE (src = ? OR dst = ?) AND superseded_by IS NULL AND retracted_at IS NULL
           AND (valid_to IS NULL OR valid_to > ?) AND review IN ${ACCEPTED_REVIEW_SQL} ORDER BY created_at DESC, id DESC`,
        )
        .all(entityId, entityId, this.#now()) as EdgeRow[]
    ).map(toEdge);
  }

  setEdge(input: EdgeInput): { edge: GraphEdge; superseded: string | null } | undefined {
    const owner = input.provenance === "owner";
    const refuse = (code: PsycheError["code"], message: string): undefined => {
      if (owner) fail(code, message);
      return undefined;
    };
    if (!EDGE_RELS.includes(input.rel)) return refuse("invalid_params", "unknown relation");
    const src = this.#entityRow(input.src);
    const dst = this.#entityRow(input.dst);
    if (src === undefined || dst === undefined) fail("not_found", "no such entity");
    if (src.id === dst.id) return refuse("invalid_params", "an entity cannot relate to itself");
    const [srcKinds, dstKinds] = REL_KINDS[input.rel] ?? [[], []];
    if (!srcKinds.includes(src.kind) || !dstKinds.includes(dst.kind)) {
      return refuse(
        "invalid_params",
        `${input.rel} does not connect a ${src.kind} to a ${dst.kind}`,
      );
    }
    if (
      (OWNER_ONLY_RELS.has(input.rel) || input.label !== undefined) &&
      !owner &&
      input.provenance !== "system"
    ) {
      return refuse("policy_denied", "personal relations are set by the owner only");
    }
    const keyHash = sha256(`${input.rel}\n${dst.id}`);
    if (!owner && this.#rejected("wrong_edge", src.id, keyHash)) return undefined;
    const now = this.#now();
    const sources = [...new Set([...(input.sources ?? []), ...sourceRef(input.source)])];
    const current = this.edges(src.id).filter((e) => e.src === src.id && e.rel === input.rel);
    const same = current.find(
      (e) => e.dst === dst.id && (e.label ?? null) === (input.label ?? null),
    );
    if (same !== undefined) {
      // The same relation again (the owner confirming a Contacts one): keep its new sources.
      const merged = [...new Set([...same.sources, ...sources])];
      if (merged.length === same.sources.length) return { edge: same, superseded: null };
      this.#db
        .prepare("UPDATE graph_edges SET sources = ?, updated_at = ? WHERE id = ?")
        .run(JSON.stringify(merged), now, same.id);
      return { edge: toEdge(this.#edgeRow(same.id) as EdgeRow), superseded: null };
    }
    // A person works at one org and reports to one person at a time; other relations accumulate.
    // An assignment or event belongs to one project or course at a time.
    const single =
      SINGLE_TARGET_RELS.has(input.rel) ||
      (input.rel === "part_of" && (src.kind === "assignment" || src.kind === "event"));
    const prior = single ? current[0] : current.find((e) => e.dst === dst.id);
    if (prior !== undefined && prior.provenance === "owner" && !owner) return undefined;
    const id = this.#id("edge");
    this.#db.transaction(() => {
      this.#db
        .prepare(
          `INSERT INTO graph_edges (id, src, dst, rel, label, provenance, confidence, sources, valid_from, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          src.id,
          dst.id,
          input.rel,
          input.label ?? null,
          input.provenance,
          Math.min(1, Math.max(0, input.confidence ?? (owner ? 1 : 0.6))),
          JSON.stringify(sources),
          now,
          now,
          now,
        );
      if (prior !== undefined) {
        this.#db
          .prepare(
            "UPDATE graph_edges SET superseded_by = ?, valid_to = ?, updated_at = ? WHERE id = ?",
          )
          .run(id, now, now, prior.id);
      }
    })();
    this.#touched(src.id, ["edges"]);
    this.#touched(dst.id, ["edges"]);
    return { edge: toEdge(this.#edgeRow(id) as EdgeRow), superseded: prior?.id ?? null };
  }

  retractEdge(id: string, source?: GraphWriteSource): GraphEdge {
    const row = this.#edgeRow(id);
    if (row === undefined) fail("not_found", "no such relation");
    const now = this.#now();
    const sources = [...new Set([...(JSON.parse(row.sources) as string[]), ...sourceRef(source)])];
    this.#db.transaction(() => {
      this.#db
        .prepare(
          "UPDATE graph_edges SET retracted_at = ?, valid_to = COALESCE(valid_to, ?), sources = ?, updated_at = ? WHERE id = ?",
        )
        .run(now, now, JSON.stringify(sources), now, id);
      this.#feedback("wrong_edge", row.src, row.dst, sha256(`${row.rel}\n${row.dst}`));
    })();
    this.#touched(row.src, ["edges"]);
    this.#touched(row.dst, ["edges"]);
    return toEdge(this.#edgeRow(id) as EdgeRow);
  }

  // --- interactions ----------------------------------------------------------------------------

  /** Idempotent by `(source, externalRef)`; participants are replaced. Never stores a body. */
  upsertInteraction(input: InteractionInput): string {
    const subject = clip(input.subject, SUBJECT_CHARS);
    const safeSubject =
      subject !== null && blockingKinds(subject, true).length > 0 ? null : subject;
    const existing = this.#db
      .prepare("SELECT id FROM graph_interactions WHERE source = ? AND external_ref = ?")
      .get(input.source, input.externalRef) as { id: string } | undefined;
    const id = existing?.id ?? this.#id("int");
    this.#db.transaction(() => {
      if (existing === undefined) {
        this.#db
          .prepare(
            `INSERT INTO graph_interactions (id, kind, source, external_ref, occurred_at, direction, subject, thread_key, link, project_id, created_at, gist)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            input.kind,
            input.source,
            input.externalRef,
            input.occurredAt,
            input.direction,
            safeSubject,
            clip(input.threadKey, 512),
            clip(input.link, 1024),
            input.projectId ?? null,
            this.#now(),
            clip(input.gist, 120),
          );
      } else {
        this.#db
          .prepare(
            "UPDATE graph_interactions SET occurred_at = ?, direction = ?, subject = ?, thread_key = ?, link = ?, project_id = COALESCE(?, project_id), gist = COALESCE(?, gist) WHERE id = ?",
          )
          .run(
            input.occurredAt,
            input.direction,
            safeSubject,
            clip(input.threadKey, 512),
            clip(input.link, 1024),
            input.projectId ?? null,
            clip(input.gist, 120),
            id,
          );
        this.#db.prepare("DELETE FROM graph_participants WHERE interaction_id = ?").run(id);
      }
      const insert = this.#db.prepare(
        "INSERT OR IGNORE INTO graph_participants (interaction_id, entity_id, role) VALUES (?, ?, ?)",
      );
      const bump = this.#db.prepare(
        "UPDATE graph_entities SET last_interaction_at = MAX(COALESCE(last_interaction_at, ''), ?) WHERE id = ?",
      );
      for (const p of input.participants) {
        const entityId = this.resolveMerged(p.entityId);
        insert.run(id, entityId, p.role);
        bump.run(input.occurredAt, entityId);
      }
      // A project is also a subject, so one reader finds everything an item owns (§2.6).
      if (input.projectId != null) this.linkSubject(id, input.projectId, "rule");
      for (const subject of input.subjects ?? []) {
        this.linkSubject(id, subject.entityId, subject.linkedBy ?? "rule", subject.confidence);
      }
    })();
    return id;
  }

  /** Ties an interaction to another item (the course as well as the assignment). Idempotent. */
  linkSubject(
    interactionId: string,
    entityId: string,
    linkedBy: GraphInteractionSubjectLinkedBy = "rule",
    confidence = 1,
  ): void {
    const target = this.#entityRow(this.resolveMerged(entityId));
    if (target === undefined) fail("not_found", "no such entity");
    this.#db
      .prepare(
        "INSERT OR IGNORE INTO graph_interaction_subjects (interaction_id, entity_id, linked_by, confidence, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(interactionId, target.id, linkedBy, Math.min(1, Math.max(0, confidence)), this.#now());
  }

  unlinkSubject(interactionId: string, entityId: string): boolean {
    return (
      this.#db
        .prepare(
          "DELETE FROM graph_interaction_subjects WHERE interaction_id = ? AND entity_id = ?",
        )
        .run(interactionId, entityId).changes > 0
    );
  }

  /** The items an interaction belongs to. */
  subjectsOf(interactionId: string): { entityId: string; linkedBy: string; confidence: number }[] {
    return (
      this.#db
        .prepare(
          "SELECT entity_id, linked_by, confidence FROM graph_interaction_subjects WHERE interaction_id = ? ORDER BY created_at, entity_id",
        )
        .all(interactionId) as { entity_id: string; linked_by: string; confidence: number }[]
    ).map((r) => ({ entityId: r.entity_id, linkedBy: r.linked_by, confidence: r.confidence }));
  }

  /** Writes or clears a conversation's one-line gist (≤ 120 characters). */
  setInteractionGist(interactionId: string, gist: string | null): void {
    this.#db
      .prepare("UPDATE graph_interactions SET gist = ? WHERE id = ?")
      .run(clip(gist, 120), interactionId);
  }

  /** The interaction recorded for a source item (a calendar event id, a mail message id). */
  interactionByRef(source: string, externalRef: string): GraphInteraction | undefined {
    const row = this.#db
      .prepare("SELECT id FROM graph_interactions WHERE source = ? AND external_ref = ?")
      .get(source, externalRef) as { id: string } | undefined;
    return row === undefined ? undefined : this.interaction(row.id);
  }

  /** The source app deleted an item: its interaction and anything derived only from it go too. */
  deleteInteraction(source: string, externalRef: string): boolean {
    const row = this.#db
      .prepare("SELECT id FROM graph_interactions WHERE source = ? AND external_ref = ?")
      .get(source, externalRef) as { id: string } | undefined;
    if (row === undefined) return false;
    this.#db.transaction(() => {
      this.#dropDerived([row.id]);
      this.#db.prepare("DELETE FROM graph_interactions WHERE id = ?").run(row.id);
    })();
    return true;
  }

  /** Facts whose every source is one of `ids` are deleted; loops from them are deleted. */
  #dropDerived(ids: string[]): void {
    if (ids.length === 0) return;
    const set = new Set(ids);
    const rows = this.#db.prepare("SELECT id, sources FROM graph_facts").all() as {
      id: string;
      sources: string;
    }[];
    const del = this.#db.prepare("DELETE FROM graph_facts WHERE id = ?");
    for (const r of rows) {
      const sources = JSON.parse(r.sources) as string[];
      if (sources.length > 0 && sources.every((s) => set.has(s))) del.run(r.id);
    }
    const marks = ids.map(() => "?").join(", ");
    this.#db
      .prepare(
        `DELETE FROM graph_loops WHERE source_interaction_id IN (${marks}) AND detected_by != 'owner'`,
      )
      .run(...ids);
  }

  interactions(
    entityId: string,
    opts: { limit?: number; before?: string } = {},
  ): GraphInteraction[] {
    const limit = Math.min(Math.max(1, opts.limit ?? 20), 200);
    const rows = this.#db
      .prepare(
        `SELECT i.* FROM graph_interactions i JOIN graph_participants p ON p.interaction_id = i.id
          WHERE p.entity_id = ? ${opts.before === undefined ? "" : "AND i.occurred_at < ?"}
          GROUP BY i.id ORDER BY i.occurred_at DESC, i.id DESC LIMIT ?`,
      )
      .all(...[entityId, ...(opts.before === undefined ? [] : [opts.before]), limit]) as {
      id: string;
      kind: GraphInteractionKind;
      source: string;
      occurred_at: string;
      direction: GraphInteraction["direction"];
      subject: string | null;
      thread_key: string | null;
      link: string | null;
      project_id: string | null;
      gist: string | null;
    }[];
    const participants = this.#db.prepare(
      "SELECT entity_id, role FROM graph_participants WHERE interaction_id = ?",
    );
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      source: r.source,
      occurredAt: r.occurred_at,
      direction: r.direction,
      subject: r.subject,
      threadKey: r.thread_key,
      link: r.link,
      projectId: r.project_id,
      ...(r.gist === null ? {} : { gist: r.gist }),
      participants: (
        participants.all(r.id) as { entity_id: string; role: GraphParticipantRole }[]
      ).map((p) => ({
        entityId: p.entity_id,
        role: p.role,
      })),
    }));
  }

  /**
   * Two-way contact strength (§6.2): interactions in both directions in the last 180 days,
   * weighted by recency. Used to rank ambiguous names and senders.
   */
  strength(entityId: string): number {
    const since = new Date(this.#clock.now() - 180 * DAY_MS).toISOString();
    const rows = this.#db
      .prepare(
        `SELECT i.occurred_at AS at, i.direction AS dir FROM graph_interactions i
           JOIN graph_participants p ON p.interaction_id = i.id
          WHERE p.entity_id = ? AND i.occurred_at >= ? GROUP BY i.id`,
      )
      .all(entityId, since) as { at: string; dir: string }[];
    let score = 0;
    let outbound = 0;
    let inbound = 0;
    for (const r of rows) {
      const age = (this.#clock.now() - Date.parse(r.at)) / DAY_MS;
      score += 0.5 ** (age / 30);
      if (r.dir === "out" || r.dir === "both") outbound++;
      if (r.dir === "in" || r.dir === "both") inbound++;
    }
    return outbound > 0 && inbound > 0 ? score : score * 0.25;
  }

  /** The owner has both written to and heard from this person (§10.1 `two_way`). */
  isTwoWay(entityId: string): boolean {
    const r = this.#db
      .prepare(
        `SELECT
           max(i.direction IN ('out', 'both')) AS sent,
           max(i.direction IN ('in', 'both')) AS got
         FROM graph_interactions i JOIN graph_participants p ON p.interaction_id = i.id
         WHERE p.entity_id = ?`,
      )
      .get(entityId) as { sent: number | null; got: number | null };
    return r.sent === 1 && r.got === 1;
  }

  /** The person is in Contacts, or the owner linked or verified one of their identifiers. */
  isContact(entityId: string): boolean {
    return (
      this.#db
        .prepare(
          `SELECT 1 FROM graph_identifiers WHERE entity_id = ?
             AND (source = 'contacts' OR verified = 1 OR linked_by = 'owner') LIMIT 1`,
        )
        .get(entityId) !== undefined
    );
  }

  // --- loops -----------------------------------------------------------------------------------

  #loopRow(id: string): LoopRow | undefined {
    return this.#db.prepare("SELECT * FROM graph_loops WHERE id = ?").get(id) as
      | LoopRow
      | undefined;
  }

  /** Creates a loop unless the same one is already open or was dismissed (returns undefined). */
  addLoop(input: LoopInput): GraphLoop | undefined {
    const text = clip(input.text, 200);
    if (text === null) return undefined;
    if (
      blockingKinds(text, false).length > 0 ||
      (input.provenance !== "owner" && looksLikeInstruction(text))
    ) {
      return undefined;
    }
    // Third-party text never opens a loop on its own authority (§5.3).
    const status: GraphLoopStatus =
      input.provenance === "untrusted" && input.status === "open" ? "suggested" : input.status;
    const counterpart =
      input.counterpartId === undefined || input.counterpartId === null
        ? null
        : this.resolveMerged(input.counterpartId);
    const dedupe = sha256(`${input.direction}\n${counterpart ?? ""}\n${normalizeName(text)}`);
    const prior = this.#db
      .prepare("SELECT * FROM graph_loops WHERE dedupe_key = ? ORDER BY created_at DESC LIMIT 1")
      .get(dedupe) as LoopRow | undefined;
    if (prior !== undefined && (prior.status !== "done" || input.provenance !== "owner"))
      return undefined;
    const id = this.#id("loop");
    const now = this.#now();
    this.#db
      .prepare(
        `INSERT INTO graph_loops (id, direction, text, evidence, counterpart_id, project_id, due_at, status,
           source_interaction_id, provenance, confidence, detected_by, dedupe_key, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.direction,
        text,
        clip(input.evidence, EVIDENCE_CHARS),
        counterpart,
        input.projectId ?? null,
        input.dueAt ?? null,
        status,
        input.sourceInteractionId ?? null,
        input.provenance,
        Math.min(1, Math.max(0, input.confidence ?? 0.6)),
        input.detectedBy,
        dedupe,
        now,
        now,
      );
    const loop = toLoop(this.#loopRow(id) as LoopRow);
    this.#emit({ event: "memory.loop.updated", payload: { loop } });
    if (counterpart !== null) this.#touched(counterpart, ["loops"]);
    return loop;
  }

  getLoop(id: string): GraphLoop | undefined {
    const row = this.#loopRow(id);
    return row === undefined ? undefined : toLoop(row);
  }

  updateLoop(
    id: string,
    patch: {
      status?: GraphLoopStatus;
      dueAt?: string | null;
      text?: string;
      closedBy?: GraphLoop["closedBy"];
    },
  ): GraphLoop {
    const row = this.#loopRow(id);
    if (row === undefined) fail("not_found", "no such loop");
    const now = this.#now();
    const status = patch.status ?? row.status;
    const closing = (status === "done" || status === "dismissed") && row.status !== status;
    const text = patch.text === undefined ? row.text : (clip(patch.text, 200) ?? row.text);
    this.#db
      .prepare(
        "UPDATE graph_loops SET status = ?, due_at = ?, text = ?, closed_at = ?, closed_by = ?, updated_at = ? WHERE id = ?",
      )
      .run(
        status,
        patch.dueAt === undefined ? row.due_at : patch.dueAt,
        text,
        closing ? now : status === "done" || status === "dismissed" ? row.closed_at : null,
        closing
          ? (patch.closedBy ?? "owner")
          : status === "done" || status === "dismissed"
            ? row.closed_by
            : null,
        now,
        id,
      );
    if (closing && status === "dismissed")
      this.#feedback("dismissed_loop", row.counterpart_id, null, row.dedupe_key);
    const loop = toLoop(this.#loopRow(id) as LoopRow);
    this.#emit({ event: "memory.loop.updated", payload: { loop } });
    if (row.counterpart_id !== null) this.#touched(row.counterpart_id, ["loops"]);
    return loop;
  }

  loops(
    filter: {
      status?: GraphLoopStatus[];
      direction?: GraphLoop["direction"];
      entityId?: string;
      projectId?: string;
      dueBefore?: string;
      limit?: number;
      after?: string;
    } = {},
  ): GraphLoop[] {
    const status = filter.status ?? ["suggested", "open"];
    const clauses = [`status IN (${status.map(() => "?").join(", ")})`];
    const params: unknown[] = [...status];
    if (filter.direction !== undefined) {
      clauses.push("direction = ?");
      params.push(filter.direction);
    }
    if (filter.entityId !== undefined) {
      clauses.push("counterpart_id = ?");
      params.push(filter.entityId);
    }
    if (filter.projectId !== undefined) {
      clauses.push("project_id = ?");
      params.push(filter.projectId);
    }
    if (filter.dueBefore !== undefined) {
      clauses.push("due_at IS NOT NULL AND due_at < ?");
      params.push(filter.dueBefore);
    }
    if (filter.after !== undefined) {
      clauses.push("(created_at, id) > (SELECT created_at, id FROM graph_loops WHERE id = ?)");
      params.push(filter.after);
    }
    const limit = Math.min(Math.max(1, filter.limit ?? 100), 500);
    return (
      this.#db
        .prepare(
          `SELECT * FROM graph_loops WHERE ${clauses.join(" AND ")} ORDER BY created_at, id LIMIT ?`,
        )
        .all(...params, limit) as LoopRow[]
    ).map(toLoop);
  }

  // --- anchors (docs/design/memory-everything-2026.md §2.5) ------------------------------------

  /**
   * Links a source (a folder, a Reminders list, a mail thread, ...) to a work item: "signals from
   * here belong to this item". Only owner and rule anchors route signals; a model anchor starts
   * unconfirmed and routes nothing until the owner confirms it (W6). Adding the same anchor again
   * returns the existing one, and the owner adding it confirms a model's.
   */
  addAnchor(input: {
    entityId: string;
    kind: GraphAnchorKind;
    ref: string;
    label?: string | null;
    addedBy: GraphAnchor["addedBy"];
  }): GraphAnchor {
    const entity = this.#entityRow(this.resolveMerged(input.entityId));
    if (entity === undefined) fail("not_found", "no such entity");
    if (!isWorkKind(entity.kind)) {
      fail("invalid_params", "a source can be linked to a project, course, to-do or event");
    }
    const ref = input.ref.trim();
    if (ref.length === 0 || ref.length > 1024 || [...ref].some(isControlChar)) {
      fail("invalid_params", "that link is not valid");
    }
    const label = safeName(input.label ?? "", 200);
    const existing = this.#db
      .prepare(
        "SELECT id, confirmed FROM graph_anchors WHERE entity_id = ? AND kind = ? AND ref = ?",
      )
      .get(entity.id, input.kind, ref) as { id: string; confirmed: number } | undefined;
    if (existing !== undefined) {
      if (existing.confirmed === 0 && input.addedBy !== "model") {
        this.#db
          .prepare(
            "UPDATE graph_anchors SET confirmed = 1, added_by = ?, label = CASE WHEN ? != '' THEN ? ELSE label END WHERE id = ?",
          )
          .run(input.addedBy, label, label, existing.id);
      }
      return this.getAnchor(existing.id) as GraphAnchor;
    }
    const id = this.#id("anc");
    this.#db
      .prepare(
        "INSERT INTO graph_anchors (id, entity_id, kind, ref, label, added_by, confirmed, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        id,
        entity.id,
        input.kind,
        ref,
        label,
        input.addedBy,
        input.addedBy === "model" ? 0 : 1,
        this.#now(),
      );
    this.#emit({
      event: "memory.entity.updated",
      payload: { id: entity.id, kind: entity.kind, changed: ["anchors"] },
    });
    return this.getAnchor(id) as GraphAnchor;
  }

  getAnchor(id: string): GraphAnchor | undefined {
    const r = this.#db.prepare("SELECT * FROM graph_anchors WHERE id = ?").get(id) as
      | AnchorRow
      | undefined;
    return r === undefined ? undefined : toAnchor(r);
  }

  anchors(filter: { entityId?: string; kind?: GraphAnchorKind } = {}): GraphAnchor[] {
    const where: string[] = [];
    const params: string[] = [];
    if (filter.entityId !== undefined) {
      where.push("entity_id = ?");
      params.push(this.resolveMerged(filter.entityId));
    }
    if (filter.kind !== undefined) {
      where.push("kind = ?");
      params.push(filter.kind);
    }
    return (
      this.#db
        .prepare(
          `SELECT * FROM graph_anchors ${where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`} ORDER BY created_at, id`,
        )
        .all(...params) as AnchorRow[]
    ).map(toAnchor);
  }

  /** The owner confirms a model's suggested anchor: from now on it routes signals. */
  confirmAnchor(id: string): GraphAnchor {
    const r = this.getAnchor(id);
    if (r === undefined) fail("not_found", "no such link");
    this.#db.prepare("UPDATE graph_anchors SET confirmed = 1 WHERE id = ?").run(id);
    return this.getAnchor(id) as GraphAnchor;
  }

  removeAnchor(id: string): boolean {
    const row = this.getAnchor(id);
    if (row === undefined) return false;
    this.#db.prepare("DELETE FROM graph_anchors WHERE id = ?").run(id);
    const kind = this.#entityRow(row.entityId)?.kind;
    if (kind !== undefined) {
      this.#emit({
        event: "memory.entity.updated",
        payload: { id: row.entityId, kind, changed: ["anchors"] },
      });
    }
    return true;
  }

  /** The items a source belongs to: confirmed anchors only (a model anchor routes nothing). */
  routeAnchor(kind: GraphAnchorKind, ref: string): GraphAnchor[] {
    return (
      this.#db
        .prepare(
          "SELECT * FROM graph_anchors WHERE kind = ? AND ref = ? AND confirmed = 1 ORDER BY created_at, id",
        )
        .all(kind, ref) as AnchorRow[]
    ).map(toAnchor);
  }

  // --- timeline (§3.5) ---------------------------------------------------------------------------

  /**
   * An item's timeline, newest first: a view over rows the graph already keeps (interactions tied
   * to it, the history of its work facts, its loops), plus the same for a project's or course's
   * assignments. Nothing is stored for it. Text is built from templates; titles are cleaned data.
   */
  timeline(
    entityId: string,
    opts: { before?: string; limit?: number } = {},
  ): { rows: GraphTimelineRow[]; nextBefore: string | null } {
    const id = this.resolveMerged(entityId);
    const root = this.#entityRow(id);
    if (root === undefined) fail("not_found", "no such entity");
    const limit = Math.min(Math.max(1, opts.limit ?? 50), 200);
    const owners = [id];
    if (root.kind === "project") {
      owners.push(
        ...(
          this.#db
            .prepare(
              `SELECT g.src AS id FROM graph_edges g JOIN graph_entities e ON e.id = g.src
                WHERE g.dst = ? AND g.rel = 'part_of' AND g.superseded_by IS NULL AND g.retracted_at IS NULL
                  AND e.kind IN ('assignment', 'event')`,
            )
            .all(id) as { id: string }[]
        ).map((r) => r.id),
      );
    }
    const rows = new Map<string, GraphTimelineRow>();
    const before = opts.before;
    const keep = (at: string) => before === undefined || at < before;
    const marks = owners.map(() => "?").join(", ");

    // 1. interactions tied to the item through subjects or the project column
    const interactionRows = this.#db
      .prepare(
        `SELECT i.*, COALESCE(s.entity_id, i.project_id) AS owner_id
           FROM graph_interactions i
           LEFT JOIN graph_interaction_subjects s ON s.interaction_id = i.id AND s.entity_id IN (${marks})
          WHERE s.entity_id IS NOT NULL OR i.project_id IN (${marks})
          ORDER BY i.occurred_at DESC, i.id DESC LIMIT 400`,
      )
      .all(...owners, ...owners) as (InteractionRow & { owner_id: string })[];
    const senderOf = this.#db.prepare(
      `SELECT e.name FROM graph_participants p JOIN graph_entities e ON e.id = p.entity_id
        WHERE p.interaction_id = ? AND p.role = 'from' LIMIT 1`,
    );
    for (const r of interactionRows) {
      if (!keep(r.occurred_at) || rows.has(r.id)) continue;
      const sender = (senderOf.get(r.id) as { name: string } | undefined)?.name;
      rows.set(r.id, interactionTimelineRow(r, r.owner_id, sender));
    }

    // 2. the history of the work facts, newest value last
    const factStmt = this.#db.prepare(
      `SELECT * FROM graph_facts WHERE entity_id = ? AND attribute IN (${WORK_FACTS_SQL})
         AND retracted_at IS NULL AND review IN ${ACCEPTED_REVIEW_SQL} ORDER BY recorded_at, id`,
    );
    const citeStmt = this.#db.prepare(
      "SELECT id, source, source_ref, author_entity_id FROM graph_citations WHERE target_kind = 'fact' AND target_id = ? ORDER BY created_at, id LIMIT 1",
    );
    const nameStmt = this.#db.prepare("SELECT name FROM graph_entities WHERE id = ?");
    for (const owner of owners) {
      const facts = factStmt.all(owner) as FactRow[];
      for (const f of facts) {
        if (!keep(f.recorded_at)) continue;
        const prior = facts.find((x) => x.superseded_by === f.id);
        const cite = citeStmt.get(f.id) as
          | {
              id: string;
              source: GraphCitationSource;
              source_ref: string;
              author_entity_id: string | null;
            }
          | undefined;
        const author =
          cite?.author_entity_id == null
            ? undefined
            : (nameStmt.get(cite.author_entity_id) as { name: string } | undefined)?.name;
        rows.set(f.id, factTimelineRow(f, owner, prior, cite, author));
      }
    }

    // 3. loops on the item: someone owed, or owing
    const loopRows = this.#db
      .prepare(
        `SELECT l.*, e.name AS counterpart_name FROM graph_loops l
           LEFT JOIN graph_entities e ON e.id = l.counterpart_id
          WHERE l.project_id IN (${marks}) AND l.status IN ('open', 'snoozed', 'done')
          ORDER BY l.created_at DESC, l.id DESC LIMIT 100`,
      )
      .all(...owners) as (LoopRow & { counterpart_name: string | null })[];
    for (const l of loopRows) {
      if (!keep(l.created_at)) continue;
      rows.set(l.id, loopTimelineRow(l));
    }

    const sorted = [...rows.values()].sort(
      (a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id),
    );
    const page = sorted.slice(0, limit);
    return { rows: page, nextBefore: sorted.length > limit ? (page.at(-1)?.at ?? null) : null };
  }

  // --- suggestions -----------------------------------------------------------------------------

  /** Records a suggestion unless the same one was ever made before (accepted or rejected). */
  suggest(input: {
    kind: GraphSuggestion["kind"];
    entityIds: string[];
    name?: string | null;
    reason: string;
    /** project: a course is a project suggestion with a type. */
    projectType?: GraphProjectType;
    /** assignment: the due date it was read from. */
    dueAt?: string | null;
  }): GraphSuggestion | undefined {
    const ids = [...new Set(input.entityIds.map((id) => this.resolveMerged(id)))].sort();
    if (input.kind === "merge") {
      if (ids.length < 2) return undefined;
      const [a, b] = ids as [string, string];
      const blocked = this.#db
        .prepare(
          "SELECT 1 FROM graph_feedback WHERE kind = 'do_not_merge' AND ((entity_id = ? AND other_id = ?) OR (entity_id = ? AND other_id = ?))",
        )
        .get(a, b, b, a);
      if (blocked !== undefined) return undefined;
    }
    const name = clip(input.name, 200);
    const dueAt = input.kind === "assignment" ? normalizeDueAt(input.dueAt) : null;
    if (input.kind === "assignment" && name === null) return undefined;
    const keyHash =
      input.kind === "merge"
        ? sha256(`merge\n${ids.join("\n")}`)
        : input.kind === "assignment"
          ? sha256(`assignment\n${ids[0] ?? ""}\n${normalizeName(name ?? "")}\n${dueAt ?? ""}`)
          : sha256(`project\n${normalizeName(name ?? "")}`);
    if (
      input.kind === "project" &&
      this.#db
        .prepare("SELECT 1 FROM graph_feedback WHERE kind = 'not_project' AND key_hash = ?")
        .get(keyHash) !== undefined
    ) {
      return undefined;
    }
    if (
      this.#db.prepare("SELECT 1 FROM graph_suggestions WHERE key_hash = ?").get(keyHash) !==
      undefined
    )
      return undefined;
    const id = this.#id("sug");
    const now = this.#now();
    this.#db
      .prepare(
        "INSERT INTO graph_suggestions (id, kind, entity_ids, name, reason, status, key_hash, created_at, updated_at, project_type, due_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)",
      )
      .run(
        id,
        input.kind,
        JSON.stringify(ids),
        name,
        // The reason may carry a quote of text from elsewhere: shown cleaned, never raw.
        clip(cleanItemText(input.reason, { format: "text", keepQuoted: true }).text, 300) ?? "",
        keyHash,
        now,
        now,
        input.kind === "project" ? (input.projectType ?? null) : null,
        dueAt,
      );
    const suggestion = this.getSuggestion(id) as GraphSuggestion;
    this.#emit({ event: "memory.suggestion.created", payload: { suggestion } });
    return suggestion;
  }

  getSuggestion(id: string): GraphSuggestion | undefined {
    const r = this.#db.prepare("SELECT * FROM graph_suggestions WHERE id = ?").get(id) as
      | {
          id: string;
          kind: GraphSuggestion["kind"];
          entity_ids: string;
          name: string | null;
          reason: string;
          status: GraphSuggestion["status"];
          created_at: string;
          project_type: GraphProjectType | null;
          due_at: string | null;
        }
      | undefined;
    if (r === undefined) return undefined;
    return {
      id: r.id,
      kind: r.kind,
      entityIds: JSON.parse(r.entity_ids) as string[],
      name: r.name,
      ...(r.project_type === null ? {} : { projectType: r.project_type }),
      ...(r.due_at === null ? {} : { dueAt: r.due_at }),
      reason: r.reason,
      status: r.status,
      createdAt: r.created_at,
    };
  }

  suggestions(status: ("pending" | "later")[] = ["pending"]): GraphSuggestion[] {
    const rows = this.#db
      .prepare(
        `SELECT id FROM graph_suggestions WHERE status IN (${status.map(() => "?").join(", ")}) ORDER BY created_at, id`,
      )
      .all(...status) as { id: string }[];
    return rows.map((r) => this.getSuggestion(r.id) as GraphSuggestion);
  }

  answerSuggestion(
    id: string,
    answer: "accept" | "reject" | "later",
  ): { suggestion: GraphSuggestion; entity: GraphEntity | null } {
    const s = this.getSuggestion(id);
    if (s === undefined) fail("not_found", "no such suggestion");
    let entity: GraphEntity | null = null;
    if (answer === "accept") {
      if (s.kind === "merge") {
        const [into, ...rest] = s.entityIds;
        if (into !== undefined && rest.length > 0)
          entity = this.merge([into, ...rest], into).entity;
      } else if (s.kind === "assignment") {
        // Track: only the owner's answer creates the assignment (W1, W2). The parent is the
        // first listed entity when it is still a project or course.
        const parentRow =
          s.entityIds[0] === undefined
            ? undefined
            : this.#entityRow(this.resolveMerged(s.entityIds[0]));
        entity = this.createEntity({
          kind: "assignment",
          name: s.name ?? "Untitled assignment",
          ...(s.dueAt == null ? {} : { dueAt: s.dueAt }),
          // A to-do under a private project is private with it.
          ...(parentRow?.private === 1 ? { private: true } : {}),
        });
        const parent = s.entityIds[0];
        if (
          parent !== undefined &&
          this.#entityRow(this.resolveMerged(parent))?.kind === "project"
        ) {
          this.setEdge({
            src: entity.id,
            rel: "part_of",
            dst: this.resolveMerged(parent),
            provenance: "owner",
          });
        }
      } else {
        entity = this.createEntity({
          kind: "project",
          name: s.name ?? "Untitled project",
          ...(s.projectType === undefined ? {} : { projectType: s.projectType }),
        });
        for (const member of s.entityIds) {
          const m = this.#entityRow(member);
          if (m?.kind === "person")
            this.setEdge({ src: member, rel: "member_of", dst: entity.id, provenance: "owner" });
          else if (m?.kind === "org")
            this.setEdge({
              src: member,
              rel: "stakeholder_of",
              dst: entity.id,
              provenance: "owner",
            });
        }
      }
    } else if (answer === "reject") {
      const [a, b] = s.entityIds;
      if (s.kind === "merge" && a !== undefined && b !== undefined)
        this.#feedback("do_not_merge", a, b, null);
      if (s.kind === "project")
        this.#feedback(
          "not_project",
          null,
          null,
          sha256(`project\n${normalizeName(s.name ?? "")}`),
        );
    }
    const status = answer === "accept" ? "accepted" : answer === "reject" ? "rejected" : "later";
    this.#db
      .prepare("UPDATE graph_suggestions SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, this.#now(), id);
    return { suggestion: this.getSuggestion(id) as GraphSuggestion, entity };
  }

  // --- merge, split, forget --------------------------------------------------------------------

  merge(
    ids: string[],
    into: string,
    dryRun = false,
  ): { entity: GraphEntity; movedIdentifiers: number; movedFacts: number; dryRun: boolean } {
    const target = this.#entityRow(into);
    if (target === undefined) fail("not_found", "no such entity");
    const others = [...new Set(ids.map((id) => this.resolveMerged(id)))].filter(
      (id) => id !== into,
    );
    let movedIdentifiers = 0;
    let movedFacts = 0;
    for (const id of others) {
      const row = this.#entityRow(id);
      if (row === undefined) fail("not_found", "no such entity");
      if (row.kind !== target.kind) fail("invalid_params", "only entities of one kind merge");
      if (row.is_owner === 1 && target.is_owner !== 1)
        fail("invalid_params", "merge others into the owner, not the owner away");
      movedIdentifiers += (
        this.#db
          .prepare("SELECT count(*) AS n FROM graph_identifiers WHERE entity_id = ?")
          .get(id) as { n: number }
      ).n;
      movedFacts += this.#factRows(id, true).length;
    }
    if (!dryRun) {
      const now = this.#now();
      this.#db.transaction(() => {
        for (const id of others) {
          const row = this.#entityRow(id) as EntityRow;
          this.addAlias(into, row.name, "merge");
          this.#db
            .prepare("UPDATE graph_identifiers SET entity_id = ? WHERE entity_id = ?")
            .run(into, id);
          this.#db
            .prepare(
              "INSERT OR IGNORE INTO graph_aliases (entity_id, alias_norm, alias, source, created_at) SELECT ?, alias_norm, alias, source, created_at FROM graph_aliases WHERE entity_id = ?",
            )
            .run(into, id);
          this.#db
            .prepare("UPDATE graph_facts SET entity_id = ? WHERE entity_id = ?")
            .run(into, id);
          this.#db.prepare("UPDATE graph_edges SET src = ? WHERE src = ?").run(into, id);
          this.#db.prepare("UPDATE graph_edges SET dst = ? WHERE dst = ?").run(into, id);
          this.#db
            .prepare("UPDATE OR IGNORE graph_participants SET entity_id = ? WHERE entity_id = ?")
            .run(into, id);
          this.#db.prepare("DELETE FROM graph_participants WHERE entity_id = ?").run(id);
          this.#db
            .prepare("UPDATE graph_loops SET counterpart_id = ? WHERE counterpart_id = ?")
            .run(into, id);
          this.#db
            .prepare("UPDATE graph_loops SET project_id = ? WHERE project_id = ?")
            .run(into, id);
          this.#db
            .prepare("UPDATE graph_interactions SET project_id = ? WHERE project_id = ?")
            .run(into, id);
          this.#db
            .prepare(
              "UPDATE graph_entities SET status = 'merged', merged_into = ?, card_path = NULL, updated_at = ? WHERE id = ?",
            )
            .run(into, now, id);
          this.#db
            .prepare(
              "UPDATE graph_entities SET last_interaction_at = MAX(COALESCE(last_interaction_at, ''), COALESCE(?, '')) WHERE id = ?",
            )
            .run(row.last_interaction_at, into);
          this.#feedback("merge", into, id, null);
          this.#db.prepare("DELETE FROM graph_fts WHERE entity_id = ?").run(id);
        }
      })();
      this.#touched(into, ["merged"]);
    }
    return { entity: this.getEntity(into) as GraphEntity, movedIdentifiers, movedFacts, dryRun };
  }

  /** Moves identifiers (and the interactions they explain) to a new entity; never re-suggested. */
  split(
    id: string,
    identifiers: { kind: GraphIdentifierKind; value: string }[],
    name: string,
    dryRun = false,
  ): { entity: GraphEntity; dryRun: boolean } {
    const row = this.#entityRow(id);
    if (row === undefined) fail("not_found", "no such entity");
    const mine = identifiers.filter((i) => this.resolveIdentifier(i.kind, i.value) === id);
    if (mine.length === 0)
      fail("invalid_params", "none of those identifiers belong to this entity");
    if (dryRun) {
      return {
        entity: {
          ...toEntity(row, []),
          id: "ent_preview",
          name,
          aliases: [],
          isOwner: false,
          pinned: false,
          hidden: false,
        },
        dryRun,
      };
    }
    let created: GraphEntity | undefined;
    this.#db.transaction(() => {
      created = this.createEntity({ kind: row.kind, name, source: "owner" });
      for (const i of mine) {
        this.unlinkIdentifier(i.kind, i.value);
        this.linkIdentifier(created.id, i.kind, i.value, {
          source: "owner",
          linkedBy: "owner",
          verified: true,
        });
      }
      this.#feedback("do_not_merge", id, created.id, null);
    })();
    const out = created as GraphEntity;
    this.#touched(id, ["identifiers"]);
    return { entity: this.getEntity(out.id) as GraphEntity, dryRun };
  }

  /**
   * Deletes an entity and everything about it; its identifiers are blocklisted (hashes) so
   * ingest never recreates it. Runs with `secure_delete` so freed pages are zeroed (§4.9).
   */
  forget(
    id: string,
    dryRun = false,
  ): {
    removed: {
      identifiers: number;
      facts: number;
      edges: number;
      interactions: number;
      loops: number;
    };
    cardPath: string | null;
    names: string[];
    dryRun: boolean;
  } {
    const row = this.#entityRow(id);
    if (row === undefined) fail("not_found", "no such entity");
    if (row.is_owner === 1)
      fail("policy_denied", "the owner's own entity is cleared from Settings, not forgotten");
    const merged = (
      this.#db.prepare("SELECT id FROM graph_entities WHERE merged_into = ?").all(id) as {
        id: string;
      }[]
    ).map((r) => r.id);
    const ids = [id, ...merged];
    const marks = ids.map(() => "?").join(", ");
    const count = (sql: string) => (this.#db.prepare(sql).get(...ids) as { n: number }).n;
    const soleInteractions = (
      this.#db
        .prepare(
          `SELECT p.interaction_id AS id FROM graph_participants p WHERE p.entity_id IN (${marks})
           AND NOT EXISTS (SELECT 1 FROM graph_participants q WHERE q.interaction_id = p.interaction_id AND q.entity_id NOT IN (${marks}))
           GROUP BY p.interaction_id`,
        )
        .all(...ids, ...ids) as { id: string }[]
    ).map((r) => r.id);
    const removed = {
      identifiers: count(
        `SELECT count(*) AS n FROM graph_identifiers WHERE entity_id IN (${marks})`,
      ),
      facts: count(`SELECT count(*) AS n FROM graph_facts WHERE entity_id IN (${marks})`),
      edges: (
        this.#db
          .prepare(
            `SELECT count(*) AS n FROM graph_edges WHERE src IN (${marks}) OR dst IN (${marks})`,
          )
          .get(...ids, ...ids) as { n: number }
      ).n,
      interactions: soleInteractions.length,
      loops: (
        this.#db
          .prepare(
            `SELECT count(*) AS n FROM graph_loops WHERE counterpart_id IN (${marks}) OR project_id IN (${marks})`,
          )
          .get(...ids, ...ids) as { n: number }
      ).n,
    };
    const names = [row.name, ...this.#aliases(id)];
    if (dryRun) return { removed, cardPath: row.card_path, names, dryRun };
    const before = this.#db.pragma("secure_delete", { simple: true });
    this.#db.pragma("secure_delete = ON");
    try {
      this.#db.transaction(() => {
        for (const ident of ids.flatMap((e) => this.identifiers(e)))
          this.#block(ident.kind, ident.value);
        this.#db
          .prepare(
            `DELETE FROM graph_loops WHERE counterpart_id IN (${marks}) OR project_id IN (${marks})`,
          )
          .run(...ids, ...ids);
        if (soleInteractions.length > 0) {
          this.#db
            .prepare(
              `DELETE FROM graph_interactions WHERE id IN (${soleInteractions.map(() => "?").join(", ")})`,
            )
            .run(...soleInteractions);
        }
        this.#db
          .prepare(
            `DELETE FROM graph_suggestions WHERE ${ids.map(() => "entity_ids LIKE ?").join(" OR ")}`,
          )
          .run(...ids.map((e) => `%"${e}"%`));
        this.#db
          .prepare(
            `DELETE FROM graph_feedback WHERE entity_id IN (${marks}) OR other_id IN (${marks})`,
          )
          .run(...ids, ...ids);
        this.#db.prepare(`DELETE FROM graph_fts WHERE entity_id IN (${marks})`).run(...ids);
        // Cascades remove identifiers, aliases, facts, edges and participants.
        this.#db.prepare(`DELETE FROM graph_entities WHERE id IN (${marks})`).run(...ids);
      })();
      this.#db.exec("INSERT INTO graph_fts (graph_fts) VALUES ('optimize')");
      if (this.#db.name !== ":memory:") this.#db.pragma("wal_checkpoint(TRUNCATE)");
    } finally {
      this.#db.pragma(`secure_delete = ${before === 1 ? "ON" : "OFF"}`);
    }
    this.#emit({
      event: "memory.entity.updated",
      payload: { id, kind: row.kind, changed: ["forgotten"] },
    });
    return { removed, cardPath: row.card_path, names, dryRun };
  }

  /** Runs `fn` with SQLite secure_delete on, then rebuilds the FTS index and checkpoints (§4.9). */
  #secureDelete(fn: () => void): void {
    const before = this.#db.pragma("secure_delete", { simple: true });
    this.#db.pragma("secure_delete = ON");
    try {
      this.#db.transaction(fn)();
      this.#db.exec("INSERT INTO graph_fts (graph_fts) VALUES ('optimize')");
      if (this.#db.name !== ":memory:") this.#db.pragma("wal_checkpoint(TRUNCATE)");
    } finally {
      this.#db.pragma(`secure_delete = ${before === 1 ? "ON" : "OFF"}`);
    }
  }

  #count(sql: string): number {
    return (this.#db.prepare(sql).get() as { n: number }).n;
  }

  /**
   * Removes what one source brought (`memory.graph.deleteSource`): its interactions, the facts,
   * relations and loops derived only from them, its identifiers and aliases (never ones the owner
   * linked), and people or organisations left with nothing (no identifiers, interactions, loops,
   * facts or relations; never the owner, a pinned entity or a project).
   */
  deleteSource(
    source: GraphSource,
    dryRun = false,
  ): { removed: GraphRemovedCounts; cardPaths: string[]; dryRun: boolean } {
    const kinds = SOURCE_KINDS[source];
    const interactions =
      kinds.length === 0
        ? []
        : (
            this.#db
              .prepare(
                `SELECT id FROM graph_interactions WHERE kind IN (${kinds.map(() => "?").join(", ")})`,
              )
              .all(...kinds) as { id: string }[]
          ).map((r) => r.id);
    const ids = new Set(interactions);
    const prefix = SOURCE_REF_PREFIX[source];
    const derived = (sources: string) => {
      const list = JSON.parse(sources) as string[];
      return (
        list.length > 0 &&
        list.every((x) => ids.has(x) || (prefix !== undefined && x.startsWith(prefix)))
      );
    };
    const rowsOf = (table: string) =>
      (
        this.#db.prepare(`SELECT id, sources FROM ${table}`).all() as {
          id: string;
          sources: string;
        }[]
      ).filter((r) => derived(r.sources));
    const facts = rowsOf("graph_facts");
    const edges = rowsOf("graph_edges");
    const loops = (
      this.#db
        .prepare(
          "SELECT id, source_interaction_id AS sid FROM graph_loops WHERE detected_by != 'owner' AND source_interaction_id IS NOT NULL",
        )
        .all() as { id: string; sid: string }[]
    ).filter((r) => ids.has(r.sid));
    const match = SOURCE_COLUMN_MATCH[source];
    const removed: GraphRemovedCounts = {
      entities: 0,
      identifiers: this.#count(
        `SELECT count(*) AS n FROM graph_identifiers WHERE linked_by != 'owner' AND ${match}`,
      ),
      facts: facts.length,
      interactions: interactions.length,
      loops: loops.length,
    };
    const touched = new Set<string>();
    const orphans: { id: string; kind: GraphEntityKind; card_path: string | null }[] = [];
    const del = (table: string, rowIds: string[]) => {
      const stmt = this.#db.prepare(`DELETE FROM ${table} WHERE id = ?`);
      for (const id of rowIds) stmt.run(id);
    };
    const run = () => {
      const participant = this.#db.prepare(
        "SELECT entity_id FROM graph_participants WHERE interaction_id = ?",
      );
      for (const id of interactions)
        for (const p of participant.all(id) as { entity_id: string }[]) touched.add(p.entity_id);
      for (const r of this.#db
        .prepare(`SELECT entity_id FROM graph_identifiers WHERE linked_by != 'owner' AND ${match}`)
        .all() as { entity_id: string }[])
        touched.add(r.entity_id);
      const factEntity = this.#db.prepare("SELECT entity_id FROM graph_facts WHERE id = ?");
      for (const f of facts) {
        const r = factEntity.get(f.id) as { entity_id: string } | undefined;
        if (r !== undefined) touched.add(r.entity_id);
      }
      const edgeEnds = this.#db.prepare("SELECT src, dst FROM graph_edges WHERE id = ?");
      for (const e of edges) {
        const r = edgeEnds.get(e.id) as { src: string; dst: string } | undefined;
        if (r !== undefined) touched.add(r.src).add(r.dst);
      }
      del(
        "graph_loops",
        loops.map((l) => l.id),
      );
      del(
        "graph_facts",
        facts.map((f) => f.id),
      );
      del(
        "graph_edges",
        edges.map((e) => e.id),
      );
      del("graph_interactions", interactions);
      this.#db
        .prepare(`DELETE FROM graph_identifiers WHERE linked_by != 'owner' AND ${match}`)
        .run();
      this.#db.prepare(`DELETE FROM graph_aliases WHERE ${match}`).run();
      orphans.push(
        ...(
          this.#db
            .prepare(
              `SELECT id, kind, card_path FROM graph_entities e WHERE kind IN ('person', 'org') AND is_owner = 0 AND pinned = 0
              AND NOT EXISTS (SELECT 1 FROM graph_identifiers i WHERE i.entity_id = e.id)
              AND NOT EXISTS (SELECT 1 FROM graph_participants p WHERE p.entity_id = e.id)
              AND NOT EXISTS (SELECT 1 FROM graph_loops l WHERE l.counterpart_id = e.id)
              AND NOT EXISTS (SELECT 1 FROM graph_facts f WHERE f.entity_id = e.id)
              AND NOT EXISTS (SELECT 1 FROM graph_edges g WHERE g.src = e.id OR g.dst = e.id)`,
            )
            .all() as typeof orphans
        )
          // Only what this source touched: an owner-made name-only entry is never swept up.
          .filter((o) => touched.has(o.id)),
      );
      removed.entities = orphans.length;
      if (orphans.length > 0) {
        const marks = orphans.map(() => "?").join(", ");
        const oids = orphans.map((o) => o.id);
        this.#db.prepare(`DELETE FROM graph_fts WHERE entity_id IN (${marks})`).run(...oids);
        this.#db
          .prepare(`UPDATE graph_entities SET merged_into = NULL WHERE merged_into IN (${marks})`)
          .run(...oids);
        this.#db.prepare(`DELETE FROM graph_entities WHERE id IN (${marks})`).run(...oids);
      }
    };
    const cardPaths = () => orphans.flatMap((o) => (o.card_path === null ? [] : [o.card_path]));
    if (dryRun) {
      // The orphan count needs the deletes: run them in a transaction that is rolled back.
      try {
        this.#db.transaction(() => {
          run();
          throw new RollbackSignal();
        })();
      } catch (err) {
        if (!(err instanceof RollbackSignal)) throw err;
      }
      return { removed, cardPaths: cardPaths(), dryRun };
    }
    this.#secureDelete(run);
    const gone = new Set(orphans.map((o) => o.id));
    for (const id of touched) {
      const kind = gone.has(id) ? undefined : this.getEntity(id)?.kind;
      if (kind === undefined) continue;
      this.#reindex(id);
      this.#emit({ event: "memory.entity.updated", payload: { id, kind, changed: ["source"] } });
    }
    for (const o of orphans)
      this.#emit({
        event: "memory.entity.updated",
        payload: { id: o.id, kind: o.kind, changed: ["forgotten"] },
      });
    return { removed, cardPaths: cardPaths(), dryRun };
  }

  /**
   * Deletes the whole graph, keeping nothing: entities (the owner's too), interactions, facts,
   * loops, suggestions, corrections, the blocklist and cursors (`memory.graph.forgetAll`).
   */
  forgetAll(dryRun = false): { removed: GraphRemovedCounts; cardPaths: string[]; dryRun: boolean } {
    const removed: GraphRemovedCounts = {
      entities: this.#count("SELECT count(*) AS n FROM graph_entities"),
      identifiers: this.#count("SELECT count(*) AS n FROM graph_identifiers"),
      facts: this.#count("SELECT count(*) AS n FROM graph_facts"),
      interactions: this.#count("SELECT count(*) AS n FROM graph_interactions"),
      loops: this.#count("SELECT count(*) AS n FROM graph_loops"),
    };
    const cardPaths = (
      this.#db
        .prepare("SELECT card_path FROM graph_entities WHERE card_path IS NOT NULL")
        .all() as { card_path: string }[]
    ).map((r) => r.card_path);
    if (!dryRun) this.#secureDelete(() => this.#wipe());
    return { removed, cardPaths, dryRun };
  }

  /** Deletes interactions past retention and archives entities with nothing left (§4.9). */
  retention(): { interactions: number; archived: number } {
    const cutoff = new Date(this.#clock.now() - this.#retentionDays * DAY_MS).toISOString();
    const old = (
      this.#db.prepare("SELECT id FROM graph_interactions WHERE occurred_at < ?").all(cutoff) as {
        id: string;
      }[]
    ).map((r) => r.id);
    let archived = 0;
    this.#db.transaction(() => {
      for (let i = 0; i < old.length; i += 500) {
        const batch = old.slice(i, i + 500);
        this.#db
          .prepare(
            `DELETE FROM graph_interactions WHERE id IN (${batch.map(() => "?").join(", ")})`,
          )
          .run(...batch);
      }
      archived = this.#db
        .prepare(
          `UPDATE graph_entities SET status = 'archived' WHERE status = 'active' AND is_owner = 0 AND pinned = 0
             AND COALESCE(last_interaction_at, created_at) < ?
             AND NOT EXISTS (SELECT 1 FROM graph_facts f WHERE f.entity_id = graph_entities.id AND f.provenance = 'owner' AND f.retracted_at IS NULL)
             AND NOT EXISTS (SELECT 1 FROM graph_loops l WHERE (l.counterpart_id = graph_entities.id OR l.project_id = graph_entities.id) AND l.status IN ('open', 'suggested'))`,
        )
        .run(cutoff).changes;
    })();
    return { interactions: old.length, archived };
  }

  // --- model pass and project support ---------------------------------------------------------

  /** People and projects with new interactions since their last summary, pinned first (§5.2). */
  pendingForModel(limit: number): { id: string; kind: GraphEntityKind; fresh: number }[] {
    return this.#db
      .prepare(
        `SELECT e.id AS id, e.kind AS kind, count(DISTINCT i.id) AS fresh
           FROM graph_entities e
           JOIN graph_participants p ON p.entity_id = e.id
           JOIN graph_interactions i ON i.id = p.interaction_id
          WHERE e.status = 'active' AND e.hidden = 0 AND e.is_owner = 0 AND e.kind IN ('person', 'org')
            AND i.created_at > COALESCE(e.summary_at, '')
          GROUP BY e.id
         UNION ALL
         SELECT e.id, e.kind, count(DISTINCT i.id)
           FROM graph_entities e JOIN graph_interactions i ON i.project_id = e.id
          WHERE e.status = 'active' AND e.kind = 'project' AND i.created_at > COALESCE(e.summary_at, '')
          GROUP BY e.id
          ORDER BY fresh DESC
          LIMIT ?`,
      )
      .all(limit * 2)
      .map((r) => r as { id: string; kind: GraphEntityKind; fresh: number })
      .sort(
        (a, b) =>
          Number(this.getEntity(b.id)?.pinned ?? false) -
            Number(this.getEntity(a.id)?.pinned ?? false) || b.fresh - a.fresh,
      )
      .slice(0, limit);
  }

  /** Interactions of a project (by `project_id`), newest first. */
  projectInteractions(projectId: string, limit = 20): GraphInteraction[] {
    const ids = (
      this.#db
        .prepare(
          "SELECT id FROM graph_interactions WHERE project_id = ? ORDER BY occurred_at DESC, id DESC LIMIT ?",
        )
        .all(projectId, limit) as { id: string }[]
    ).map((r) => r.id);
    return ids
      .map((id) => this.interaction(id))
      .filter((i): i is GraphInteraction => i !== undefined);
  }

  interaction(id: string): GraphInteraction | undefined {
    const r = this.#db.prepare("SELECT * FROM graph_interactions WHERE id = ?").get(id) as
      | {
          id: string;
          kind: GraphInteractionKind;
          source: string;
          occurred_at: string;
          direction: GraphInteraction["direction"];
          subject: string | null;
          thread_key: string | null;
          link: string | null;
          project_id: string | null;
          gist: string | null;
        }
      | undefined;
    if (r === undefined) return undefined;
    const participants = (
      this.#db
        .prepare("SELECT entity_id, role FROM graph_participants WHERE interaction_id = ?")
        .all(id) as { entity_id: string; role: GraphParticipantRole }[]
    ).map((p) => ({ entityId: p.entity_id, role: p.role }));
    return {
      id: r.id,
      kind: r.kind,
      source: r.source,
      occurredAt: r.occurred_at,
      direction: r.direction,
      subject: r.subject,
      threadKey: r.thread_key,
      link: r.link,
      projectId: r.project_id,
      ...(r.gist === null ? {} : { gist: r.gist }),
      participants,
    };
  }

  /** Interactions in a window (project assignment and clustering), oldest first. */
  interactionsBetween(fromIso: string, toIso: string): GraphInteraction[] {
    const ids = (
      this.#db
        .prepare(
          "SELECT id FROM graph_interactions WHERE occurred_at >= ? AND occurred_at <= ? ORDER BY occurred_at, id",
        )
        .all(fromIso, toIso) as { id: string }[]
    ).map((r) => r.id);
    return ids
      .map((id) => this.interaction(id))
      .filter((i): i is GraphInteraction => i !== undefined);
  }

  setInteractionProject(interactionId: string, projectId: string | null): void {
    this.#db
      .prepare("UPDATE graph_interactions SET project_id = ? WHERE id = ?")
      .run(projectId, interactionId);
    if (projectId !== null) this.linkSubject(interactionId, projectId, "rule");
  }

  /** The owner's recent corrections of an entity's facts (attribute and value), newest first. */
  retractedFacts(entityId: string, limit = 5): { attribute: GraphFactAttribute; value: string }[] {
    return this.#db
      .prepare(
        "SELECT attribute, value FROM graph_facts WHERE entity_id = ? AND retracted_at IS NOT NULL ORDER BY retracted_at DESC LIMIT ?",
      )
      .all(entityId, limit) as { attribute: GraphFactAttribute; value: string }[];
  }

  // --- reads, search, status, export -----------------------------------------------------------

  summary(id: string): EntitySummary | undefined {
    const e = this.getEntity(id);
    if (e === undefined) return undefined;
    const openLoops = (
      this.#db
        .prepare(
          "SELECT count(*) AS n FROM graph_loops WHERE (counterpart_id = ? OR project_id = ?) AND status IN ('open', 'suggested')",
        )
        .get(id, id) as { n: number }
    ).n;
    let subtitle: string | null = null;
    if (e.kind === "person") {
      const org = this.edges(id).find((x) => x.rel === "works_at" && x.src === id);
      subtitle = org === undefined ? null : (this.#entityRow(org.dst)?.name ?? null);
      if (subtitle === null)
        subtitle = this.facts(id).find((f) => f.attribute === "employer")?.value ?? null;
    } else if (e.kind === "project") {
      const members = this.edges(id).filter(
        (x) => x.dst === id && (x.rel === "member_of" || x.rel === "stakeholder_of"),
      ).length;
      subtitle = `${e.projectType === "course" ? "course · " : ""}${e.projectStatus ?? "active"} · ${members} ${members === 1 ? "person" : "people"}`;
    } else if (e.kind === "assignment" || e.kind === "event") {
      const parent = this.edges(id).find((x) => x.rel === "part_of" && x.src === id);
      subtitle = parent === undefined ? null : (this.#entityRow(parent.dst)?.name ?? null);
    }
    return {
      id: e.id,
      kind: e.kind,
      name: e.name,
      subtitle,
      summary: e.summary,
      status: e.status,
      ...(e.projectStatus === undefined ? {} : { projectStatus: e.projectStatus }),
      ...(e.projectType === undefined ? {} : { projectType: e.projectType }),
      ...(e.workStatus === undefined ? {} : { workStatus: e.workStatus }),
      ...(e.kind === "assignment" || e.kind === "project" || e.kind === "event"
        ? { dueAt: e.dueAt }
        : {}),
      ...(e.private === true ? { private: true } : {}),
      lastInteractionAt: e.lastInteractionAt,
      openLoops,
      pinned: e.pinned,
      isOwner: e.isOwner,
    };
  }

  detail(id: string, etag = ""): GraphEntityDetail | undefined {
    const entity = this.getEntity(id);
    if (entity === undefined) return undefined;
    const edges = this.edges(id);
    const related = [...new Set(edges.map((e) => (e.src === id ? e.dst : e.src)))]
      .map((other) => this.summary(other))
      .filter((s): s is EntitySummary => s !== undefined);
    const openLoops = (
      this.#db
        .prepare(
          "SELECT * FROM graph_loops WHERE (counterpart_id = ? OR project_id = ?) AND status IN ('open', 'suggested', 'snoozed') ORDER BY created_at, id",
        )
        .all(id, id) as LoopRow[]
    ).map(toLoop);
    return {
      entity,
      identifiers: this.identifiers(id),
      facts: this.facts(id),
      edges,
      related,
      openLoops,
      recentInteractions: this.interactions(id, { limit: 10 }),
      etag,
    };
  }

  #reindex(id: string): void {
    const row = this.#entityRow(id);
    this.#db.prepare("DELETE FROM graph_fts WHERE entity_id = ?").run(id);
    if (row === undefined || row.status === "merged") return;
    const aliases = this.#aliases(id).join(" ");
    const idents = this.identifiers(id)
      .filter((i) => i.kind === "email" || i.kind === "domain")
      .map((i) => i.value)
      .join(" ");
    const facts = this.#factRows(id, true)
      // Not what a third party wrote, and never a sensitive learned fact (search would reveal it).
      .filter((f) => f.provenance !== "untrusted" && f.sensitivity === "none")
      .map((f) => f.value)
      .join(" ");
    this.#db
      .prepare(
        "INSERT INTO graph_fts (entity_id, name, aliases, facts, summary) VALUES (?, ?, ?, ?, ?)",
      )
      .run(id, row.name, `${aliases} ${idents}`.trim(), facts, row.summary ?? "");
  }

  /** Name, alias, email and fact matches, ranked by match and two-way contact strength. */
  search(
    q: string,
    opts: { kinds?: GraphEntityKind[]; limit?: number; includeArchived?: boolean } = {},
  ): EntitySummary[] {
    const limit = Math.min(Math.max(1, opts.limit ?? 20), 100);
    const terms = (normalizeName(q).match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, 12);
    const kinds = opts.kinds ?? ["person", "org", "project", "place"];
    let ids: { id: string; rank: number }[];
    if (terms.length === 0) {
      ids = this.#db
        .prepare(
          `SELECT id, 0 AS rank FROM graph_entities WHERE status ${opts.includeArchived ? "!= 'merged'" : "= 'active'"} AND kind IN (${kinds.map(() => "?").join(", ")})
             ORDER BY pinned DESC, COALESCE(last_interaction_at, '') DESC, sort_name LIMIT ?`,
        )
        .all(...kinds, limit) as { id: string; rank: number }[];
    } else {
      // Exact identifier lookups first (an email or phone typed in full).
      const exact = new Set<string>();
      for (const kind of ["email", "phone"] as const) {
        const hit = this.resolveIdentifier(kind, q);
        if (hit !== undefined) exact.add(hit);
      }
      const match = terms.map((t) => `"${t}"*`).join(" ");
      const rows = this.#db
        .prepare(
          "SELECT entity_id AS id, bm25(graph_fts, 0, 10, 6, 2, 1) AS rank FROM graph_fts WHERE graph_fts MATCH ? ORDER BY rank LIMIT 200",
        )
        .all(match) as { id: string; rank: number }[];
      ids = [...[...exact].map((id) => ({ id, rank: -1e9 })), ...rows];
    }
    const seen = new Set<string>();
    const out: { s: EntitySummary; score: number }[] = [];
    for (const { id, rank } of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      const row = this.#entityRow(id);
      if (row === undefined || !kinds.includes(row.kind)) continue;
      if (row.status === "merged" || (row.status === "archived" && opts.includeArchived !== true))
        continue;
      const s = this.summary(id);
      if (s === undefined) continue;
      const nameHit =
        terms.length > 0 &&
        terms.every((t) => row.sort_name.split(" ").some((w) => w.startsWith(t)))
          ? 2
          : 0;
      out.push({
        s,
        score: -rank + nameHit * 5 + Math.log1p(this.strength(id)) * 3 + (row.pinned === 1 ? 2 : 0),
      });
    }
    return out
      .sort((a, b) => b.score - a.score || a.s.name.localeCompare(b.s.name))
      .slice(0, limit)
      .map((x) => x.s);
  }

  /** Every active entity (for cards and the nightly pass). */
  listEntities(kinds?: GraphEntityKind[]): GraphEntity[] {
    const k = kinds ?? ["person", "org", "project", "place"];
    return (
      this.#db
        .prepare(
          `SELECT * FROM graph_entities WHERE status = 'active' AND kind IN (${k.map(() => "?").join(", ")}) ORDER BY sort_name, id`,
        )
        .all(...k) as EntityRow[]
    ).map((r) => toEntity(r, this.#aliases(r.id)));
  }

  cursor(source: string): unknown {
    const row = this.#db.prepare("SELECT cursor FROM graph_cursors WHERE source = ?").get(source) as
      | { cursor: string }
      | undefined;
    return row === undefined ? undefined : JSON.parse(row.cursor);
  }

  setCursor(source: string, cursor: unknown): void {
    this.#db
      .prepare(
        "INSERT INTO graph_cursors (source, cursor, updated_at) VALUES (?, ?, ?) ON CONFLICT (source) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at",
      )
      .run(source, JSON.stringify(cursor ?? null), this.#now());
  }

  status(settings: {
    enabled: boolean;
    sources: Partial<Record<GraphSource, boolean>>;
    lastModelPassAt?: string | null;
    budget?: GraphStatus["budget"];
  }): GraphStatus {
    const kindCount = (kind: string) =>
      (
        this.#db
          .prepare("SELECT count(*) AS n FROM graph_entities WHERE kind = ? AND status = 'active'")
          .get(kind) as { n: number }
      ).n;
    const since = new Date(this.#clock.now() - 30 * DAY_MS).toISOString();
    const SOURCES = Object.keys(SOURCE_KINDS) as GraphSource[];
    return {
      enabled: settings.enabled,
      sources: SOURCES.map((source) => {
        const kinds = SOURCE_KINDS[source];
        const interactions =
          kinds.length === 0
            ? 0
            : (
                this.#db
                  .prepare(
                    `SELECT count(*) AS n FROM graph_interactions WHERE kind IN (${kinds.map(() => "?").join(", ")})`,
                  )
                  .get(...kinds) as { n: number }
              ).n;
        const entities = (
          this.#db
            .prepare(
              "SELECT count(DISTINCT entity_id) AS n FROM graph_identifiers WHERE source LIKE ?",
            )
            .get(`%${source}%`) as { n: number }
        ).n;
        const last = this.#db
          .prepare(
            "SELECT updated_at FROM graph_cursors WHERE source LIKE ? ORDER BY updated_at DESC LIMIT 1",
          )
          .get(`%${source}%`) as { updated_at: string } | undefined;
        return {
          source,
          enabled: settings.sources[source] === true,
          entities,
          interactions,
          lastIngestAt: last?.updated_at ?? null,
        };
      }),
      counts: {
        people: kindCount("person"),
        orgs: kindCount("org"),
        projects: kindCount("project"),
        places: kindCount("place"),
        openLoops: (
          this.#db
            .prepare("SELECT count(*) AS n FROM graph_loops WHERE status IN ('open', 'suggested')")
            .get() as { n: number }
        ).n,
        pendingSuggestions: (
          this.#db
            .prepare("SELECT count(*) AS n FROM graph_suggestions WHERE status = 'pending'")
            .get() as { n: number }
        ).n,
      },
      lastModelPassAt: settings.lastModelPassAt ?? null,
      budget: settings.budget ?? {
        entitiesUsed: 0,
        tokensUsed: 0,
        maxEntities: 200,
        maxTokens: 150_000,
      },
      loopPrecision: SOURCES.map((source) => {
        const kinds = SOURCE_KINDS[source];
        if (kinds.length === 0) return { source, confirmed: 0, dismissed: 0 };
        const q = (status: string) =>
          (
            this.#db
              .prepare(
                `SELECT count(*) AS n FROM graph_loops l JOIN graph_interactions i ON i.id = l.source_interaction_id
                  WHERE l.detected_by != 'owner' AND l.updated_at >= ? AND l.status = ? AND i.kind IN (${kinds.map(() => "?").join(", ")})`,
              )
              .get(since, status, ...kinds) as { n: number }
          ).n;
        return { source, confirmed: q("open") + q("done"), dismissed: q("dismissed") };
      }),
    };
  }

  /** `graph.json` for `memory.export`: entities with identifiers, facts, edges and loops. */
  exportJson(): Record<string, unknown> {
    const entities = this.listEntities().map((e) => ({
      ...e,
      identifiers: this.identifiers(e.id),
      facts: this.history(e.id).facts,
      notes: this.notes(e.id),
    }));
    const edges = (
      this.#db.prepare("SELECT * FROM graph_edges ORDER BY created_at, id").all() as EdgeRow[]
    ).map(toEdge);
    const loops = (
      this.#db.prepare("SELECT * FROM graph_loops ORDER BY created_at, id").all() as LoopRow[]
    ).map(toLoop);
    const interactions = this.#db
      .prepare(
        "SELECT id, kind, source, occurred_at, direction, link, project_id FROM graph_interactions ORDER BY occurred_at, id",
      )
      .all() as Record<string, unknown>[];
    return { version: 1, exportedAt: this.#now(), entities, edges, loops, interactions };
  }

  /** `memory.reset`: everything in the graph goes. */
  reset(): void {
    this.#wipe();
  }

  #wipe(): void {
    this.#db.exec(
      "DELETE FROM graph_loops; DELETE FROM graph_participants; DELETE FROM graph_interactions; DELETE FROM graph_suggestions; DELETE FROM graph_feedback; DELETE FROM graph_blocklist; DELETE FROM graph_cursors; DELETE FROM graph_fts; UPDATE graph_entities SET merged_into = NULL; DELETE FROM graph_entities;",
    );
  }
}
