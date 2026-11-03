import type { GraphEntityKind, GraphProjectStatus, GraphWorkStatus } from "@psyche/protocol";

/**
 * Work items: the status state machine and staleness, as pure functions
 * (docs/design/memory-everything-2026.md §3.4, §3.6). No I/O and no clock of their own: the
 * caller passes `now`. Code decides status; the model never does, and third-party text never
 * changes it (W1).
 */

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** Kinds that carry a due date and show up in "Work due" and catch-up. */
export const WORK_KINDS: ReadonlySet<GraphEntityKind> = new Set(["project", "assignment", "event"]);

export function isWorkKind(kind: GraphEntityKind): boolean {
  return WORK_KINDS.has(kind);
}

/** The work facts whose newest value is cached on the entity row (§2.3). */
export const WORK_ATTRIBUTES = [
  "status",
  "deadline",
  "next_step",
  "stopped_at",
  "progress",
  "blocked_on",
] as const;

/**
 * Facts that mean the owner actually did something on the item. A due-date edit or a status tap
 * is not work, so it never starts an assignment on its own (§3.4).
 */
export const PROGRESS_ATTRIBUTES: ReadonlySet<string> = new Set(["progress", "stopped_at"]);

// --- status state machine (§3.4) ---------------------------------------------------------------

export const WORK_STATUSES: readonly GraphWorkStatus[] = [
  "not_started",
  "in_progress",
  "submitted",
  "done",
  "dropped",
];

export function isWorkStatus(value: string): value is GraphWorkStatus {
  return (WORK_STATUSES as readonly string[]).includes(value);
}

/** Statuses after which nothing is owed any more. */
export const CLOSED_STATUSES: ReadonlySet<GraphWorkStatus> = new Set(["done", "dropped"]);
/** Statuses that stop an item counting as overdue. */
const HANDED_IN: ReadonlySet<GraphWorkStatus> = new Set(["submitted", "done", "dropped"]);

/** What can move an assignment's status. `untrusted_text` is here so it can be refused in one place. */
export type WorkCause =
  /** An owner or agent signal: a file edit, owner chat, sent mail on the thread, a Psyche run. */
  | { type: "signal"; provenance: "owner" | "agent" }
  /** The owner set it (card, chat, or confirming a "submitted?" ask). */
  | { type: "owner_set"; to: GraphWorkStatus }
  /** An anchored Reminders item was completed. Only a list the owner tracks counts. */
  | { type: "reminder_completed"; trustedList: boolean }
  /** The parent project or course was marked done. */
  | { type: "parent_done" }
  /** Mail, a calendar invite or a work sender said so. Never moves status; may become an ask. */
  | { type: "untrusted_text"; claims: GraphWorkStatus };

/** How a status fact is written: the owner's word, or a rule (deterministic, cited to a signal). */
export type WorkStatusVia = "owner_stated" | "deterministic";

export interface WorkTransition {
  status: GraphWorkStatus;
  changed: boolean;
  /** Present when `changed`: what kind of fact to write. */
  via?: WorkStatusVia;
  /** Untrusted text claimed a status: show the owner a one-tap ask instead of acting. */
  ask?: { claims: GraphWorkStatus };
}

/**
 * The next status, or the same one. The transitions:
 *
 * | cause | from | to |
 * | --- | --- | --- |
 * | signal (owner, agent) | not_started | in_progress |
 * | owner_set X | anything else | X |
 * | reminder_completed (tracked list) | not_started, in_progress, submitted | done |
 * | parent_done | not_started, in_progress, submitted | done |
 * | untrusted_text | any | unchanged, plus an ask |
 *
 * A signal never reopens a closed or submitted item, and `dropped` only ever comes from the owner.
 */
export function nextWorkStatus(current: GraphWorkStatus, cause: WorkCause): WorkTransition {
  const same: WorkTransition = { status: current, changed: false };
  switch (cause.type) {
    case "signal":
      return current === "not_started"
        ? { status: "in_progress", changed: true, via: "deterministic" }
        : same;
    case "owner_set":
      return cause.to === current ? same : { status: cause.to, changed: true, via: "owner_stated" };
    case "reminder_completed":
      return cause.trustedList && !CLOSED_STATUSES.has(current)
        ? { status: "done", changed: true, via: "deterministic" }
        : same;
    case "parent_done":
      return !CLOSED_STATUSES.has(current)
        ? { status: "done", changed: true, via: "deterministic" }
        : same;
    case "untrusted_text":
      // Never a state change (W1). It is an ask only when it would change something.
      return cause.claims === current ? same : { ...same, ask: { claims: cause.claims } };
  }
}

// --- computed states (§3.4) --------------------------------------------------------------------

export interface WorkSnapshot {
  kind: GraphEntityKind;
  /** Stored status of an assignment. */
  workStatus: GraphWorkStatus | null;
  /** Project, course: `active / paused / done`. */
  projectStatus?: GraphProjectStatus | null;
  dueAt: string | null;
  lastSignalAt: string | null;
}

