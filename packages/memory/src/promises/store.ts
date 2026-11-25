/**
 * The promise ledger over `graph_loops` (design sections 3.4, 4, 7.1, 8). `GraphStore` owns the
 * row writes and the `memory.loop.updated` event; this class owns the rules: what opens a
 * promise, how two mentions merge, the state machine, the hourly sweep, history, citations,
 * retention and hard delete. It works the same on the plain and the encrypted store: both are a
 * better-sqlite3 connection with the same schema.
 */

import { holdSecureDelete } from "@psyche/db";
import { type Clock, type Provenance, PsycheError } from "@psyche/protocol";
import type Database from "better-sqlite3";
import { monotonicFactory } from "ulid";
import { normalizeName, sha256 } from "../graph/normalize.ts";
import type {
  GraphStore,
  LoopAction,
  LoopDueKind,
  LoopPatch,
  LoopSourceKind,
} from "../graph/store.ts";
import { fuzzyVerdict } from "./dedupe.ts";
import { DAY_MS, parseMs } from "./due.ts";
import {
  computeState,
  decide,
  type EventBy,
  type EventKind,
  type LastAsk,
  type LedgerLoop,
  nudgeEligible,
  type PromiseActionInput,
  type PromiseState,
  planSweep,
} from "./lifecycle.ts";
import {
  computeThresholds,
  needsAlwaysConfirm,
  PROMISE_SOURCES,
  type PromiseFeedback,
  type PromiseSource,
  STORE_MIN_CONFIDENCE,
} from "./thresholds.ts";

export type PromiseRow = LedgerLoop & { state: PromiseState };
export type PromiseView = "yours" | "theirs" | "confirm" | "closed" | "all";

export interface PromiseEvent {
  id: string;
  loopId: string;
  at: string;
  kind: EventKind;
  from: string | null;
  to: string | null;
  by: EventBy;
  citationId: string | null;
}

export interface PromiseCitationInput {
  source:
    | "mail"
    | "messages"
    | "notes"
    | "calendar"
    | "reminders"
    | "chats"
    | "files"
    | "browser"
    | "transcripts"
    | "contacts";
  sourceRef: string;
  quote: string;
  start?: number;
  end?: number;
  docId?: string | null;
  sourceHash?: string;
  authorEntityId?: string | null;
  provenance: Provenance;
  observedAt?: string;
}

export interface PromiseInput {
  direction: "i_owe" | "waiting_on";
  /** What was promised: at most 120 characters are kept in the list. */
  what: string;
  counterpartId?: string | null;
  counterpartLabel?: string | null;
  projectId?: string | null;
  dueAt?: string | null;
  dueText?: string | null;
  dueKind?: LoopDueKind;
  dueConfidence?: number | null;
  whatAction?: LoopAction | null;
  provenance: Provenance;
  confidence: number;
  detectedBy: "rule" | "model" | "owner";
  sourceKind: LoopSourceKind;
  sourceInteractionId?: string | null;
  threadKey?: string | null;
  evidence?: string | null;
  citation?: PromiseCitationInput;
}

export type AddResult =
  | { kind: "created"; promise: PromiseRow; sameAsCandidate?: string }
  | { kind: "merged"; promise: PromiseRow }
  | { kind: "rejected"; reason: "low_confidence" | "not_a_promise" | "filtered" | "dismissed" };

export interface SweepResult {
  woke: string[];
  broken: string[];
  warned: string[];
  stillOn: string[];
  agedOut: string[];
  nudgeEligible: string[];
}

export interface PromiseStoreOptions {
  graph: GraphStore;
  sqlite: Database.Database;
  clock?: Clock;
  /** IANA zone for "the working day before" and "the next 06:00". */
  timezone?: string;
  /** `promises.graceDays`: working days past due before theirs are late. */
  graceDays?: number;
  newId?: () => string;
}

/** The follow-up item the Daily habit brief kept in settings (`daily.followups.items`). */
export interface LegacyFollowup {
  id: string;
  text: string;
  source: "sent_mail" | "message" | "chat" | "awaiting_reply" | "manual";
  sourceLink?: string;
  status: "open" | "snoozed" | "done" | "dismissed";
  dueAt?: string;
  snoozedUntil?: string;
  createdAt: string;
}

const LEGACY_SOURCE: Record<Exclude<LegacyFollowup["source"], "awaiting_reply">, LoopSourceKind> = {
  sent_mail: "mail",
  message: "messages",
  chat: "chat",
  manual: "manual",
};

