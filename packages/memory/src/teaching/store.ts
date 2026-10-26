import { createHash } from "node:crypto";
import type {
  Clock,
  FeedbackEvent,
  FeedbackKind,
  FeedbackReason,
  FeedbackScope,
  FeedbackTarget,
  FeedbackTargetType,
  Lesson,
  LessonDestination,
  LessonKind,
  LessonOrigin,
  LessonScope,
  LessonStatus,
} from "@psyche/protocol";
import { PsycheError } from "@psyche/protocol";
import type Database from "better-sqlite3";
import { monotonicFactory } from "ulid";

/**
 * The teaching loop's records (docs/agent/teaching-loop-2026.md §3): `feedback_events` (the
 * owner's signals, evidence only) and `lessons` (what Psyche concluded and where it wrote it),
 * plus `feedback_weekly` counts that outlive the events. Plain SQL over the Gateway database;
 * the writers and the router never touch these tables directly.
 */

export interface FeedbackInput {
  kind: FeedbackKind;
  target: FeedbackTarget;
  text?: string | null;
  reason?: FeedbackReason | null;
  scope?: FeedbackScope | null;
  detail?: Record<string, unknown> | null;
  surface: string;
}

export interface NewLesson {
  kind: LessonKind;
  origin: LessonOrigin;
  statement: string;
  scope: LessonScope;
  destination: LessonDestination;
  previous: string | null;
  value: string;
  sources: string[];
  confidence: number;
  status: LessonStatus;
  refinedCount?: number;
  supersedes?: string | null;
  approvalId?: string | null;
}

export type LessonPatch = Partial<
  Pick<
    Lesson,
    | "statement"
    | "destination"
    | "previous"
    | "value"
    | "sources"
    | "confidence"
    | "status"
    | "refinedCount"
    | "supersedes"
    | "lastAppliedAt"
    | "confirmedAt"
    | "forgottenAt"
    | "scope"
  >
> & { approvalId?: string | null; lastConfirmedAt?: string | null };

export interface StoredLesson extends Lesson {
  /** The card a `proposed` lesson waits on. */
  approvalId: string | null;
  lastConfirmedAt: string | null;
  updatedAt: string;
}

interface EventRow {
  id: string;
  kind: FeedbackKind;
  target_type: string;
  target_id: string;
  target: string;
  thread_id: string | null;
  text: string | null;
  reason: string | null;
  scope: string | null;
  detail: string | null;
  surface: string;
  lesson_id: string | null;
  created_at: string;
}

interface LessonRow {
  id: string;
  kind: LessonKind;
  origin: LessonOrigin;
  statement: string;
  scope: string;
  destination: string;
  destination_key: string;
  previous: string | null;
  value: string;
  sources: string;
  confidence: number;
  status: LessonStatus;
  refined_count: number;
  supersedes: string | null;
  approval_id: string | null;
  fingerprint: string;
  last_applied_at: string | null;
  last_confirmed_at: string | null;
  created_at: string;
  updated_at: string;
  confirmed_at: string | null;
  forgotten_at: string | null;
}

/** Weekly counts per feedback kind, plus `draft_sent` outcomes (never events). */
export interface WeeklyCount {
  week: string;
  kind: FeedbackKind | "draft_sent";
  count: number;
}

/** Statuses whose line is in the destination (and so in the prompt). */
export const LIVE_STATUSES: readonly LessonStatus[] = ["active", "confirmed"];
/** Kept 180 days, then deleted; weekly counts survive (§3.5). */
export const FEEDBACK_RETENTION_DAYS = 180;
const MAX_PAGE = 200;

function toEvent(r: EventRow): FeedbackEvent {
  return {
    id: r.id,
    kind: r.kind,
    target: JSON.parse(r.target) as FeedbackTarget,
    text: r.text,
    reason: r.reason as FeedbackReason | null,
    scope: r.scope as FeedbackScope | null,
    detail: r.detail === null ? null : (JSON.parse(r.detail) as Record<string, unknown>),
    surface: r.surface,
    lessonId: r.lesson_id,
    createdAt: r.created_at,
  };
}

