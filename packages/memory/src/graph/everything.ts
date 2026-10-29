import {
  type Clock,
  type GraphCitation,
  type GraphCitationSource,
  type GraphCitationTarget,
  type GraphEdgeRel,
  type GraphFact,
  type GraphFactAttribute,
  GraphFactAttribute as GraphFactAttributeSchema,
  type GraphFamilyRole,
  type GraphIdentifierKind,
  type GraphReviewState,
  type GraphSensitivity,
  type GraphSubjectKind,
  type MemoryRun,
  type Provenance,
  PsycheError,
  type QuarantineItem,
  type QuarantineReason,
  type ReviewItem,
} from "@psyche/protocol";
import type Database from "better-sqlite3";
import { monotonicFactory } from "ulid";
import { oneLine } from "../daily.ts";
import { blockingKinds, detectSensitive, looksLikeInstruction } from "../filters.ts";
import { blockHash, normalizeIdentifier, normalizeName, sha256 } from "./normalize.ts";
import {
  ACCEPTED_REVIEW_SQL,
  factKeyHash,
  type GraphStore,
  LIFE_ATTRIBUTES,
  MULTI_VALUED,
  OWNER_ONLY_RELS,
} from "./store.ts";

/**
 * The everything-memory store (docs/design/everything-memory-2026.md §4.3-4.7, §5.6, §6.7, §7,
 * §10): proposed facts with citations, supersession and conflict rules, the review decisions,
 * quarantine, per-contact exclusion, retention, per-person export and "forget what they said".
 *
 * It sits beside `GraphStore` on the same database. Nothing here reads a source or calls a
 * model; later phases feed it. A fact that comes from third-party text is always `untrusted`
 * and always lands `pending`: only `decide` (the owner) moves it on, and an accepted untrusted
 * fact stays `untrusted` unless the owner edits it (§5.4).
 */

const DAY_MS = 86_400_000;
const VALUE_CHARS = 2000;
const QUOTE_CHARS = 200;
const EXCERPT_CHARS = 300;
/** How long an auto-accepted fact can be undone (§7.2). */
export const UNDO_DAYS = 7;
/** Discarded rows are kept this long so the owner's feedback has settled, then deleted. */
const DISCARDED_KEEP_DAYS = 7;

/** Single-valued attributes of the life group (§4.3); the legacy attributes keep their rule. */
const LIFE_SINGLE_VALUED: ReadonlySet<string> = new Set([
  "employer",
  "title",
  "role",
  "city",
  "birthday",
  "anniversary",
  "school",
  "contact_pref",
]);

/** Whether a new value for this attribute replaces the old one (§4.5). */
export function isSingleValued(attribute: GraphFactAttribute): boolean {
  if (LIFE_ATTRIBUTES.has(attribute)) {
    return LIFE_SINGLE_VALUED.has(attribute);
  }
  return !MULTI_VALUED.has(attribute);
}

/** owner > Contacts (`system`) > agent from owner-authored text > untrusted (§4.5). */
const RANK: Record<Provenance, number> = { untrusted: 1, agent: 2, system: 3, owner: 4 };