export const RETENTION_DEFAULTS = { pendingDays: 30, retentionDays: 180, quoteDays: 30 } as const;
export interface PromiseRetention {
  pendingDays?: number;
  retentionDays?: number;
  quoteDays?: number;
}
export interface PromiseRetentionResult {
  suggestedExpired: number;
  closedDeleted: number;
  quotesCleared: number;
}

const LIST_LIMIT = 500;
const iso = (ms: number) => new Date(ms).toISOString();
const bad = (m: string): never => {
  throw new PsycheError("invalid_params", m);
};

interface FeedbackRow {
  kind: "not_promise" | "confirmed_promise";
  entity_id: string | null;
  other_id: string | null;
  created_at: string;
}

/** Deletes promise rows (events, citations, loop) with `secure_delete` on, then checkpoints. */
function secureDeleteLoops(db: Database.Database, ids: readonly string[]): void {
  if (ids.length === 0) return;
  const release = holdSecureDelete(db);
  try {
    db.transaction(() => {
      const del = (sql: string, id: string) => db.prepare(sql).run(id);
      for (const id of ids) {
        del("DELETE FROM graph_loop_events WHERE loop_id = ?", id);
        del("DELETE FROM graph_citations WHERE target_kind = 'loop' AND target_id = ?", id);
        del("DELETE FROM graph_loops WHERE id = ?", id);
      }
    })();
    // A checkpoint cannot run inside a transaction: the caller (`runRetention`) does it on commit.
    if (db.name !== ":memory:" && !db.inTransaction) db.pragma("wal_checkpoint(TRUNCATE)");
  } finally {
    release();
  }
}

/**
 * Nightly retention for promises (design 7.1): suggested ones expire after `pendingDays`, closed
 * ones are deleted `retentionDays` after closing and their citation quotes are cleared after
 * `quoteDays`. Open and broken rows stay until resolved. Only ledger promises (`basis`
 * `promise`) are touched; asks and requests keep the older rules.
 */
export function retainPromises(
  db: Database.Database,
  nowMs: number,
  options: PromiseRetention = {},
): PromiseRetentionResult {
  const pendingDays = options.pendingDays ?? RETENTION_DEFAULTS.pendingDays;
  const retentionDays = options.retentionDays ?? RETENTION_DEFAULTS.retentionDays;
  const quoteDays = options.quoteDays ?? RETENTION_DEFAULTS.quoteDays;
  const ids = (sql: string, cutoff: number) =>
    (db.prepare(sql).all(iso(cutoff)) as { id: string }[]).map((r) => r.id);
  const expired = ids(
    "SELECT id FROM graph_loops WHERE basis = 'promise' AND status = 'suggested' AND created_at < ?",
    nowMs - pendingDays * DAY_MS,
  );
  const old = ids(
    `SELECT id FROM graph_loops WHERE basis = 'promise' AND status IN ('done', 'released', 'dismissed')
       AND COALESCE(closed_at, updated_at) < ?`,
    nowMs - retentionDays * DAY_MS,
  );
  secureDeleteLoops(db, [...new Set([...expired, ...old])]);
  const release = holdSecureDelete(db);
  let quotesCleared = 0;
  try {
    // Overwriting a quote leaves the old bytes in a freed page unless secure_delete is on.
    quotesCleared = db
      .prepare(
        `UPDATE graph_citations SET quote = '' WHERE target_kind = 'loop' AND quote != ''
           AND target_id IN (SELECT id FROM graph_loops WHERE basis = 'promise'
             AND status IN ('done', 'released', 'dismissed') AND COALESCE(closed_at, updated_at) < ?)`,
      )
      .run(iso(nowMs - quoteDays * DAY_MS)).changes;
  } finally {
    release();
  }
  return { suggestedExpired: expired.length, closedDeleted: old.length, quotesCleared };
}

export class PromiseStore {
  readonly #graph: GraphStore;
  readonly #db: Database.Database;
  readonly #clock: Clock;
  readonly #tz: string;
  readonly #graceDays: number;
  readonly #newId: () => string;

  constructor(options: PromiseStoreOptions) {
    this.#graph = options.graph;
    this.#db = options.sqlite;
    this.#clock = options.clock ?? { now: () => Date.now() };
    this.#tz = options.timezone ?? "UTC";
    this.#graceDays = options.graceDays ?? 1;
    const ulid = monotonicFactory();
    this.#newId = options.newId ?? (() => ulid());
  }