function toLesson(r: LessonRow): StoredLesson {
  return {
    id: r.id,
    kind: r.kind,
    origin: r.origin,
    statement: r.statement,
    scope: JSON.parse(r.scope) as LessonScope,
    destination: JSON.parse(r.destination) as LessonDestination,
    previous: r.previous,
    value: r.value,
    sources: JSON.parse(r.sources) as string[],
    confidence: r.confidence,
    status: r.status,
    refinedCount: r.refined_count,
    supersedes: r.supersedes,
    lastAppliedAt: r.last_applied_at,
    createdAt: r.created_at,
    confirmedAt: r.confirmed_at,
    forgottenAt: r.forgotten_at,
    approvalId: r.approval_id,
    lastConfirmedAt: r.last_confirmed_at,
    updatedAt: r.updated_at,
  };
}

/**
 * "The same destination" for supersede (§4 rule 3): the file and section plus the lesson's scope
 * (one scoped preference per recipient), the graph attribute or relation of one entity, the
 * skill's lessons file plus scope, the automation's field.
 */
export function destinationKey(destination: LessonDestination, scope: LessonScope): string {
  const s = scopeKey(scope);
  switch (destination.type) {
    case "file":
      return `file:${destination.path}#${destination.section}|${s}`;
    case "graph":
      return `graph:${destination.entityId}:${destination.attribute ?? `rel:${destination.rel ?? ""}`}`;
    case "skill":
      return `skill:${destination.skill}|${s}`;
    case "automation":
      return `automation:${destination.automationId}:${destination.field}`;
  }
}

export function scopeKey(scope: LessonScope): string {
  for (const k of ["skill", "automationId", "entityId", "connector", "recipient", "taskKind"]) {
    const v = (scope as Record<string, unknown>)[k];
    if (typeof v === "string" && v !== "") return `${k}=${v.toLowerCase()}`;
  }
  return "global";
}

/** Lowercase words only, so a reworded duplicate has the same fingerprint. */
export function normalizeLessonText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * Tombstone key: kind, destination and the normalised value. A forgotten lesson keeps only this
 * hash (never its text), so the same evidence cannot write the same line again (§3.5).
 */
export function lessonFingerprint(kind: LessonKind, key: string, value: string): string {
  return `sha256:${createHash("sha256")
    .update(`${kind}|${key}|${normalizeLessonText(value)}`)
    .digest("hex")}`;
}

/** The Monday of the week holding `iso`, `YYYY-MM-DD` (UTC). */
export function weekOf(iso: string): string {
  const d = new Date(iso);
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10);
}

function encodeCursor(createdAt: string, id: string): string {
  return Buffer.from(`${createdAt}|${id}`).toString("base64url");
}

function decodeCursor(cursor: string | undefined): { at: string; id: string } | undefined {
  if (cursor === undefined) return undefined;
  const raw = Buffer.from(cursor, "base64url").toString();
  const sep = raw.lastIndexOf("|");
  if (sep <= 0) throw new PsycheError("invalid_params", "bad cursor");
  return { at: raw.slice(0, sep), id: raw.slice(sep + 1) };
}

export interface TeachingStoreOptions {
  /** The migrated Gateway database (`openDb().sqlite`). */
  sqlite: Database.Database;
  clock?: Clock;
  newId?: (prefix: "fb" | "ls") => string;
}

export class TeachingStore {
  readonly #db: Database.Database;
  readonly #clock: Clock;
  readonly #newId: (prefix: "fb" | "ls") => string;

  constructor(options: TeachingStoreOptions) {
    this.#db = options.sqlite;
    this.#clock = options.clock ?? { now: () => Date.now() };
    const ulid = monotonicFactory();
    this.#newId = options.newId ?? ((prefix) => `${prefix}_${ulid().toLowerCase()}`);
  }

  #now(): string {
    return new Date(this.#clock.now()).toISOString();
  }

  // --- Feedback events ------------------------------------------------------------------------