/** Relations a text may suggest (`related_to` / `reports_to` are the owner's; no `knows`). */
const EDGE_RELS_PROPOSABLE: ReadonlySet<GraphEdgeRel> = new Set([
  "works_at",
  "member_of",
  "stakeholder_of",
  "located_at",
  "part_of",
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

/** Sensitivity classes that are never stored, whatever the owner switches on (decision 5). */
const HARD_BLOCKED: ReadonlySet<GraphSensitivity> = new Set(["gov_id", "account_numbers"]);

export type RefuseReason =
  | "unknown_entity"
  | "hidden_entity"
  | "excluded"
  | "unknown_attribute"
  | "empty_value"
  | "owner_provenance"
  | "hard_blocked"
  | "secret_in_value"
  | "instruction_like"
  | "no_citation"
  | "bad_citation"
  | "rejected_before"
  | "never_rule";

export interface CitationInput {
  source: GraphCitationSource;
  sourceRef: string;
  quote: string;
  start: number;
  end: number;
  sourceHash: string;
  docId?: string | null;
  authorEntityId?: string | null;
  observedAt?: string;
}

export interface ProposeFactInput {
  entityId: string;
  attribute: GraphFactAttribute;
  value: string;
  /** Never `owner`: owner writes are `decide(edit)` or `GraphStore.setFact`. */
  provenance: Exclude<Provenance, "owner">;
  subjectKind: GraphSubjectKind;
  sensitivity?: GraphSensitivity;
  confidence?: number;
  citations: CitationInput[];
  runId?: string | null;
  extractor?: string;
  /** Ask for `auto_accepted`; honoured only for non-untrusted, non-sensitive, conflict-free facts. */
  autoAccept?: boolean;
}

export type ProposeOutcome =
  | {
      status: "pending" | "auto_accepted" | "superseded" | "refreshed" | "conflict";
      fact: GraphFact;
      /** The accepted fact this one replaced (superseded) or disagrees with (conflict). */
      otherId?: string;
    }
  | { status: "refused"; reason: RefuseReason };

export interface ProposeEdgeInput {
  src: string;
  dst: string;
  rel: GraphEdgeRel;
  role?: GraphFamilyRole;
  provenance: Exclude<Provenance, "owner">;
  confidence?: number;
  citations: CitationInput[];
}

export type ProposeEdgeOutcome =
  | { status: "pending" | "refreshed"; edgeId: string }
  | { status: "refused"; reason: RefuseReason | "bad_relation" | "self_relation" };

export interface ExclusionEntry {
  /** `<kind>:<hash>`; opaque, for removal. */
  id: string;
  kind: GraphIdentifierKind;
  hint: string | null;
  mode: "exclude" | "forget";
  createdAt: string;
}

export interface RetentionPolicy {
  pendingDays: number;
  /** 0 keeps accepted untrusted facts forever. */
  untrustedAcceptedMonths: number;
  quarantineDays: number;
  runLogDays: number;
}

export interface RetentionResult {
  pendingExpired: number;
  untrustedExpired: number;
  discardedDeleted: number;
  quarantineDeleted: number;
  runsDeleted: number;
}

export interface EverythingStoreOptions {
  sqlite: Database.Database;
  graph: GraphStore;
  clock?: Clock;
  newId?: () => string;
  /** Country code for national phone numbers (default "1"). */
  defaultCountry?: string;
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
  updated_at: string;
  subject_kind: GraphSubjectKind;
  sensitivity: GraphSensitivity;
  review: GraphReviewState;
  first_seen_at: string | null;
  last_seen_at: string | null;
  run_id: string | null;
  extractor: string | null;
}

interface CitationRow {
  id: string;
  target_kind: GraphCitationTarget;
  target_id: string;
  source: GraphCitationSource;
  doc_id: string | null;
  source_ref: string;
  quote: string;
  start: number;
  end: number;
  source_hash: string;
  author_entity_id: string | null;
  provenance: Provenance;
  observed_at: string;
  created_at: string;
}

const ATTRIBUTES = new Set<string>(GraphFactAttributeSchema.enum);

function fail(code: PsycheError["code"], message: string): never {
  throw new PsycheError(code, message);
}

function clip(text: string | null | undefined, max: number): string | null {
  if (text === null || text === undefined) return null;
  const t = oneLine(text);
  return t.length === 0 ? null : t.slice(0, max);
}

/** Untrusted text for a card or list: one line, no control or bidi characters. */
export function safeExcerpt(text: string, max: number): string {
  return (
    Array.from(text)
      // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping controls is the point
      .filter((c) => !/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/.test(c))
      .join("")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, max)
  );
}

/** "sam@acme.com" → "s•••@acme.com"; phones keep their last two digits; domains show whole. */
export function maskHint(kind: GraphIdentifierKind, norm: string): string | null {
  if (kind === "domain") return norm;
  if (kind === "phone") return `•••${norm.replace(/\D/g, "").slice(-2)}`;
  if (kind === "email") {
    const [user = "", domain = ""] = norm.split("@");
    return `${user.slice(0, 1)}•••@${domain}`;
  }
  return null;
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

function toCitation(r: CitationRow): GraphCitation {
  return {
    id: r.id,
    targetKind: r.target_kind,
    targetId: r.target_id,
    source: r.source,
    docId: r.doc_id,
    sourceRef: r.source_ref,
    quote: r.quote,
    start: r.start,
    end: r.end,
    sourceHash: r.source_hash,
    authorEntityId: r.author_entity_id,
    provenance: r.provenance,
    observedAt: r.observed_at,
    createdAt: r.created_at,
  };
}

export class EverythingStore {
  readonly #db: Database.Database;
  readonly #graph: GraphStore;
  readonly #clock: Clock;
  readonly #newId: () => string;
  readonly #country: string;

  constructor(options: EverythingStoreOptions) {
    this.#db = options.sqlite;
    this.#graph = options.graph;
    this.#clock = options.clock ?? { now: () => Date.now() };
    const ulid = monotonicFactory();
    this.#newId = options.newId ?? (() => ulid());
    this.#country = options.defaultCountry ?? "1";
  }

  #now(): string {
    return new Date(this.#clock.now()).toISOString();
  }

  #id(prefix: string): string {
    return `${prefix}_${this.#newId()}`;
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

  // --- citations -------------------------------------------------------------------------------

  citations(targetKind: GraphCitationTarget, targetId: string): GraphCitation[] {
    return (
      this.#db
        .prepare(
          "SELECT * FROM graph_citations WHERE target_kind = ? AND target_id = ? ORDER BY created_at, id",
        )
        .all(targetKind, targetId) as CitationRow[]
    ).map(toCitation);
  }

  #validCitation(c: CitationInput): boolean {
    return (
      c.quote.length > 0 &&
      c.quote.length <= QUOTE_CHARS &&
      Number.isInteger(c.start) &&
      Number.isInteger(c.end) &&
      c.start >= 0 &&
      c.end >= c.start &&
      c.sourceRef.length > 0 &&
      c.sourceRef.length <= 1024 &&
      c.sourceHash.length > 0
    );
  }

  #addCitation(
    targetKind: GraphCitationTarget,
    targetId: string,
    c: CitationInput,
    provenance: Provenance,
  ): void {
    const now = this.#now();
    const dup = this.#db
      .prepare(
        'SELECT 1 FROM graph_citations WHERE target_kind = ? AND target_id = ? AND source = ? AND source_ref = ? AND start = ? AND "end" = ? AND source_hash = ?',
      )
      .get(targetKind, targetId, c.source, c.sourceRef, c.start, c.end, c.sourceHash);
    if (dup !== undefined) return;
    this.#db
      .prepare(
        `INSERT INTO graph_citations (id, target_kind, target_id, source, doc_id, source_ref, quote, start, "end",
           source_hash, author_entity_id, provenance, observed_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        this.#id("cite"),
        targetKind,
        targetId,
        c.source,
        c.docId ?? null,
        c.sourceRef,
        c.quote,
        c.start,
        c.end,
        c.sourceHash,
        c.authorEntityId ?? null,
        provenance,
        c.observedAt ?? now,
        now,
      );
  }

  /**
   * The source item was deleted or its source turned off: its citations go, and every fact or
   * relation left without one is removed (§4.4). Owner-written facts (provenance `owner`) stay.
   */
  dropSource(
    source: GraphCitationSource,
    sourceRef?: string,
  ): { citations: number; facts: number; edges: number } {
    const where = sourceRef === undefined ? "source = ?" : "source = ? AND source_ref = ?";
    const args = sourceRef === undefined ? [source] : [source, sourceRef];
    return this.#secure(() => {
      const touched = this.#db
        .prepare(`SELECT DISTINCT target_kind, target_id FROM graph_citations WHERE ${where}`)
        .all(...args) as { target_kind: GraphCitationTarget; target_id: string }[];
      const citations = this.#db
        .prepare(`DELETE FROM graph_citations WHERE ${where}`)
        .run(...args).changes;
      let facts = 0;
      let edges = 0;
      const left = this.#db.prepare(
        "SELECT 1 FROM graph_citations WHERE target_kind = ? AND target_id = ? LIMIT 1",
      );
      const entities = new Set<string>();
      for (const t of touched) {
        if (left.get(t.target_kind, t.target_id) !== undefined) continue;
        if (t.target_kind === "fact") {
          const row = this.#factRow(t.target_id);
          if (row === undefined || row.provenance === "owner") continue;
          this.#deleteFacts([row.id]);
          entities.add(row.entity_id);
          facts++;
        } else if (t.target_kind === "edge") {
          const row = this.#db
            .prepare("SELECT src, dst, provenance FROM graph_edges WHERE id = ?")
            .get(t.target_id) as { src: string; dst: string; provenance: Provenance } | undefined;
          if (row === undefined || row.provenance === "owner") continue;
          this.#db.prepare("DELETE FROM graph_edges WHERE id = ?").run(t.target_id);
          entities.add(row.src);
          entities.add(row.dst);
          edges++;
        }
      }
      for (const id of entities) this.#graph.touch(id, ["facts"]);
      return { citations, facts, edges };
    });
  }

  /** Deletes facts, reviving the versions they had replaced. */
  #deleteFacts(ids: string[]): void {
    const revive = this.#db.prepare(
      "UPDATE graph_facts SET valid_to = NULL WHERE superseded_by = ? AND retracted_at IS NULL",
    );
    const del = this.#db.prepare("DELETE FROM graph_facts WHERE id = ?");
    for (const id of ids) {
      revive.run(id);
      del.run(id);
    }
  }

  // --- exclusions (§10.1) ----------------------------------------------------------------------

  #normalize(kind: GraphIdentifierKind, value: string): string | undefined {
    return normalizeIdentifier(kind, value, this.#country);
  }

  /** Never read this identifier's text or learn facts from or about it. */
  exclude(
    kind: GraphIdentifierKind,
    value: string,
    mode: "exclude" | "forget" = "exclude",
  ): ExclusionEntry {
    const norm = this.#normalize(kind, value);
    if (norm === undefined) fail("invalid_params", "not a valid identifier");
    const hint = maskHint(kind, norm);
    const now = this.#now();
    this.#db
      .prepare(
        `INSERT INTO graph_exclusions (kind, value_hash, mode, hint, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (kind, value_hash) DO UPDATE SET mode = excluded.mode`,
      )
      .run(kind, blockHash(kind, norm), mode, hint, now);
    return { id: `${kind}:${blockHash(kind, norm)}`, kind, hint, mode, createdAt: now };
  }

  /**
   * Exclude an address, number or domain for the owner (Settings): the exclusion is stored, and
   * with `forget` everything learned from the people who use it is deleted too. `dryRun` counts
   * without writing.
   */
  excludeIdentifier(
    kind: GraphIdentifierKind,
    value: string,
    mode: "exclude" | "forget",
    dryRun = false,
  ): {
    entry: ExclusionEntry | undefined;
    forgotten: { facts: number; edges: number; citations: number; quarantine: number };
  } {
    const norm = this.#normalize(kind, value);
    if (norm === undefined) fail("invalid_params", "not a valid identifier");
    const people = new Set<string>();
    if (mode === "forget") {
      const rows =
        kind === "domain"
          ? (this.#db
              .prepare(
                "SELECT entity_id FROM graph_identifiers WHERE kind = 'email' AND value_norm LIKE ?",
              )
              .all(`%@${norm.replace(/[%_]/g, "")}`) as { entity_id: string }[])
          : (this.#db
              .prepare("SELECT entity_id FROM graph_identifiers WHERE kind = ? AND value_norm = ?")
              .all(kind, norm) as { entity_id: string }[]);
      for (const r of rows) people.add(r.entity_id);
    }
    const forgotten = { facts: 0, edges: 0, citations: 0, quarantine: 0 };
    for (const id of people) {
      const r = this.forgetWhatTheySaid(id, dryRun);
      forgotten.facts += r.facts;
      forgotten.edges += r.edges;
      forgotten.citations += r.citations;
      forgotten.quarantine += r.quarantine;
    }
    return { entry: dryRun ? undefined : this.exclude(kind, value, mode), forgotten };
  }

  /** Excludes every identifier of a person (and, with `forget`, what they said). */
  excludeEntity(entityId: string, mode: "exclude" | "forget" = "exclude"): number {
    const ids = this.#db
      .prepare("SELECT kind, value_norm FROM graph_identifiers WHERE entity_id = ?")
      .all(entityId) as { kind: GraphIdentifierKind; value_norm: string }[];
    const now = this.#now();
    const ins = this.#db.prepare(
      `INSERT INTO graph_exclusions (kind, value_hash, mode, hint, created_at) VALUES (?, ?, ?, NULL, ?)
       ON CONFLICT (kind, value_hash) DO UPDATE SET mode = excluded.mode`,
    );
    let n = 0;
    this.#db.transaction(() => {
      for (const i of ids) {
        if (i.kind === "url" || i.kind === "calendar") continue;
        ins.run(i.kind, blockHash(i.kind, i.value_norm), mode, now);
        n++;
      }
    })();
    if (mode === "forget") this.forgetWhatTheySaid(entityId);
    return n;
  }

  isExcluded(kind: GraphIdentifierKind, value: string): boolean {
    const norm = this.#normalize(kind, value);
    if (norm === undefined) return false;
    const has = this.#db.prepare(
      "SELECT 1 FROM graph_exclusions WHERE kind = ? AND value_hash = ?",
    );
    if (has.get(kind, blockHash(kind, norm)) !== undefined) return true;
    // A whole domain (an employer, a doctor's office) covers its addresses.
    if (kind === "email" && norm.includes("@")) {
      const domain = norm.slice(norm.lastIndexOf("@") + 1);
      return has.get("domain", blockHash("domain", domain)) !== undefined;
    }
    return false;
  }

  /** True when any identifier of the person is excluded. */
  isEntityExcluded(entityId: string): boolean {
    const ids = this.#db
      .prepare("SELECT kind, value_norm FROM graph_identifiers WHERE entity_id = ?")
      .all(entityId) as { kind: GraphIdentifierKind; value_norm: string }[];
    return ids.some((i) => this.isExcluded(i.kind, i.value_norm));
  }

  exclusions(): ExclusionEntry[] {
    return (
      this.#db
        .prepare(
          "SELECT kind, value_hash, mode, hint, created_at FROM graph_exclusions ORDER BY created_at, kind",
        )
        .all() as {
        kind: GraphIdentifierKind;
        value_hash: string;
        mode: "exclude" | "forget";
        hint: string | null;
        created_at: string;
      }[]
    ).map((r) => ({
      id: `${r.kind}:${r.value_hash}`,
      kind: r.kind,
      hint: r.hint,
      mode: r.mode,
      createdAt: r.created_at,
    }));
  }

  removeExclusionById(id: string): boolean {
    const i = id.indexOf(":");
    if (i <= 0) return false;
    return (
      this.#db
        .prepare("DELETE FROM graph_exclusions WHERE kind = ? AND value_hash = ?")
        .run(id.slice(0, i), id.slice(i + 1)).changes > 0
    );
  }

  removeExclusion(kind: GraphIdentifierKind, value: string): boolean {
    const norm = this.#normalize(kind, value);
    if (norm === undefined) return false;
    return (
      this.#db
        .prepare("DELETE FROM graph_exclusions WHERE kind = ? AND value_hash = ?")
        .run(kind, blockHash(kind, norm)).changes > 0
    );
  }

  // --- never rules (§7.1) ----------------------------------------------------------------------

  addNeverRule(
    kind: "attribute_for_entity" | "attribute_from_sender",
    entityId: string,
    attribute: GraphFactAttribute,
  ): void {
    this.#db
      .prepare(
        "INSERT OR IGNORE INTO memory_never_rules (kind, entity_id, attribute, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(kind, entityId, attribute, this.#now());
  }

  #neverBlocked(entityId: string, attribute: string, senders: string[]): boolean {
    const q = this.#db.prepare(
      "SELECT 1 FROM memory_never_rules WHERE kind = ? AND entity_id = ? AND attribute = ?",
    );
    if (q.get("attribute_for_entity", entityId, attribute) !== undefined) return true;
    return senders.some((s) => q.get("attribute_from_sender", s, attribute) !== undefined);
  }

  // --- proposing facts (§4.5, §5.1 stage 3) ------------------------------------------------------

  #current(entityId: string, attribute: GraphFactAttribute): FactRow[] {
    return this.#db
      .prepare(
        `SELECT * FROM graph_facts WHERE entity_id = ? AND attribute = ? AND superseded_by IS NULL
           AND retracted_at IS NULL AND (valid_to IS NULL OR valid_to > ?) AND review IN ${ACCEPTED_REVIEW_SQL}
         ORDER BY recorded_at DESC, id DESC`,
      )
      .all(entityId, attribute, this.#now()) as FactRow[];
  }

  #pendingSame(
    entityId: string,
    attribute: GraphFactAttribute,
    value: string,
  ): FactRow | undefined {
    const rows = this.#db
      .prepare(
        "SELECT * FROM graph_facts WHERE entity_id = ? AND attribute = ? AND review = 'pending' AND retracted_at IS NULL",
      )
      .all(entityId, attribute) as FactRow[];
    const norm = normalizeName(value);
    return rows.find((r) => normalizeName(r.value) === norm);
  }

  /**
   * Stores a proposed fact. Deterministic: the caller (the validator, EM2) has already checked
   * the citation against the source text; this enforces what the database must never hold.
   * Third-party text (`untrusted`) is always `pending`; a lower-ranked value never replaces a
   * higher-ranked one, it becomes a conflict for the owner (§4.5).
   */
  proposeFact(input: ProposeFactInput): ProposeOutcome {
    const refused = (reason: RefuseReason): ProposeOutcome => ({ status: "refused", reason });
    if ((input.provenance as string) === "owner") return refused("owner_provenance");
    const entity = this.#db
      .prepare("SELECT id, hidden FROM graph_entities WHERE id = ?")
      .get(input.entityId) as { id: string; hidden: number } | undefined;
    if (entity === undefined) return refused("unknown_entity");
    if (entity.hidden === 1) return refused("hidden_entity");
    if (this.isEntityExcluded(entity.id)) return refused("excluded");
    if (!ATTRIBUTES.has(input.attribute)) return refused("unknown_attribute");
    const sensitivity = input.sensitivity ?? "none";
    if (HARD_BLOCKED.has(sensitivity)) return refused("hard_blocked");
    const value = clip(input.value, VALUE_CHARS);
    if (value === null) return refused("empty_value");
    // Secrets, cards, government ids and account numbers never; health only as a declared class.
    const found = detectSensitive(value);
    if (found.some((k) => k !== "health")) return refused("secret_in_value");
    if (found.includes("health") && sensitivity !== "health") return refused("secret_in_value");
    if (looksLikeInstruction(value)) return refused("instruction_like");
    if (input.citations.length === 0) return refused("no_citation");
    if (!input.citations.every((c) => this.#validCitation(c))) return refused("bad_citation");
    const senders = input.citations
      .map((c) => c.authorEntityId)
      .filter((s): s is string => typeof s === "string");
    if (this.#neverBlocked(entity.id, input.attribute, senders)) return refused("never_rule");
    const keyHash = factKeyHash(input.attribute, value);
    if (
      this.#db
        .prepare(
          "SELECT 1 FROM graph_feedback WHERE kind = 'wrong_fact' AND entity_id = ? AND key_hash = ?",
        )
        .get(entity.id, keyHash) !== undefined
    ) {
      return refused("rejected_before");
    }

    const now = this.#now();
    const untrusted = input.provenance === "untrusted";
    const mayAuto =
      input.autoAccept === true &&
      !untrusted &&
      sensitivity === "none" &&
      input.attribute !== "note" &&
      input.subjectKind !== "about_other";
    const addCitations = (factId: string) => {
      for (const c of input.citations) this.#addCitation("fact", factId, c, input.provenance);
    };
    const refresh = (row: FactRow, status: "refreshed"): ProposeOutcome => {
      const sources = [
        ...new Set([
          ...(JSON.parse(row.sources) as string[]),
          ...input.citations.map((c) => `${c.source}:${c.sourceRef}`),
        ]),
      ];
      this.#db.transaction(() => {
        this.#db
          .prepare(
            "UPDATE graph_facts SET last_seen_at = ?, sources = ?, updated_at = ? WHERE id = ?",
          )
          .run(now, JSON.stringify(sources), now, row.id);
        addCitations(row.id);
      })();
      return { status, fact: toFact(this.#factRow(row.id) as FactRow) };
    };

    const current = this.#current(entity.id, input.attribute);
    const norm = normalizeName(value);
    const same = current.find((r) => normalizeName(r.value) === norm);
    if (same !== undefined) return refresh(same, "refreshed");
    const pendingSame = this.#pendingSame(entity.id, input.attribute, value);
    if (pendingSame !== undefined) return refresh(pendingSame, "refreshed");

    const single = isSingleValued(input.attribute);
    const prior = single ? current[0] : undefined;
    let review: GraphReviewState = mayAuto ? "auto_accepted" : "pending";
    let status: "pending" | "auto_accepted" | "superseded" | "conflict" = "pending";
    let otherId: string | undefined;
    if (prior !== undefined) {
      const lower = RANK[input.provenance] < RANK[prior.provenance];
      const ownerConfirmed = prior.review === "accepted" || prior.review === "edited";
      if (lower) {
        // A lower-ranked source never changes what a higher-ranked one said: ask.
        review = "pending";
        status = "conflict";
        otherId = prior.id;
      } else if (review === "auto_accepted" && !ownerConfirmed) {
        status = "superseded";
        otherId = prior.id;
      } else {
        // Same rank on something the owner confirmed (or anything unauthorised): review it.
        review = "pending";
        status = "pending";
        otherId = prior.id;
      }
    } else if (review === "auto_accepted") {
      status = "auto_accepted";
    }

    const id = this.#id("fact");
    const sources = [...new Set(input.citations.map((c) => `${c.source}:${c.sourceRef}`))];
    this.#db.transaction(() => {
      this.#db
        .prepare(
          `INSERT INTO graph_facts (id, entity_id, attribute, value, provenance, confidence, sources, evidence,
             valid_from, valid_to, recorded_at, created_at, updated_at, subject_kind, sensitivity, review,
             first_seen_at, last_seen_at, run_id, extractor)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          entity.id,
          input.attribute,
          value,
          input.provenance,
          Math.min(1, Math.max(0, input.confidence ?? 0.6)),
          JSON.stringify(sources),
          clip(input.citations[0]?.quote, QUOTE_CHARS),
          now,
          now,
          now,
          now,
          input.subjectKind,
          sensitivity,
          review,
          now,
          now,
          input.runId ?? null,
          clip(input.extractor, 200),
        );
      addCitations(id);
      if (status === "superseded" && prior !== undefined) {
        this.#db
          .prepare(
            "UPDATE graph_facts SET superseded_by = ?, valid_to = ?, updated_at = ? WHERE id = ?",
          )
          .run(id, now, now, prior.id);
      }
    })();
    if (review !== "pending") this.#graph.touch(entity.id, ["facts"]);
    return {
      status,
      fact: toFact(this.#factRow(id) as FactRow),
      ...(otherId === undefined ? {} : { otherId }),
    };
  }

  /**
   * Stores a proposed relation. Always `pending`: a relation from text is a suggestion the owner
   * confirms ("Is Dana your sister?"), never a merge or a route. `related_to` and `reports_to`
   * carry personal labels and stay with the owner and Contacts; `knows` does not exist.
   */
  proposeEdge(input: ProposeEdgeInput): ProposeEdgeOutcome {
    const refused = (
      reason: RefuseReason | "bad_relation" | "self_relation",
    ): ProposeEdgeOutcome => ({ status: "refused", reason });
    if ((input.provenance as string) === "owner") return refused("owner_provenance");
    if (!EDGE_RELS_PROPOSABLE.has(input.rel) || OWNER_ONLY_RELS.has(input.rel)) {
      return refused("bad_relation");
    }
    if (input.role !== undefined && input.rel !== "family") return refused("bad_relation");
    if (input.src === input.dst) return refused("self_relation");
    const ends = [input.src, input.dst].map(
      (id) =>
        this.#db.prepare("SELECT id, hidden FROM graph_entities WHERE id = ?").get(id) as
          | { id: string; hidden: number }
          | undefined,
    );
    if (ends.some((e) => e === undefined)) return refused("unknown_entity");
    if (ends.some((e) => e?.hidden === 1)) return refused("hidden_entity");
    if (ends.some((e) => e !== undefined && this.isEntityExcluded(e.id)))
      return refused("excluded");
    if (input.citations.length === 0) return refused("no_citation");
    if (!input.citations.every((c) => this.#validCitation(c))) return refused("bad_citation");
    const keyHash = sha256(`${input.rel}\n${input.dst}`);
    if (
      this.#db
        .prepare(
          "SELECT 1 FROM graph_feedback WHERE kind = 'wrong_edge' AND entity_id = ? AND key_hash = ?",
        )
        .get(input.src, keyHash) !== undefined
    ) {
      return refused("rejected_before");
    }
    const now = this.#now();
    const existing = this.#db
      .prepare(
        `SELECT id FROM graph_edges WHERE src = ? AND dst = ? AND rel = ? AND COALESCE(role, '') = ?
           AND retracted_at IS NULL AND superseded_by IS NULL AND review IN ('pending', 'accepted', 'auto_accepted', 'edited')`,
      )
      .get(input.src, input.dst, input.rel, input.role ?? "") as { id: string } | undefined;
    const id = existing?.id ?? this.#id("edge");
    this.#db.transaction(() => {
      if (existing === undefined) {
        this.#db
          .prepare(
            `INSERT INTO graph_edges (id, src, dst, rel, role, review, provenance, confidence, sources,
               valid_from, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            input.src,
            input.dst,
            input.rel,
            input.role ?? null,
            input.provenance,
            Math.min(1, Math.max(0, input.confidence ?? 0.6)),
            JSON.stringify([...new Set(input.citations.map((c) => `${c.source}:${c.sourceRef}`))]),
            now,
            now,
            now,
          );
      }
      for (const c of input.citations) this.#addCitation("edge", id, c, input.provenance);
    })();
    return { status: existing === undefined ? "pending" : "refreshed", edgeId: id };
  }

  // --- the owner's decisions (§7) ----------------------------------------------------------------

  #supersede(row: FactRow, replacedBy: string): void {
    const now = this.#now();
    this.#db
      .prepare(
        "UPDATE graph_facts SET superseded_by = ?, valid_to = COALESCE(valid_to, ?), updated_at = ? WHERE id = ?",
      )
      .run(replacedBy, now, now, row.id);
  }

  /**
   * Confirm, edit or discard a proposed fact. Confirming an untrusted fact keeps it `untrusted`
   * (accepted means true, not safe as instructions); an edit makes the value the owner's.
   */
  decide(
    factId: string,
    decision: "confirm" | "edit" | "discard",
    opts: {
      value?: string;
      never?: "attribute_for_entity" | "attribute_from_sender";
    } = {},
  ): GraphFact {
    const row = this.#factRow(factId);
    if (row === undefined) fail("not_found", "no such fact");
    if (row.review !== "pending") fail("conflict", "that fact is not waiting for review");
    const now = this.#now();
    const apply = (edited: { value: string } | null) => {
      const prior = isSingleValued(row.attribute)
        ? this.#current(row.entity_id, row.attribute).filter((r) => r.id !== row.id)
        : [];
      this.#db.transaction(() => {
        if (edited === null) {
          this.#db
            .prepare(
              "UPDATE graph_facts SET review = 'accepted', valid_from = ?, last_seen_at = ?, updated_at = ? WHERE id = ?",
            )
            .run(now, now, now, row.id);
        } else {
          this.#db
            .prepare(
              `UPDATE graph_facts SET value = ?, provenance = 'owner', confidence = 1, review = 'edited',
                 subject_kind = 'owner_stated', valid_from = ?, last_seen_at = ?, updated_at = ? WHERE id = ?`,
            )
            .run(edited.value, now, now, now, row.id);
          this.#feedback(row.entity_id, factKeyHash(row.attribute, row.value));
        }
        for (const p of prior) this.#supersede(p, row.id);
      })();
    };
    if (decision === "confirm") {
      apply(null);
    } else if (decision === "edit") {
      const value = clip(opts.value, VALUE_CHARS);
      if (value === null) fail("invalid_params", "an edit needs a value");
      if (blockingKinds(value, false).length > 0) {
        fail(
          "policy_denied",
          "facts cannot hold credentials, card or account numbers or government ids",
        );
      }
      if (looksLikeInstruction(value)) fail("policy_denied", "instruction-like text");
      apply({ value });
    } else {
      this.#db.transaction(() => {
        this.#db
          .prepare("UPDATE graph_facts SET review = 'discarded', updated_at = ? WHERE id = ?")
          .run(now, row.id);
        this.#feedback(row.entity_id, factKeyHash(row.attribute, row.value));
        if (opts.never !== undefined) {
          const subject =
            opts.never === "attribute_for_entity" ? row.entity_id : this.#senderOf(row.id);
          if (subject !== undefined) this.addNeverRule(opts.never, subject, row.attribute);
        }
      })();
    }
    this.#graph.touch(row.entity_id, ["facts"]);
    return toFact(this.#factRow(row.id) as FactRow);
  }

  #senderOf(factId: string): string | undefined {
    const r = this.#db
      .prepare(
        "SELECT author_entity_id FROM graph_citations WHERE target_kind = 'fact' AND target_id = ? AND author_entity_id IS NOT NULL ORDER BY created_at LIMIT 1",
      )
      .get(factId) as { author_entity_id: string } | undefined;
    return r?.author_entity_id;
  }

  #feedback(entityId: string, keyHash: string): void {
    this.#db
      .prepare(
        "INSERT INTO graph_feedback (id, kind, entity_id, other_id, key_hash, created_at) VALUES (?, 'wrong_fact', ?, NULL, ?, ?)",
      )
      .run(this.#id("fb"), entityId, keyHash, this.#now());
  }

  /** Undo an auto-accepted fact within seven days: discarded, and what it replaced comes back. */
  undo(factId: string): GraphFact {
    const row = this.#factRow(factId);
    if (row === undefined) fail("not_found", "no such fact");
    if (row.review !== "auto_accepted") fail("conflict", "only auto-accepted facts can be undone");
    if (this.#clock.now() - Date.parse(row.updated_at) > UNDO_DAYS * DAY_MS) {
      fail("conflict", "the undo window has passed");
    }
    const now = this.#now();
    this.#db.transaction(() => {
      this.#db
        .prepare("UPDATE graph_facts SET review = 'discarded', updated_at = ? WHERE id = ?")
        .run(now, row.id);
      this.#db
        .prepare(
          "UPDATE graph_facts SET superseded_by = NULL, valid_to = NULL, updated_at = ? WHERE superseded_by = ? AND retracted_at IS NULL",
        )
        .run(now, row.id);
      this.#feedback(row.entity_id, factKeyHash(row.attribute, row.value));
    })();
    this.#graph.touch(row.entity_id, ["facts"]);
    return toFact(this.#factRow(row.id) as FactRow);
  }

  /** The review queue (§7.1): pending by default, with the quote and what each would change. */
  reviewItems(
    opts: { states?: GraphReviewState[]; entityId?: string; limit?: number; offset?: number } = {},
  ): { items: ReviewItem[]; total: number } {
    const states = opts.states ?? ["pending"];
    const marks = states.map(() => "?").join(", ");
    const where = `f.review IN (${marks})${opts.entityId === undefined ? "" : " AND f.entity_id = ?"}`;
    const args: unknown[] = [...states, ...(opts.entityId === undefined ? [] : [opts.entityId])];
    const total = (
      this.#db.prepare(`SELECT count(*) AS n FROM graph_facts f WHERE ${where}`).get(...args) as {
        n: number;
      }
    ).n;
    const rows = this.#db
      .prepare(
        `SELECT f.*, e.name AS entity_name FROM graph_facts f JOIN graph_entities e ON e.id = f.entity_id
         WHERE ${where} ORDER BY e.sort_name, f.first_seen_at DESC, f.id DESC LIMIT ? OFFSET ?`,
      )
      .all(...args, Math.min(opts.limit ?? 50, 200), opts.offset ?? 0) as (FactRow & {
      entity_name: string;
    })[];
    const items = rows.map((r): ReviewItem => {
      const prior = isSingleValued(r.attribute)
        ? this.#current(r.entity_id, r.attribute).find((p) => p.id !== r.id)
        : undefined;
      const change =
        prior === undefined
          ? "new"
          : RANK[r.provenance] < RANK[prior.provenance]
            ? "conflict"
            : "changed";
      return {
        fact: toFact(r),
        entityName: safeExcerpt(r.entity_name, 200),
        citations: this.citations("fact", r.id).slice(0, 10),
        change,
        previousValue: prior === undefined ? null : prior.value,
        sentence: safeExcerpt(
          `${r.entity_name}: ${r.attribute.replace(/_/g, " ")} ${r.value}`,
          400,
        ),
      };
    });
    return { items, total };
  }

  /** What one run produced, by review state, for the "Psyche learned N things" card (counts only). */
  runSummary(runId: string): { autoAccepted: number; toReview: number; quarantined: number } {
    const n = (sql: string, ...a: unknown[]) =>
      (this.#db.prepare(sql).get(...a) as { n: number }).n;
    return {
      autoAccepted: n(
        "SELECT count(*) AS n FROM graph_facts WHERE run_id = ? AND review = 'auto_accepted'",
        runId,
      ),
      toReview: n(
        "SELECT count(*) AS n FROM graph_facts WHERE run_id = ? AND review = 'pending'",
        runId,
      ),
      quarantined: n("SELECT quarantined AS n FROM memory_runs WHERE id = ?", runId),
    };
  }

  reviewCounts(): { pending: number; autoAccepted: number; quarantined: number } {
    const n = (sql: string) => (this.#db.prepare(sql).get() as { n: number }).n;
    return {
      pending: n("SELECT count(*) AS n FROM graph_facts WHERE review = 'pending'"),
      autoAccepted: n("SELECT count(*) AS n FROM graph_facts WHERE review = 'auto_accepted'"),
      quarantined: n("SELECT count(*) AS n FROM memory_quarantine WHERE decided IS NULL"),
    };
  }

  /** Confirmed facts from one sender with no discard, for the per-sender auto-accept offer (§7.3). */
  confirmedFromSender(senderEntityId: string): number {
    const r = this.#db
      .prepare(
        `SELECT count(DISTINCT f.id) AS n FROM graph_facts f JOIN graph_citations c
           ON c.target_kind = 'fact' AND c.target_id = f.id
         WHERE c.author_entity_id = ? AND f.review IN ('accepted', 'edited')`,
      )
      .get(senderEntityId) as { n: number };
    const discarded = this.#db
      .prepare(
        `SELECT count(DISTINCT f.id) AS n FROM graph_facts f JOIN graph_citations c
           ON c.target_kind = 'fact' AND c.target_id = f.id
         WHERE c.author_entity_id = ? AND f.review = 'discarded'`,
      )
      .get(senderEntityId) as { n: number };
    return discarded.n > 0 ? 0 : r.n;
  }

  // --- quarantine (§5.6) -------------------------------------------------------------------------

  quarantine(input: {
    source: GraphCitationSource;
    sourceRef: string;
    senderEntityId?: string | null;
    reasons: QuarantineReason[];
    excerpt: string;
  }): QuarantineItem {
    if (input.reasons.length === 0) fail("invalid_params", "quarantine needs a reason");
    const now = this.#now();
    const existing = this.#db
      .prepare("SELECT * FROM memory_quarantine WHERE source = ? AND source_ref = ?")
      .get(input.source, input.sourceRef) as QuarantineRow | undefined;
    if (existing !== undefined) {
      const merged = [
        ...new Set([...(JSON.parse(existing.reasons) as string[]), ...input.reasons]),
      ];
      // A decided item that trips again is re-opened: the owner decided on older text.
      this.#db
        .prepare(
          "UPDATE memory_quarantine SET reasons = ?, decided = NULL, decided_at = NULL WHERE id = ?",
        )
        .run(JSON.stringify(merged), existing.id);
      return this.#quarantineItem(existing.id) as QuarantineItem;
    }
    const id = this.#id("qua");
    this.#db
      .prepare(
        `INSERT INTO memory_quarantine (id, source, source_ref, sender_entity_id, reasons, excerpt, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.source,
        input.sourceRef,
        input.senderEntityId ?? null,
        JSON.stringify([...new Set(input.reasons)]),
        safeExcerpt(input.excerpt, EXCERPT_CHARS),
        now,
      );
    return this.#quarantineItem(id) as QuarantineItem;
  }

  #quarantineItem(id: string): QuarantineItem | undefined {
    const r = this.#db.prepare("SELECT * FROM memory_quarantine WHERE id = ?").get(id) as
      | QuarantineRow
      | undefined;
    return r === undefined ? undefined : toQuarantine(r);
  }

  quarantined(opts: { includeDecided?: boolean; limit?: number; offset?: number } = {}): {
    items: QuarantineItem[];
    total: number;
  } {
    const where = opts.includeDecided === true ? "1 = 1" : "decided IS NULL";
    const total = (
      this.#db.prepare(`SELECT count(*) AS n FROM memory_quarantine WHERE ${where}`).get() as {
        n: number;
      }
    ).n;
    const rows = this.#db
      .prepare(
        `SELECT * FROM memory_quarantine WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
      )
      .all(Math.min(opts.limit ?? 50, 200), opts.offset ?? 0) as QuarantineRow[];
    return { items: rows.map(toQuarantine), total };
  }

  /** Release: the next pass extracts the item once (still untrusted, still pending). */
  decideQuarantine(id: string, action: "release" | "discard" | "block_sender"): QuarantineItem {
    const row = this.#db.prepare("SELECT * FROM memory_quarantine WHERE id = ?").get(id) as
      | QuarantineRow
      | undefined;
    if (row === undefined) fail("not_found", "no such quarantined item");
    const now = this.#now();
    if (action === "block_sender") {
      if (row.sender_entity_id === null) fail("invalid_params", "this item has no known sender");
      this.excludeEntity(row.sender_entity_id, "exclude");
    }
    this.#db
      .prepare("UPDATE memory_quarantine SET decided = ?, decided_at = ? WHERE id = ?")
      .run(
        action === "release" ? "released" : action === "discard" ? "discarded" : "blocked",
        now,
        id,
      );
    return this.#quarantineItem(id) as QuarantineItem;
  }

  /** The owner released this item; extract it once. */
  isReleased(source: GraphCitationSource, sourceRef: string): boolean {
    return (
      this.#db
        .prepare(
          "SELECT 1 FROM memory_quarantine WHERE source = ? AND source_ref = ? AND decided = 'released'",
        )
        .get(source, sourceRef) !== undefined
    );
  }

  // --- runs (§6.7) -------------------------------------------------------------------------------

  startRun(input: { model: string | null; sources: string[] }): string {
    const id = this.#id("run");
    this.#db
      .prepare("INSERT INTO memory_runs (id, started_at, model, sources) VALUES (?, ?, ?, ?)")
      .run(id, this.#now(), input.model, JSON.stringify(input.sources));
    return id;
  }

  finishRun(
    id: string,
    patch: Partial<{
      itemsRead: number;
      itemsFiltered: number;
      batches: number;
      tokensIn: number;
      tokensOut: number;
      factsProposed: number;
      factsDropped: Record<string, number>;
      quarantined: number;
      deferred: number;
      error: string | null;
    }>,
  ): MemoryRun {
    const cur = this.#runRow(id);
    if (cur === undefined) fail("not_found", "no such run");
    this.#db
      .prepare(
        `UPDATE memory_runs SET ended_at = ?, items_read = ?, items_filtered = ?, batches = ?, tokens_in = ?,
           tokens_out = ?, facts_proposed = ?, facts_dropped = ?, quarantined = ?, deferred = ?, error = ? WHERE id = ?`,
      )
      .run(
        this.#now(),
        patch.itemsRead ?? cur.items_read,
        patch.itemsFiltered ?? cur.items_filtered,
        patch.batches ?? cur.batches,
        patch.tokensIn ?? cur.tokens_in,
        patch.tokensOut ?? cur.tokens_out,
        patch.factsProposed ?? cur.facts_proposed,
        JSON.stringify(patch.factsDropped ?? JSON.parse(cur.facts_dropped)),
        patch.quarantined ?? cur.quarantined,
        patch.deferred ?? cur.deferred,
        patch.error === undefined ? cur.error : clip(patch.error, 500),
        id,
      );
    return toRun(this.#runRow(id) as RunRow);
  }

  #runRow(id: string): RunRow | undefined {
    return this.#db.prepare("SELECT * FROM memory_runs WHERE id = ?").get(id) as RunRow | undefined;
  }

  runs(limit = 14): MemoryRun[] {
    return (
      this.#db
        .prepare("SELECT * FROM memory_runs ORDER BY started_at DESC, id DESC LIMIT ?")
        .all(Math.min(Math.max(1, limit), 100)) as RunRow[]
    ).map(toRun);
  }

  // --- claim subjects (§4.6) ---------------------------------------------------------------------

  linkClaim(claimId: string, entityId: string): void {
    this.#db
      .prepare("INSERT OR IGNORE INTO memory_claim_subjects (claim_id, entity_id) VALUES (?, ?)")
      .run(claimId, entityId);
  }

  unlinkClaim(claimId: string, entityId: string): void {
    this.#db
      .prepare("DELETE FROM memory_claim_subjects WHERE claim_id = ? AND entity_id = ?")
      .run(claimId, entityId);
  }

  claimsAbout(entityId: string): { id: string; text: string; provenance: Provenance }[] {
    return this.#db
      .prepare(
        `SELECT c.id, c.text, c.provenance FROM memory_claim_subjects s JOIN memory_claims c ON c.id = s.claim_id
         WHERE s.entity_id = ? AND c.retracted_at IS NULL AND c.superseded_by IS NULL ORDER BY c.created_at, c.id`,
      )
      .all(entityId) as { id: string; text: string; provenance: Provenance }[];
  }

  subjectsOf(claimId: string): string[] {
    return (
      this.#db
        .prepare(
          "SELECT entity_id FROM memory_claim_subjects WHERE claim_id = ? ORDER BY entity_id",
        )
        .all(claimId) as { entity_id: string }[]
    ).map((r) => r.entity_id);
  }

  // --- retention (§10.4) -------------------------------------------------------------------------

  /** Nightly: expire pending facts, stale untrusted facts, old quarantine and run logs. */
  runRetention(policy: RetentionPolicy): RetentionResult {
    const nowMs = this.#clock.now();
    const iso = (ms: number) => new Date(ms).toISOString();
    return this.#secure(() => {
      const pending = this.#db
        .prepare("SELECT id FROM graph_facts WHERE review = 'pending' AND last_seen_at < ?")
        .all(iso(nowMs - policy.pendingDays * DAY_MS)) as { id: string }[];
      // Counted, not kept: expired proposals are deleted with their citations.
      this.#deleteFacts(pending.map((r) => r.id));

      let untrustedExpired = 0;
      if (policy.untrustedAcceptedMonths > 0) {
        const cutoff = new Date(nowMs);
        cutoff.setUTCMonth(cutoff.getUTCMonth() - policy.untrustedAcceptedMonths);
        untrustedExpired = this.#db
          .prepare(
            `UPDATE graph_facts SET valid_to = ?, updated_at = ?
             WHERE provenance = 'untrusted' AND review IN ('accepted', 'auto_accepted')
               AND retracted_at IS NULL AND valid_to IS NULL AND last_seen_at < ?`,
          )
          .run(iso(nowMs), iso(nowMs), cutoff.toISOString()).changes;
      }
      const discarded = this.#db
        .prepare("SELECT id FROM graph_facts WHERE review = 'discarded' AND updated_at < ?")
        .all(iso(nowMs - DISCARDED_KEEP_DAYS * DAY_MS)) as { id: string }[];
      this.#deleteFacts(discarded.map((r) => r.id));
      const quarantineDeleted = this.#db
        .prepare("DELETE FROM memory_quarantine WHERE created_at < ?")
        .run(iso(nowMs - policy.quarantineDays * DAY_MS)).changes;
      const runsDeleted = this.#db
        .prepare("DELETE FROM memory_runs WHERE started_at < ?")
        .run(iso(nowMs - policy.runLogDays * DAY_MS)).changes;
      return {
        pendingExpired: pending.length,
        untrustedExpired,
        discardedDeleted: discarded.length,
        quarantineDeleted,
        runsDeleted,
      };
    });
  }

  // --- export and forget (§10.3) -----------------------------------------------------------------

  /** `person.json` of the export: everything about one entity, with citations and history. */
  exportPerson(entityId: string): Record<string, unknown> {
    const entity = this.#graph.getEntity(entityId);
    if (entity === undefined) fail("not_found", "no such entity");
    const facts = (
      this.#db
        .prepare("SELECT * FROM graph_facts WHERE entity_id = ? ORDER BY recorded_at, id")
        .all(entityId) as FactRow[]
    ).map((r) => ({ ...toFact(r), citations: this.citations("fact", r.id) }));
    const edges = this.#db
      .prepare("SELECT * FROM graph_edges WHERE src = ? OR dst = ? ORDER BY created_at, id")
      .all(entityId, entityId) as { id: string }[];
    const loops = this.#db
      .prepare("SELECT * FROM graph_loops WHERE counterpart_id = ? ORDER BY created_at, id")
      .all(entityId);
    const interactions = this.#db
      .prepare(
        `SELECT i.id, i.kind, i.source, i.occurred_at, i.direction, i.subject, i.link, p.role
         FROM graph_participants p JOIN graph_interactions i ON i.id = p.interaction_id
         WHERE p.entity_id = ? ORDER BY i.occurred_at, i.id`,
      )
      .all(entityId);
    return {
      exportedAt: this.#now(),
      entity,
      identifiers: this.#graph.identifiers(entityId),
      facts,
      edges: edges.map((e) => ({ ...e, citations: this.citations("edge", e.id) })),
      citations: this.citations("entity", entityId),
      loops,
      interactions,
      claims: this.claimsAbout(entityId),
      quarantine: (
        this.#db
          .prepare("SELECT * FROM memory_quarantine WHERE sender_entity_id = ? ORDER BY created_at")
          .all(entityId) as QuarantineRow[]
      ).map(toQuarantine),
    };
  }

  /**
   * "Forget what they said" (keep the person): every fact and relation whose only citations are
   * that sender's items is deleted, wherever it points; shared ones lose just their citations;
   * their quarantined items go (§10.3).
   */
  forgetWhatTheySaid(
    entityId: string,
    dryRun = false,
  ): { facts: number; edges: number; citations: number; quarantine: number; dryRun: boolean } {
    if (this.#graph.getEntity(entityId) === undefined) fail("not_found", "no such entity");
    const theirs = this.#db
      .prepare(
        "SELECT target_kind, target_id, count(*) AS n FROM graph_citations WHERE author_entity_id = ? GROUP BY target_kind, target_id",
      )
      .all(entityId) as { target_kind: GraphCitationTarget; target_id: string; n: number }[];
    const total = this.#db.prepare(
      "SELECT count(*) AS n FROM graph_citations WHERE target_kind = ? AND target_id = ?",
    );
    const factIds: string[] = [];
    const edgeIds: string[] = [];
    for (const t of theirs) {
      const all = (total.get(t.target_kind, t.target_id) as { n: number }).n;
      if (all !== t.n) continue;
      if (t.target_kind === "fact") {
        const row = this.#factRow(t.target_id);
        // An owner-edited fact is the owner's now; their quote no longer carries it.
        if (row !== undefined && row.provenance !== "owner") factIds.push(row.id);
      } else if (t.target_kind === "edge") {
        edgeIds.push(t.target_id);
      }
    }
    const citations = (
      this.#db
        .prepare("SELECT count(*) AS n FROM graph_citations WHERE author_entity_id = ?")
        .get(entityId) as { n: number }
    ).n;
    const quarantine = (
      this.#db
        .prepare("SELECT count(*) AS n FROM memory_quarantine WHERE sender_entity_id = ?")
        .get(entityId) as { n: number }
    ).n;
    const result = { facts: factIds.length, edges: edgeIds.length, citations, quarantine, dryRun };
    if (dryRun) return result;
    const touched = new Set<string>();
    this.#secure(() => {
      for (const id of factIds) {
        const r = this.#factRow(id);
        if (r !== undefined) touched.add(r.entity_id);
      }
      this.#deleteFacts(factIds);
      for (const id of edgeIds) {
        const e = this.#db.prepare("SELECT src, dst FROM graph_edges WHERE id = ?").get(id) as
          | { src: string; dst: string }
          | undefined;
        if (e !== undefined) {
          touched.add(e.src);
          touched.add(e.dst);
        }
        this.#db.prepare("DELETE FROM graph_edges WHERE id = ?").run(id);
      }
      this.#db.prepare("DELETE FROM graph_citations WHERE author_entity_id = ?").run(entityId);
      this.#db.prepare("DELETE FROM memory_quarantine WHERE sender_entity_id = ?").run(entityId);
    });
    for (const id of touched) this.#graph.touch(id, ["facts"]);
    return result;
  }

  #secure<T>(fn: () => T): T {
    const before = this.#db.pragma("secure_delete", { simple: true });
    this.#db.pragma("secure_delete = ON");
    try {
      const out = this.#db.transaction(fn)();
      if (this.#db.name !== ":memory:") this.#db.pragma("wal_checkpoint(TRUNCATE)");
      return out;
    } finally {
      this.#db.pragma(`secure_delete = ${before === 1 ? "ON" : "OFF"}`);
    }
  }
}

interface QuarantineRow {
  id: string;
  source: GraphCitationSource;
  source_ref: string;
  sender_entity_id: string | null;
  reasons: string;
  excerpt: string;
  created_at: string;
  decided: "released" | "discarded" | "blocked" | null;
  decided_at: string | null;
}

function toQuarantine(r: QuarantineRow): QuarantineItem {
  return {
    id: r.id,
    source: r.source,
    sourceRef: r.source_ref,
    senderEntityId: r.sender_entity_id,
    reasons: JSON.parse(r.reasons) as QuarantineReason[],
    excerpt: r.excerpt,
    createdAt: r.created_at,
    decided: r.decided,
    decidedAt: r.decided_at,
  };
}

interface RunRow {
  id: string;
  started_at: string;
  ended_at: string | null;
  model: string | null;
  sources: string;
  items_read: number;
  items_filtered: number;
  batches: number;
  tokens_in: number;
  tokens_out: number;
  facts_proposed: number;
  facts_dropped: string;
  quarantined: number;
  deferred: number;
  error: string | null;
}

function toRun(r: RunRow): MemoryRun {
  return {
    id: r.id,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    model: r.model,
    sources: JSON.parse(r.sources) as MemoryRun["sources"],
    itemsRead: r.items_read,
    itemsFiltered: r.items_filtered,
    batches: r.batches,
    tokensIn: r.tokens_in,
    tokensOut: r.tokens_out,
    factsProposed: r.facts_proposed,
    factsDropped: JSON.parse(r.facts_dropped) as Record<string, number>,
    quarantined: r.quarantined,
    deferred: r.deferred,
    error: r.error,
  };
}