  #now(): number {
    return this.#clock.now();
  }

  // --- reads -----------------------------------------------------------------------------------

  #row(loop: LedgerLoop): PromiseRow {
    return { ...loop, state: computeState(loop, this.#now(), this.#tz) };
  }

  get(id: string): PromiseRow | undefined {
    const loop = this.#graph.getLoopLedger(id);
    return loop === undefined ? undefined : this.#row(loop);
  }

  #must(id: string): LedgerLoop {
    const loop = this.#graph.getLoopLedger(id);
    if (loop === undefined) throw new PsycheError("not_found", "no such promise");
    return loop;
  }

  list(
    view: PromiseView = "all",
    filter: { entityId?: string; dueBefore?: string; limit?: number } = {},
  ): PromiseRow[] {
    const clauses = ["basis = 'promise'"];
    const params: unknown[] = [];
    if (view === "yours") clauses.push("direction = 'i_owe'");
    if (view === "theirs") clauses.push("direction = 'waiting_on'");
    if (view === "yours" || view === "theirs")
      clauses.push("status IN ('open', 'snoozed', 'broken')");
    if (view === "confirm") clauses.push("status = 'suggested' AND confidence >= 0.7");
    if (view === "closed") clauses.push("status IN ('done', 'released', 'dismissed')");
    if (filter.entityId !== undefined) {
      clauses.push("counterpart_id = ?");
      params.push(filter.entityId);
    }
    if (filter.dueBefore !== undefined) {
      clauses.push("due_at IS NOT NULL AND due_at < ?");
      params.push(filter.dueBefore);
    }
    const limit = Math.min(Math.max(1, filter.limit ?? 100), LIST_LIMIT);
    const ids = (
      this.#db
        .prepare(
          `SELECT id FROM graph_loops WHERE ${clauses.join(" AND ")} ORDER BY created_at, id LIMIT ?`,
        )
        .all(...params, limit) as { id: string }[]
    ).map((r) => r.id);
    const out: PromiseRow[] = [];
    for (const id of ids) {
      const p = this.get(id);
      if (p !== undefined) out.push(p);
    }
    return out;
  }

  events(loopId: string): PromiseEvent[] {
    return (
      this.#db
        .prepare("SELECT * FROM graph_loop_events WHERE loop_id = ? ORDER BY at, id")
        .all(loopId) as {
        id: string;
        loop_id: string;
        at: string;
        kind: EventKind;
        from_value: string | null;
        to_value: string | null;
        by: EventBy;
        citation_id: string | null;
      }[]
    ).map((r) => ({
      id: r.id,
      loopId: r.loop_id,
      at: r.at,
      kind: r.kind,
      from: r.from_value,
      to: r.to_value,
      by: r.by,
      citationId: r.citation_id,
    }));
  }

  citations(loopId: string): { id: string; source: string; sourceRef: string; quote: string }[] {
    return (
      this.#db
        .prepare(
          "SELECT id, source, source_ref, quote FROM graph_citations WHERE target_kind = 'loop' AND target_id = ? ORDER BY observed_at, id",
        )
        .all(loopId) as { id: string; source: string; source_ref: string; quote: string }[]
    ).map((r) => ({ id: r.id, source: r.source, sourceRef: r.source_ref, quote: r.quote }));
  }

  // --- history and citations -------------------------------------------------------------------

  #event(
    loopId: string,
    kind: EventKind,
    from: string | null,
    to: string | null,
    by: EventBy,
    citationId: string | null = null,
  ): void {
    this.#db
      .prepare(
        "INSERT INTO graph_loop_events (id, loop_id, at, kind, from_value, to_value, by, citation_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(`lev_${this.#newId()}`, loopId, iso(this.#now()), kind, from, to, by, citationId);
  }

  /** One citation per source mention. The same mention again returns the id it already has. */
  addCitation(loopId: string, c: PromiseCitationInput): string {
    const quote = c.quote.replace(/\s+/g, " ").trim().slice(0, 200);
    const hash = c.sourceHash ?? sha256(`${c.sourceRef}\n${quote}`);
    const prior = this.#db
      .prepare(
        "SELECT id FROM graph_citations WHERE target_kind = 'loop' AND target_id = ? AND source = ? AND source_ref = ? AND source_hash = ?",
      )
      .get(loopId, c.source, c.sourceRef, hash) as { id: string } | undefined;
    if (prior !== undefined) return prior.id;
    const id = `cit_${this.#newId()}`;
    const start = Math.max(0, c.start ?? 0);
    const now = iso(this.#now());
    this.#db
      .prepare(
        `INSERT INTO graph_citations (id, target_kind, target_id, source, doc_id, source_ref, quote, start, "end",
           source_hash, author_entity_id, provenance, observed_at, created_at)
         VALUES (?, 'loop', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        loopId,
        c.source,
        c.docId ?? null,
        c.sourceRef,
        quote,
        start,
        Math.max(start, c.end ?? start + quote.length),
        hash,
        c.authorEntityId ?? null,
        c.provenance,
        c.observedAt ?? now,
        now,
      );
    return id;
  }

  // --- feedback and thresholds -----------------------------------------------------------------

  #feedbackRows(): PromiseFeedback[] {
    const since = iso(this.#now() - 90 * DAY_MS);
    const rows = this.#db
      .prepare(
        `SELECT kind, entity_id, other_id, created_at FROM graph_feedback
           WHERE kind IN ('not_promise', 'confirmed_promise') AND created_at >= ? AND other_id IS NOT NULL`,
      )
      .all(since) as FeedbackRow[];
    return rows.map((r) => ({
      kind: r.kind,
      source: PROMISE_SOURCES.includes(r.other_id as PromiseSource)
        ? (r.other_id as PromiseSource)
        : null,
      at: Date.parse(r.created_at),
      entityId: r.entity_id,
    }));
  }

  /** `threshold[source]`, recomputed from the last 90 days of feedback (no stored state). */
  thresholds(): Record<PromiseSource, number> {
    return computeThresholds(this.#feedbackRows(), this.#now());
  }

  #writeFeedback(kind: "not_promise" | "confirmed_promise", loop: LedgerLoop): void {
    // The source rides in `other_id` so the thresholds can group by it; no text is stored.
    this.#db
      .prepare(
        "INSERT INTO graph_feedback (id, kind, entity_id, other_id, key_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        `fb_${this.#newId()}`,
        kind,
        loop.counterpartId,
        loop.sourceKind ?? "manual",
        loop.dedupeKey,
        iso(this.#now()),
      );
  }

  #suppressed(dedupeKey: string): boolean {
    return (
      this.#db
        .prepare("SELECT 1 FROM graph_feedback WHERE kind = 'not_promise' AND key_hash = ? LIMIT 1")
        .get(dedupeKey) !== undefined
    );
  }

  // --- add and dedupe --------------------------------------------------------------------------

  /**
   * Adds a promise from any source. Below 0.6 it is not stored. Other people's promises, and
   * anything not in the owner's own words, start as `suggested` (To confirm). The owner's own
   * promise opens only at the source's threshold. A new mention of one already tracked adds a
   * citation instead of a row.
   */
  add(input: PromiseInput): AddResult {
    const manual = input.detectedBy === "owner";
    if (!manual && input.confidence < STORE_MIN_CONFIDENCE)
      return { kind: "rejected", reason: "low_confidence" };
    const text = input.what.replace(/\s+/g, " ").trim();
    const counterpart =
      input.counterpartId === undefined || input.counterpartId === null
        ? null
        : this.#graph.resolveMerged(input.counterpartId);
    const feedback = this.#feedbackRows();
    const threshold = computeThresholds(feedback, this.#now())[input.sourceKind];
    const opensItself =
      manual ||
      (input.direction === "i_owe" &&
        input.provenance === "owner" &&
        input.confidence >= threshold &&
        !(counterpart !== null && needsAlwaysConfirm(feedback, counterpart, this.#now())));

    // Rule 3 (fuzzy) first, so a near-duplicate never gets its own row.
    let sameAsCandidate: string | undefined;
    if (counterpart !== null) {
      const candidates = this.#db
        .prepare(
          `SELECT id FROM graph_loops WHERE basis = 'promise' AND counterpart_id = ? AND direction = ?
             AND status IN ('suggested', 'open', 'snoozed', 'broken') ORDER BY created_at, id`,
        )
        .all(counterpart, input.direction) as { id: string }[];
      for (const { id } of candidates) {
        const existing = this.#graph.getLoopLedger(id);
        if (existing === undefined) continue;
        const verdict = fuzzyVerdict(
          {
            direction: input.direction,
            counterpartId: counterpart,
            text,
            dueAt: input.dueAt ?? null,
            createdAtMs: this.#now(),
          },
          {
            direction: existing.direction,
            counterpartId: existing.counterpartId ?? null,
            text: existing.text,
            dueAt: existing.dueAt ?? null,
            createdAtMs: parseMs(existing.createdAt) ?? this.#now(),
          },
        );
        if (verdict === "merge") return { kind: "merged", promise: this.#mention(existing, input) };
        if (verdict === "ask" && sameAsCandidate === undefined) sameAsCandidate = id;
      }
    }

    const key = sha256(
      `${input.direction}\n${counterpart ?? ""}\n${normalizeName(text.slice(0, 200))}`,
    );
    // The owner deleted or rejected this exact promise before: it is not extracted again.
    if (this.#suppressed(key)) return { kind: "rejected", reason: "not_a_promise" };
    const created = this.#graph.addLoop({
      direction: input.direction,
      text,
      evidence: input.evidence ?? null,
      counterpartId: counterpart,
      projectId: input.projectId ?? null,
      dueAt: input.dueAt ?? null,
      status: opensItself ? "open" : "suggested",
      sourceInteractionId: input.sourceInteractionId ?? null,
      provenance: input.provenance,
      confidence: input.confidence,
      detectedBy: input.detectedBy,
      basis: "promise",
      whatAction: input.whatAction ?? null,
      dueText: input.dueText ?? null,
      ...(input.dueKind === undefined ? {} : { dueKind: input.dueKind }),
      ...(input.dueConfidence === undefined ? {} : { dueConfidence: input.dueConfidence }),
      threadKey: input.threadKey ?? null,
      sourceKind: input.sourceKind,
      counterpartLabel: input.counterpartLabel ?? null,
    });
    if (created === undefined) return this.#exactOrRejected(input, counterpart, text);
    const row = this.#must(created.id);
    const citationId =
      input.citation === undefined ? null : this.addCitation(row.id, input.citation);
    this.#event(row.id, "created", null, row.status, input.detectedBy, citationId);
    if (sameAsCandidate !== undefined)
      this.#event(row.id, "asked", null, `same_as:${sameAsCandidate}`, "rule");
    return {
      kind: "created",
      promise: this.#row(this.#must(row.id)),
      ...(sameAsCandidate === undefined ? {} : { sameAsCandidate }),
    };
  }

  /** `addLoop` found the exact promise already there (or filtered the text). */
  #exactOrRejected(input: PromiseInput, counterpart: string | null, text: string): AddResult {
    const key = sha256(
      `${input.direction}\n${counterpart ?? ""}\n${normalizeName(text.slice(0, 200))}`,
    );
    const prior = this.#db
      .prepare(
        "SELECT id, status FROM graph_loops WHERE dedupe_key = ? ORDER BY created_at DESC LIMIT 1",
      )
      .get(key) as { id: string; status: string } | undefined;
    if (prior === undefined) return { kind: "rejected", reason: "filtered" };
    if (prior.status === "dismissed" || this.#suppressed(key))
      return { kind: "rejected", reason: "dismissed" };
    const existing = this.#must(prior.id);
    if (existing.basis !== "promise") return { kind: "rejected", reason: "filtered" };
    return { kind: "merged", promise: this.#mention(existing, input) };
  }

  /** A new mention of a tracked promise: a citation, and the more explicit due date. */
  #mention(existing: LedgerLoop, input: PromiseInput): PromiseRow {
    const citationId =
      input.citation === undefined ? null : this.addCitation(existing.id, input.citation);
    this.#event(existing.id, "source_added", null, input.sourceKind, input.detectedBy, citationId);
    const patch: LoopPatch = {};
    if (input.dueAt !== undefined && input.dueAt !== null && existing.dueAt !== input.dueAt) {
      const incoming = {
        kind: input.dueKind ?? "explicit",
        conf: input.dueConfidence ?? 0.8,
      };
      const rank = (k: string) => (k === "explicit" ? 2 : k === "inferred" ? 1 : 0);
      const current = { kind: existing.dueKind, conf: existing.dueConfidence ?? 0 };
      const better =
        existing.dueAt === null ||
        rank(incoming.kind) > rank(current.kind) ||
        (rank(incoming.kind) === rank(current.kind) && incoming.conf > current.conf);
      if (better) {
        Object.assign(patch, {
          dueAt: input.dueAt,
          dueKind: incoming.kind,
          dueConfidence: incoming.conf,
          dueText: input.dueText ?? null,
          warnedAt: null,
        });
        this.#event(
          existing.id,
          "due_changed",
          existing.dueAt ?? null,
          input.dueAt,
          input.detectedBy,
          citationId,
        );
      }
    }
    return this.#row(this.#graph.patchLoop(existing.id, patch));
  }

  /** Fuzzy "maybe the same" pairs waiting for the next model batch: `[newLoopId, existingLoopId]`. */
  pendingSameAs(): [string, string][] {
    const rows = this.#db
      .prepare(
        `SELECT e.loop_id AS id, e.to_value AS v FROM graph_loop_events e JOIN graph_loops l ON l.id = e.loop_id
           WHERE e.kind = 'asked' AND e.to_value LIKE 'same_as:%' AND l.status IN ('suggested', 'open', 'snoozed', 'broken')
             AND NOT EXISTS (SELECT 1 FROM graph_loop_events r WHERE r.loop_id = e.loop_id AND r.kind = 'asked' AND r.to_value = 'same_as_resolved')
           ORDER BY e.at, e.id`,
      )
      .all() as { id: string; v: string }[];
    return rows.map((r) => [r.id, r.v.slice("same_as:".length)]);
  }

  resolveSameAs(loopId: string): void {
    this.#event(loopId, "asked", null, "same_as_resolved", "model");
  }

  // --- renegotiation ---------------------------------------------------------------------------

  /**
   * Agreed (design 4.3): both sides' words are in the thread, so the due date updates and a
   * broken promise reopens. History keeps both citations.
   */
  renegotiateAgreed(
    id: string,
    input: { newDueAt: string; citations?: PromiseCitationInput[]; by?: EventBy },
  ): PromiseRow {
    const loop = this.#must(id);
    if (!["suggested", "open", "snoozed", "broken"].includes(loop.status))
      return bad("this promise is closed");
    const due = Date.parse(input.newDueAt);
    if (Number.isNaN(due)) return bad("not a date");
    const ids = (input.citations ?? []).map((c) => this.addCitation(id, c));
    const patch: LoopPatch = {
      dueAt: iso(due),
      dueKind: "explicit",
      dueConfidence: 1,
      dueText: null,
      proposedDueAt: null,
      warnedAt: null,
      brokenAt: null,
      ...(loop.status === "broken" ? { status: "open" as const } : {}),
    };
    const next = this.#graph.patchLoop(id, patch);
    this.#event(
      id,
      "due_changed",
      loop.dueAt ?? null,
      iso(due),
      input.by ?? "model",
      ids[0] ?? null,
    );
    for (const extra of ids.slice(1))
      this.#event(id, "source_added", null, "renegotiation", input.by ?? "model", extra);
    if (loop.status === "broken") this.#event(id, "status", "broken", "open", input.by ?? "model");
    return this.#row(next);
  }

  /**
   * Proposed only: the date is stored in `proposed_due_at` and the due date stands. Who proposed
   * is implied by the direction: theirs are moved by them, yours by you.
   */
  renegotiateProposed(
    id: string,
    input: { proposedDueAt: string; citation?: PromiseCitationInput; by?: EventBy },
  ): PromiseRow {
    const loop = this.#must(id);
    if (!["open", "snoozed", "broken", "suggested"].includes(loop.status))
      return bad("this promise is closed");
    const due = Date.parse(input.proposedDueAt);
    if (Number.isNaN(due)) return bad("not a date");
    const citationId = input.citation === undefined ? null : this.addCitation(id, input.citation);
    const next = this.#graph.patchLoop(id, { proposedDueAt: iso(due) });
    this.#event(id, "due_proposed", loop.proposedDueAt, iso(due), input.by ?? "model", citationId);
    return this.#row(next);
  }

  // --- actions ---------------------------------------------------------------------------------

  #lastAsk(loopId: string): LastAsk | undefined {
    // An ask is asked(null -> "done" | "still_on"). An answer is asked(question -> "not_yet") or,
    // for "Still on?", a confirmed(-> "still_on") event.
    let last: LastAsk | undefined;
    for (const e of this.events(loopId)) {
      const at = Date.parse(e.at);
      if (e.kind === "asked" && (e.to === "done" || e.to === "still_on")) {
        last = { question: e.to, at };
      } else if (last !== undefined && e.kind === "asked" && e.to === "not_yet") {
        last = { ...last, answered: "not_yet" };
      } else if (last !== undefined && e.kind === "confirmed" && e.to === "still_on") {
        last = { ...last, answered: "yes" };
      }
    }
    return last;
  }

  /** Records a question to the owner ("Did Sam send it?", "Still on?"). */
  recordAsk(id: string, question: "done" | "still_on"): void {
    this.#must(id);
    this.#event(id, "asked", null, question, "auto");
  }

  /** Whether a `done` question about this promise is held back by a recent "Not yet". */
  askSuppressed(id: string): boolean {
    const ask = this.#lastAsk(id);
    return ask !== undefined && ask.answered === "not_yet" && this.#now() - ask.at < 3 * DAY_MS;
  }

  /** Whether a `done` question was asked and not answered yet (no second card for it). */
  doneAskOpen(id: string): boolean {
    const ask = this.#lastAsk(id);
    return ask !== undefined && ask.question === "done" && ask.answered === undefined;
  }

  /** When the promise was first cited: done signals only count what came after it. */
  firstCitationAt(id: string): number | undefined {
    const row = this.#db
      .prepare(
        "SELECT MIN(observed_at) AS at FROM graph_citations WHERE target_kind = 'loop' AND target_id = ?",
      )
      .get(id) as { at: string | null } | undefined;
    const at = row?.at === null || row?.at === undefined ? undefined : Date.parse(row.at);
    if (at !== undefined && !Number.isNaN(at)) return at;
    return parseMs(this.#must(id).createdAt) ?? undefined;
  }

  /** When an automatic done was last undone, if ever: the signal that closed it must not re-fire. */
  lastUndoAt(id: string): number | undefined {
    let last: number | undefined;
    // An undo, or any reopen of a closed promise (a `reply_seen` done reopens as a plain status).
    for (const e of this.events(id)) {
      const reopened = e.kind === "status" && e.to === "open" && e.from === "done";
      if (e.kind === "undo" || reopened) last = Date.parse(e.at);
    }
    return last;
  }

  act(
    id: string,
    input: PromiseActionInput,
    opts: { citation?: PromiseCitationInput } = {},
  ): PromiseRow {
    // One transaction: a citation without its status change (or the reverse) is never left behind.
    return this.#db.transaction(() => {
      const loop = this.#must(id);
      const lastAsk = this.#lastAsk(id);
      const decision = decide(loop, input, {
        nowMs: this.#now(),
        ...(lastAsk === undefined ? {} : { lastAsk }),
      });
      const citationId = opts.citation === undefined ? null : this.addCitation(id, opts.citation);
      const next = this.#graph.patchLoop(id, decision.patch);
      if (decision.event !== null)
        this.#event(
          id,
          decision.event.kind,
          decision.event.from,
          decision.event.to,
          decision.event.by,
          citationId,
        );
      if (decision.feedback !== undefined) this.#writeFeedback(decision.feedback, loop);
      return this.#row(next);
    })();
  }

  // --- sweep -----------------------------------------------------------------------------------

  #activityAt(loop: LedgerLoop): { activity: number; openSince: number; stillOnAsked?: number } {
    const created = parseMs(loop.createdAt) ?? 0;
    let activity = created;
    let openSince = created;
    let stillOnAsked: number | undefined;
    for (const e of this.events(loop.id)) {
      const at = Date.parse(e.at);
      if (e.kind === "confirmed") {
        if (e.to === "open") openSince = Math.max(openSince, at);
        activity = Math.max(activity, at);
      } else if (e.kind === "asked") {
        if (e.to === "still_on") stillOnAsked = at;
      } else if (e.kind === "warned" || e.kind === "nudge_drafted") {
        // bookkeeping, not a sign of life
      } else if (e.kind === "status" && e.by === "auto") {
        // the sweep's own writes
      } else {
        activity = Math.max(activity, at);
      }
    }
    return { activity, openSince, ...(stillOnAsked === undefined ? {} : { stillOnAsked }) };
  }

  /** The hourly job: no model, idempotent, safe to run twice in a row. */
  sweep(): SweepResult {
    const out: SweepResult = {
      woke: [],
      broken: [],
      warned: [],
      stillOn: [],
      agedOut: [],
      nudgeEligible: [],
    };
    const nowMs = this.#now();
    const ids = (
      this.#db
        .prepare(
          "SELECT id FROM graph_loops WHERE basis = 'promise' AND status IN ('open', 'snoozed', 'broken') ORDER BY created_at, id",
        )
        .all() as { id: string }[]
    ).map((r) => r.id);
    for (const id of ids) {
      let loop = this.#must(id);
      if (loop.status !== "broken") {
        const a = this.#activityAt(loop);
        const steps = planSweep(loop, {
          nowMs,
          tz: this.#tz,
          graceDays: this.#graceDays,
          activityAtMs: a.activity,
          openSinceMs: a.openSince,
          ...(a.stillOnAsked === undefined ? {} : { stillOnAskedAtMs: a.stillOnAsked }),
        });
        for (const step of steps) {
          switch (step.kind) {
            case "wake":
              loop = this.#graph.patchLoop(id, { status: "open", snoozedUntil: null });
              this.#event(id, "status", "snoozed", "open", "auto");
              out.woke.push(id);
              break;
            case "break":
              loop = this.#graph.patchLoop(id, { status: "broken", brokenAt: step.brokenAt });
              this.#event(id, "status", "open", "broken", "auto");
              out.broken.push(id);
              break;
            case "warn":
              loop = this.#graph.patchLoop(id, { warnedAt: iso(nowMs) });
              this.#event(id, "warned", null, step.dueAt, "auto");
              out.warned.push(id);
              break;
            case "still_on":
              this.#event(id, "asked", null, "still_on", "auto");
              out.stillOn.push(id);
              break;
            case "age_out":
              loop = this.#graph.patchLoop(id, {
                status: "dismissed",
                closedAt: iso(nowMs),
                closedBy: "aged_out",
              });
              this.#event(id, "status", "open", "dismissed", "auto");
              out.agedOut.push(id);
              break;
          }
        }
      }
      if (nudgeEligible(loop, nowMs)) out.nudgeEligible.push(id);
    }
    return out;
  }

  /** Records a nudge: drafted (nothing sent) or sent (counts toward the limit of two). */
  recordNudge(id: string, kind: "drafted" | "sent"): PromiseRow {
    const loop = this.#must(id);
    if (kind === "drafted") {
      this.#event(id, "nudge_drafted", null, null, "auto");
      return this.#row(loop);
    }
    const next = this.#graph.patchLoop(id, {
      nudgeCount: loop.nudgeCount + 1,
      lastNudgeAt: iso(this.#now()),
    });
    this.#event(id, "nudge_sent", String(loop.nudgeCount), String(loop.nudgeCount + 1), "owner");
    return this.#row(next);
  }

  // --- delete, retention, migration ------------------------------------------------------------

  /**
   * Hard delete (desktop shell only; the gateway checks): the loop, its citations and its events,
   * with `secure_delete`. Writes a `not_promise` feedback row keyed by the dedupe key and holding no
   * text, so the promise is not extracted again.
   */
  delete(id: string): void {
    const loop = this.#must(id);
    this.#db
      .prepare(
        "INSERT INTO graph_feedback (id, kind, entity_id, other_id, key_hash, created_at) VALUES (?, 'not_promise', NULL, NULL, ?, ?)",
      )
      .run(`fb_${this.#newId()}`, loop.dedupeKey, iso(this.#now()));
    secureDeleteLoops(this.#db, [id]);
  }

  /** Nightly retention; `EverythingStore.runRetention` calls this inside its own secure block. */
  retain(options: PromiseRetention = {}): PromiseRetentionResult {
    return retainPromises(this.#db, this.#now(), options);
  }

  /**
   * One `daily.followups.items` entry into the ledger (design 2.2). Idempotent: the dedupe key is
   * the follow-up's own id, so a second run finds the loop and adds nothing.
   */
  importFollowup(item: LegacyFollowup): "added" | "exists" | "skipped" {
    const key = sha256(`followup\n${item.id}`);
    const prior = this.#db.prepare("SELECT 1 FROM graph_loops WHERE dedupe_key = ?").get(key);
    if (prior !== undefined) return "exists";
    const ask = item.source === "awaiting_reply";
    const closed = item.status === "done" || item.status === "dismissed";
    const created = this.#graph.addLoop({
      direction: ask ? "waiting_on" : "i_owe",
      text: item.text,
      status: item.status === "dismissed" ? "dismissed" : item.status,
      provenance: "owner",
      confidence: 0.7,
      detectedBy: "rule",
      dedupeKey: key,
      createdAt: item.createdAt,
      basis: ask ? "ask" : "promise",
      sourceKind: ask ? "mail" : LEGACY_SOURCE[item.source as keyof typeof LEGACY_SOURCE],
      ...(item.dueAt === undefined ? {} : { dueAt: item.dueAt }),
      ...(item.snoozedUntil === undefined || item.status !== "snoozed"
        ? {}
        : { snoozedUntil: item.snoozedUntil }),
      ...(closed ? { closedAt: iso(this.#now()), closedBy: "owner" as const } : {}),
    });
    if (created === undefined) return "skipped";
    this.#event(created.id, "created", null, item.status, "rule");
    return "added";
  }
}