  recordEvent(input: FeedbackInput): FeedbackEvent {
    const id = this.#newId("fb");
    const now = this.#now();
    const text = input.text?.replace(/\s+/g, " ").trim().slice(0, 500) || null;
    this.#db.transaction(() => {
      this.#db
        .prepare(
          `INSERT INTO feedback_events (id, kind, target_type, target_id, target, thread_id, text, reason,
             scope, detail, surface, lesson_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
        )
        .run(
          id,
          input.kind,
          input.target.type,
          input.target.id,
          JSON.stringify(input.target),
          input.target.threadId ?? null,
          text,
          input.reason ?? null,
          input.scope ?? null,
          input.detail == null ? null : JSON.stringify(input.detail),
          input.surface,
          now,
        );
      this.#db
        .prepare(
          `INSERT INTO feedback_weekly (week, kind, count) VALUES (?, ?, 1)
           ON CONFLICT (week, kind) DO UPDATE SET count = count + 1`,
        )
        .run(weekOf(now), input.kind);
    })();
    return this.getEvent(id) as FeedbackEvent;
  }

  getEvent(id: string): FeedbackEvent | undefined {
    const row = this.#db.prepare("SELECT * FROM feedback_events WHERE id = ?").get(id) as
      | EventRow
      | undefined;
    return row === undefined ? undefined : toEvent(row);
  }

  eventsFor(ids: readonly string[]): FeedbackEvent[] {
    return ids.flatMap((id) => {
      const e = this.getEvent(id);
      return e === undefined ? [] : [e];
    });
  }

  listEvents(
    filter: {
      since?: string;
      kind?: FeedbackKind;
      targetType?: FeedbackTargetType;
      targetId?: string;
      cursor?: string;
      limit?: number;
    } = {},
  ): { events: FeedbackEvent[]; nextCursor: string | null } {
    const where: string[] = [];
    const args: unknown[] = [];
    if (filter.since !== undefined) {
      where.push("created_at >= ?");
      args.push(filter.since);
    }
    if (filter.kind !== undefined) {
      where.push("kind = ?");
      args.push(filter.kind);
    }
    if (filter.targetType !== undefined) {
      where.push("target_type = ?");
      args.push(filter.targetType);
    }
    if (filter.targetId !== undefined) {
      where.push("target_id = ?");
      args.push(filter.targetId);
    }
    const after = decodeCursor(filter.cursor);
    if (after !== undefined) {
      where.push("(created_at < ? OR (created_at = ? AND id < ?))");
      args.push(after.at, after.at, after.id);
    }
    const limit = Math.min(filter.limit ?? 50, MAX_PAGE);
    const rows = this.#db
      .prepare(
        `SELECT * FROM feedback_events ${where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`}
         ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(...args, limit + 1) as EventRow[];
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      events: page.map(toEvent),
      nextCursor:
        rows.length > limit && last !== undefined ? encodeCursor(last.created_at, last.id) : null,
    };
  }

  /** Every event still kept (180 days), oldest first: growth and export. */
  allEvents(): FeedbackEvent[] {
    return (
      this.#db.prepare("SELECT * FROM feedback_events ORDER BY created_at, id").all() as EventRow[]
    ).map(toEvent);
  }

  linkEvent(eventId: string, lessonId: string | null): void {
    this.#db
      .prepare("UPDATE feedback_events SET lesson_id = ? WHERE id = ?")
      .run(lessonId, eventId);
  }

  deleteEvent(id: string): boolean {
    return this.#db.prepare("DELETE FROM feedback_events WHERE id = ?").run(id).changes > 0;
  }

  /** Retention (§3.5): events older than the cutoff go; their weekly counts stay. */
  deleteEventsBefore(cutoffIso: string): number {
    return this.#db.prepare("DELETE FROM feedback_events WHERE created_at < ?").run(cutoffIso)
      .changes;
  }

  deleteAllEvents(): number {
    return this.#db.prepare("DELETE FROM feedback_events").run().changes;
  }

  /**
   * An outcome that is not feedback (a draft sent as the agent wrote it): counted per week for
   * growth, never an event (§3.1 "smaller edits count as sent as-is for outcomes").
   */
  countOutcome(kind: "draft_sent"): void {
    this.#db
      .prepare(
        `INSERT INTO feedback_weekly (week, kind, count) VALUES (?, ?, 1)
         ON CONFLICT (week, kind) DO UPDATE SET count = count + 1`,
      )
      .run(weekOf(this.#now()), kind);
  }

  /** `{ week, kind, count }` rows, oldest first. */
  weekly(sinceWeek?: string): WeeklyCount[] {
    return this.#db
      .prepare(
        `SELECT week, kind, count FROM feedback_weekly ${sinceWeek === undefined ? "" : "WHERE week >= ?"}
         ORDER BY week, kind`,
      )
      .all(...(sinceWeek === undefined ? [] : [sinceWeek])) as WeeklyCount[];
  }

  // --- Lessons --------------------------------------------------------------------------------

  insertLesson(input: NewLesson): StoredLesson {
    const id = this.#newId("ls");
    const now = this.#now();
    const key = destinationKey(input.destination, input.scope);
    this.#db
      .prepare(
        `INSERT INTO lessons (id, kind, origin, statement, scope, destination, destination_key, previous,
           value, sources, confidence, status, refined_count, supersedes, approval_id, fingerprint,
           last_applied_at, last_confirmed_at, created_at, updated_at, confirmed_at, forgotten_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, NULL, NULL)`,
      )
      .run(
        id,
        input.kind,
        input.origin,
        input.statement,
        JSON.stringify(input.scope),
        JSON.stringify(input.destination),
        key,
        input.previous,
        input.value,
        JSON.stringify(input.sources),
        input.confidence,
        input.status,
        input.refinedCount ?? 0,
        input.supersedes ?? null,
        input.approvalId ?? null,
        lessonFingerprint(input.kind, key, input.value),
        now,
        now,
      );
    return this.getLesson(id) as StoredLesson;
  }

  updateLesson(id: string, patch: LessonPatch): StoredLesson {
    const current = this.getLesson(id);
    if (current === undefined) throw new PsycheError("not_found", `lesson ${id} not found`);
    const next = { ...current, ...patch };
    const key = destinationKey(next.destination, next.scope);
    this.#db
      .prepare(
        `UPDATE lessons SET statement = ?, scope = ?, destination = ?, destination_key = ?, previous = ?,
           value = ?, sources = ?, confidence = ?, status = ?, refined_count = ?, supersedes = ?,
           approval_id = ?, fingerprint = ?, last_applied_at = ?, last_confirmed_at = ?, confirmed_at = ?,
           forgotten_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        next.statement,
        JSON.stringify(next.scope),
        JSON.stringify(next.destination),
        key,
        next.previous,
        next.value,
        JSON.stringify(next.sources),
        next.confidence,
        next.status,
        next.refinedCount,
        next.supersedes,
        next.approvalId,
        // A forgotten lesson keeps the fingerprint of what it was (the tombstone).
        patch.value === undefined || next.status === "forgotten"
          ? this.#fingerprint(id)
          : lessonFingerprint(next.kind, key, next.value),
        next.lastAppliedAt,
        next.lastConfirmedAt,
        next.confirmedAt,
        next.forgottenAt,
        this.#now(),
        id,
      );
    return this.getLesson(id) as StoredLesson;
  }

  #fingerprint(id: string): string {
    return (
      this.#db.prepare("SELECT fingerprint FROM lessons WHERE id = ?").get(id) as {
        fingerprint: string;
      }
    ).fingerprint;
  }

  /** A lesson whose write was refused at its destination: nothing was learned. */
  deleteLesson(id: string): void {
    this.#db.prepare("DELETE FROM lessons WHERE id = ?").run(id);
  }

  getLesson(id: string): StoredLesson | undefined {
    const row = this.#db.prepare("SELECT * FROM lessons WHERE id = ?").get(id) as
      | LessonRow
      | undefined;
    return row === undefined ? undefined : toLesson(row);
  }

  lessonByApproval(approvalId: string): StoredLesson | undefined {
    const row = this.#db
      .prepare("SELECT * FROM lessons WHERE approval_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(approvalId) as LessonRow | undefined;
    return row === undefined ? undefined : toLesson(row);
  }

  listLessons(
    filter: {
      status?: readonly LessonStatus[];
      kind?: LessonKind;
      destination?: LessonDestination["type"];
      since?: string;
      cursor?: string;
      limit?: number;
    } = {},
  ): { lessons: StoredLesson[]; nextCursor: string | null } {
    const where: string[] = [];
    const args: unknown[] = [];
    const statuses =
      filter.status ?? (["proposed", "active", "confirmed", "dormant", "superseded"] as const);
    where.push(`status IN (${statuses.map(() => "?").join(", ")})`);
    args.push(...statuses);
    if (filter.kind !== undefined) {
      where.push("kind = ?");
      args.push(filter.kind);
    }
    if (filter.destination !== undefined) {
      where.push("destination_key LIKE ?");
      args.push(`${filter.destination}:%`);
    }
    if (filter.since !== undefined) {
      where.push("created_at >= ?");
      args.push(filter.since);
    }
    const after = decodeCursor(filter.cursor);
    if (after !== undefined) {
      where.push("(created_at < ? OR (created_at = ? AND id < ?))");
      args.push(after.at, after.at, after.id);
    }
    const limit = Math.min(filter.limit ?? 50, MAX_PAGE);
    const rows = this.#db
      .prepare(
        `SELECT * FROM lessons WHERE ${where.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(...args, limit + 1) as LessonRow[];
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      lessons: page.map(toLesson),
      nextCursor:
        rows.length > limit && last !== undefined ? encodeCursor(last.created_at, last.id) : null,
    };
  }

  /** Every lesson, any status, oldest first (export, growth). */
  allLessons(): StoredLesson[] {
    return (
      this.#db.prepare("SELECT * FROM lessons ORDER BY created_at, id").all() as LessonRow[]
    ).map(toLesson);
  }

  /** The live (or pending) lesson on a destination, which a new one supersedes. */
  currentOn(destination: LessonDestination, scope: LessonScope): StoredLesson | undefined {
    const row = this.#db
      .prepare(
        `SELECT * FROM lessons WHERE destination_key = ? AND status IN ('active', 'confirmed', 'dormant')
         ORDER BY created_at DESC, id DESC LIMIT 1`,
      )
      .get(destinationKey(destination, scope)) as LessonRow | undefined;
    return row === undefined ? undefined : toLesson(row);
  }

  /** Earlier lessons this one superseded, newest first. */
  history(id: string): StoredLesson[] {
    const out: StoredLesson[] = [];
    const seen = new Set([id]);
    let next = this.getLesson(id)?.supersedes ?? null;
    while (next !== null && !seen.has(next)) {
      seen.add(next);
      const l = this.getLesson(next);
      if (l === undefined) break;
      out.push(l);
      next = l.supersedes ?? null;
    }
    return out;
  }

  /** A forgotten lesson with this fingerprint exists: never write it again (§3.5). */
  isTombstoned(
    kind: LessonKind,
    destination: LessonDestination,
    scope: LessonScope,
    value: string,
  ) {
    const fp = lessonFingerprint(kind, destinationKey(destination, scope), value);
    return (
      this.#db
        .prepare("SELECT 1 FROM lessons WHERE fingerprint = ? AND status = 'forgotten' LIMIT 1")
        .get(fp) !== undefined
    );
  }

  /** Lessons citing a feedback event. */
  lessonsWithSource(eventId: string): StoredLesson[] {
    return (
      this.#db
        .prepare(
          "SELECT lessons.* FROM lessons, json_each(lessons.sources) WHERE json_each.value = ?",
        )
        .all(eventId) as LessonRow[]
    ).map(toLesson);
  }

  /** `memory.reset`: both tables and the weekly counts. */
  clear(): { lessons: number; events: number } {
    return this.#db.transaction(() => {
      const events = this.#db.prepare("DELETE FROM feedback_events").run().changes;
      const lessons = this.#db.prepare("DELETE FROM lessons").run().changes;
      this.#db.prepare("DELETE FROM feedback_weekly").run();
      return { lessons, events };
    })();
  }
}