function ms(iso: string | null | undefined): number | null {
  if (iso === null || iso === undefined) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/** Whether the item is finished from the owner's side (done or dropped, or a project that is done). */
export function isClosed(
  item: Pick<WorkSnapshot, "kind" | "workStatus" | "projectStatus">,
): boolean {
  if (item.kind === "assignment")
    return item.workStatus !== null && CLOSED_STATUSES.has(item.workStatus);
  if (item.kind === "project") return item.projectStatus === "done";
  return false;
}

/** Past its due date and not handed in, done or dropped. Events are never overdue. */
export function isOverdue(item: WorkSnapshot, now: number): boolean {
  if (item.kind !== "assignment") return false;
  const due = ms(item.dueAt);
  if (due === null || due >= now) return false;
  return !HANDED_IN.has(item.workStatus ?? "not_started");
}

/**
 * Blocked is computed from an open `waiting_on` loop on the item or a current `blocked_on`
 * fact; there is no stored state for it.
 */
export function isBlocked(input: { openWaitingLoops: number; blockedOn: string | null }): boolean {
  return input.openWaitingLoops > 0 || (input.blockedOn !== null && input.blockedOn.trim() !== "");
}

// --- staleness (§3.6) --------------------------------------------------------------------------

export const ASSIGNMENT_FRESH_DAYS = 3;
export const ASSIGNMENT_FAR_DUE_DAYS = 7;
export const PROJECT_FRESH_DAYS = 14;
export const NEXT_STEP_FRESH_DAYS = 14;

/**
 * Stale means "show it as of its last signal, with a muted mark". An assignment is fresh with a
 * signal in the last 3 days, or while the due date is 7 or more days away; a project with a signal
 * in the last 14 days. Closed and handed-in items, paused or done projects and events are never
 * stale: there is nothing to chase.
 */
export function isStale(item: WorkSnapshot, now: number): boolean {
  const signal = ms(item.lastSignalAt);
  if (item.kind === "assignment") {
    if (item.workStatus !== null && HANDED_IN.has(item.workStatus)) return false;
    if (signal !== null && now - signal <= ASSIGNMENT_FRESH_DAYS * DAY_MS) return false;
    const due = ms(item.dueAt);
    if (due !== null && due - now >= ASSIGNMENT_FAR_DUE_DAYS * DAY_MS) return false;
    return true;
  }
  if (item.kind === "project") {
    if (
      item.projectStatus !== undefined &&
      item.projectStatus !== null &&
      item.projectStatus !== "active"
    ) {
      return false;
    }
    return signal === null || now - signal > PROJECT_FRESH_DAYS * DAY_MS;
  }
  return false;
}

/**
 * `next_step` and `stopped_at` older than 14 days "may be out of date" and drop out of the brief's
 * resume line. `recordedAt` is the fact's `valid_from`/`recorded_at`.
 */
export function isFactStale(recordedAt: string, now: number): boolean {
  const t = ms(recordedAt);
  return t === null || now - t > NEXT_STEP_FRESH_DAYS * DAY_MS;
}

// --- project status suggestions (§3.4) ---------------------------------------------------------

export const PAUSE_AFTER_DAYS = 30;
export const DONE_AFTER_DEADLINE_DAYS = 14;

/**
 * Psyche may suggest a change to a project and never makes it: pause after 30 days with no
 * signal; done once the deadline has passed and 14 days went by with no signal.
 */
export function suggestProjectStatus(
  project: {
    projectStatus: GraphProjectStatus;
    dueAt: string | null;
    lastSignalAt: string | null;
    createdAt: string;
  },
  now: number,
): "paused" | "done" | null {
  if (project.projectStatus !== "active") return null;
  const lastSignal = ms(project.lastSignalAt) ?? ms(project.createdAt) ?? now;
  const quiet = now - lastSignal;
  const due = ms(project.dueAt);
  if (due !== null && now > due && quiet > DONE_AFTER_DEADLINE_DAYS * DAY_MS) return "done";
  if (quiet > PAUSE_AFTER_DAYS * DAY_MS) return "paused";
  return null;
}

// --- past due (§3.6) ---------------------------------------------------------------------------

export const PAST_DUE_QUIET_DAYS = 14;
export const ARCHIVE_AFTER_DAYS = 14;

export type PastDuePhase =
  /** Not past due, or already handed in. */
  | "none"
  /** The day after the due date: one ask, "Did you finish it?" (Home → Needs you, the brief). */
  | "ask"
  /** No answer for 14 days: out of the brief and Home, still listed under Work due → Past due. */
  | "quiet";

/** The ask starts the day after the due date and goes quiet after 14 days. Silence never changes status. */
export function pastDuePhase(item: WorkSnapshot, now: number, utcOffsetMinutes = 0): PastDuePhase {
  if (!isOverdue(item, now)) return "none";
  const due = ms(item.dueAt) as number;
  const askFrom = startOfNextDay(due, utcOffsetMinutes);
  if (now < askFrom) return "none";
  return now - askFrom >= PAST_DUE_QUIET_DAYS * DAY_MS ? "quiet" : "ask";
}

/** The start of the day after `t` in the owner's day (`utcOffsetMinutes` east of UTC). */
function startOfNextDay(t: number, utcOffsetMinutes: number): number {
  const shift = utcOffsetMinutes * 60_000;
  const d = new Date(t + shift);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - shift;
}

/** A done or dropped item leaves "Work due" 14 days after it closed (it stays on the timeline). */
export function leavesWorkDue(
  item: Pick<WorkSnapshot, "kind" | "workStatus" | "projectStatus">,
  closedAt: string | null,
  now: number,
): boolean {
  if (!isClosed(item)) return false;
  const t = ms(closedAt);
  return t !== null && now - t >= ARCHIVE_AFTER_DAYS * DAY_MS;
}

/** Whole hours until the due date (negative once past). Null with no due date. */
export function hoursUntilDue(dueAt: string | null, now: number): number | null {
  const due = ms(dueAt);
  return due === null ? null : Math.floor((due - now) / HOUR_MS);
}
