import type {
  Clock,
  GraphAnchor,
  GraphEntity,
  GraphInteraction,
  GraphWorkStatus,
} from "@psyche/protocol";
import { safeName } from "./clean.ts";
import { normalizeName } from "./normalize.ts";
import { type GraphStore, normalizeDueAt } from "./store.ts";
import { CLOSED_STATUSES, nextWorkStatus, type WorkCause } from "./work.ts";

/**
 * Deterministic work signals (docs/design/memory-everything-2026.md §3.1, §3.2, §3.4, §7.1): the
 * owner's own Reminders, calendars, files and sent mail, turned into assignments, deadlines,
 * pointers on an item's timeline and status changes by rules. No model, no new reader of any
 * source: connector-neutral records come in, the same way `ingest.ts` takes mail and events.
 *
 * The one rule that matters (W1): only a signal that carries `trusted: true` (the owner's own
 * list, calendar or granted folder) can change a status, and every status change is a `status`
 * fact written by the state machine and cited to its signal (the pointer interaction and the
 * source reference). Anything untrusted can at most add a suggestion or an ask, never state.
 */

const DAY_MS = 86_400_000;
const STATE_KEY = "work:signals";
/** Most assignments one pass creates, whatever the sources hold (a flood guard, W10). */
export const MAX_NEW_PER_PASS = 50;
/** A completed reminder this old is history, not a new item. */
const RECENT_DONE_DAYS = 14;
const MAX_PATHS_PER_DAY = 200;
const MAX_STATE_KEYS = 5000;

// --- records ---------------------------------------------------------------------------------

export interface ReminderRecord {
  id: string;
  listId: string;
  listTitle?: string;
  title: string;
  /** ISO date or date-time; absent when the reminder has no due date. */
  due?: string | null;
  completed: boolean;
  completedAt?: string | null;
  modifiedAt?: string | null;
  link?: string;
  /** The reminder is the owner's own content (a list they marked theirs, #1006). */
  trusted: boolean;
}

export interface CalendarEventRecord {
  id: string;
  calendarId: string;
  calendarTitle?: string;
  title: string;
  start: string;
  end?: string | null;
  /** Stable for every occurrence of a recurring event (a course's meeting series). */
  seriesId?: string | null;
  link?: string;
  /** Own event on a calendar the owner declared theirs (#1006): not an invitation. */
  trusted: boolean;
}

export interface FileChangeRecord {
  path: string;
  /** ISO time of the change. */
  at: string;
  /** In a folder the owner granted. Anything else (Downloads, a shared folder) gives no signal (W7). */
  owner: boolean;
}

export interface FolderRecord {
  path: string;
  owner: boolean;
}

export interface WorkSettings {
  /** Reminders list id to the project or course it feeds. */
  trackedLists: Record<string, string>;
  anchorsFromFolders: "anchored_only" | "all_granted";
}

export interface WorkSignalInput {
  settings: WorkSettings;
  reminders?: ReminderRecord[];
  events?: CalendarEventRecord[];
  files?: FileChangeRecord[];
  /** Granted folders to look at for names that match a course or project (W5). */
  folders?: FolderRecord[];
  /** Attachment names of a sent mail, when the mail source can tell. */
  attachments?: (mail: GraphInteraction) => string[] | undefined;
  /** How far back sent and received mail on anchored threads is read (default 30 days). */
  mailDays?: number;
  /** The owner's day: minutes east of UTC (file days). */
  utcOffsetMinutes?: number;
}

// --- results ---------------------------------------------------------------------------------

export interface StatusChange {
  entityId: string;
  from: GraphWorkStatus;
  to: GraphWorkStatus;
  cause: "activity" | "reminder_completed";
  /** What the status fact cites: the pointer interaction and the source reference. */
  sources: string[];
}

/** A one-tap question for the owner instead of a state change (§3.4). */
export interface WorkAsk {
  entityId: string;
  claims: GraphWorkStatus;
  at: string;
  sources: string[];
  /** Verbatim from the source, shown as data. */
  evidence: string;
  origin: "untrusted_text" | "sent_mail";
}

export interface WorkSignalReport {
  /** Assignments created from tracked reminders and due-type events. */
  created: number;
  /** Existing assignments that a reminder or event now feeds. */
  adopted: number;
  deadlines: number;
  statusChanges: StatusChange[];
  interactions: number;
  suggestions: number;
  asks: number;
  /** A source disagreed with a date already set; nothing was overwritten. */
  conflicts: number;
  anchors: number;
  /** Signals from sources the owner did not declare theirs: counted, never acted on. */
  untrusted: number;
  skipped: number;
  /** Titles or values the store refused (credentials, a name that is not usable). */
  refused: number;
}

const emptyReport = (): WorkSignalReport => ({
  created: 0,
  adopted: 0,
  deadlines: 0,
  statusChanges: [],
  interactions: 0,
  suggestions: 0,
  asks: 0,
  conflicts: 0,
  anchors: 0,
  untrusted: 0,
  skipped: 0,
  refused: 0,
});

// --- state (the cursor) ----------------------------------------------------------------------

interface WorkState {
  v: 1;
  reminders: Record<string, { due: string | null; done: boolean }>;
  events: Record<string, { entityId: string; start: string }>;
  files: Record<string, string[]>;
  folderSuggested: string[];
  asks: WorkAsk[];
}

function loadState(graph: GraphStore): WorkState {
  const raw = graph.cursor(STATE_KEY) as Partial<WorkState> | null | undefined;
  return {
    v: 1,
    reminders: raw?.reminders ?? {},
    events: raw?.events ?? {},
    files: raw?.files ?? {},
    folderSuggested: raw?.folderSuggested ?? [],
    asks: raw?.asks ?? [],
  };
}

function cap<T>(rec: Record<string, T>): Record<string, T> {
  const keys = Object.keys(rec);
  if (keys.length <= MAX_STATE_KEYS) return rec;
  return Object.fromEntries(keys.slice(keys.length - MAX_STATE_KEYS).map((k) => [k, rec[k] as T]));
}

/** The questions the signals left for the owner (for catch-up to show); never a status change. */
export function pendingWorkAsks(graph: GraphStore): WorkAsk[] {
  return loadState(graph).asks;
}

// --- names -----------------------------------------------------------------------------------

const FILLER = new Set(["re", "fw", "fwd", "aw", "sv", "the", "a", "an", "of", "to", "for", "and"]);
const DUE_WORDS = /\b(due|deadline|submit(?:ted|ting)?|turn(?:ed)?\s+in)\b/i;

/** Letters and digits as separate tokens: `HW7` and `hw 7` match, `HW7` and `HW70` do not. */
export function nameTokens(text: string): string[] {
  return (normalizeName(text).match(/\p{L}+|\p{N}+/gu) ?? []).filter((t) => !FILLER.has(t));
}

/**
 * Every token of `name` appears in `text`. A name needs at least `min` tokens (default two), so
 * "Report" never claims every mail with the word in it; "HW7" and "MATH 21" are two tokens.
 */
export function namedIn(name: string, text: string, min = 2): boolean {
  const nt = nameTokens(name);
  if (nt.length < min) return false;
  const have = new Set(nameTokens(text));
  return nt.every((t) => have.has(t));
}

/**
 * The item's words appear in `text` in order and next to each other ("HW 7", "hw7"), so "hw 3, 7
 * mins" does not name HW7. A single-word name needs only that word.
 */
export function namedAdjacent(name: string, text: string): boolean {
  const nt = nameTokens(name);
  const tt = nameTokens(text);
  if (nt.length === 0) return false;
  for (let i = 0; i + nt.length <= tt.length; i++) {
    if (nt.every((w, k) => tt[i + k] === w)) return true;
  }
  return false;
}

/** The ways an item can be named in text: its name without a term suffix, aliases, a course code. */
export function workNames(graph: GraphStore, entity: GraphEntity): string[] {
  const names = new Set<string>([entity.name, entity.name.replace(/\s*\([^)]*\)\s*$/, "")]);
  for (const a of entity.aliases) names.add(a);
  if (entity.kind === "project") {
    for (const f of graph.facts(entity.id)) if (f.attribute === "course_code") names.add(f.value);
  }
  return [...names].filter((n) => n.trim() !== "");
}

export const isOpenWork = (e: GraphEntity): boolean =>
  e.kind === "assignment"
    ? e.workStatus == null || !CLOSED_STATUSES.has(e.workStatus)
    : e.projectStatus !== "done";

/** The one project or course a title names; none when it names two or none. */
function parentFromTitle(
  graph: GraphStore,
  title: string,
  only?: "course",
): { entity: GraphEntity; matched: string } | undefined {
  let best: { entity: GraphEntity; matched: string; size: number } | undefined;
  let ambiguous = false;
  for (const p of graph.listEntities(["project"])) {
    if (p.projectStatus === "done") continue;
    if (only === "course" && p.projectType !== "course") continue;
    for (const n of workNames(graph, p)) {
      if (!namedIn(n, title)) continue;
      const size = nameTokens(n).length;
      if (best === undefined || size > best.size) {
        best = { entity: p, matched: n, size };
        ambiguous = false;
      } else if (size === best.size && p.id !== best.entity.id) ambiguous = true;
    }
  }
  return best === undefined || ambiguous
    ? undefined
    : { entity: best.entity, matched: best.matched };
}

/** A title made safe to store and show: one line, no invisible characters. */
const cleanTitle = (title: string): string => safeName(title, 200);

function stripDue(title: string): string {
  return title
    .replace(new RegExp(DUE_WORDS.source, "gi"), " ")
    .replace(/^[\s:–—\-|,.]+|[\s:–—\-|,.]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function stripMatched(title: string, matched: string): string {
  const pattern = matched
    .trim()
    .split(/\s+/)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("\\s*");
  const rest = title
    .replace(new RegExp(pattern, "i"), " ")
    .replace(/^[\s:–—\-|,.()]+|[\s:–—\-|,.()]+$/g, "")
    .trim();
  return rest.length >= 2 ? rest : title;
}

// --- shared writers --------------------------------------------------------------------------

const parentOf = (graph: GraphStore, id: string): string | undefined =>
  graph.edges(id).find((e) => e.src === id && e.rel === "part_of")?.dst;

const clampAt = (iso: string | null | undefined, now: number): string => {
  const t = iso === null || iso === undefined ? Number.NaN : Date.parse(iso);
  return new Date(Number.isNaN(t) ? now : Math.min(t, now)).toISOString();
};

const dayKey = (iso: string, offsetMinutes: number): string =>
  new Date(Date.parse(iso) + offsetMinutes * 60_000).toISOString().slice(0, 10);

interface Pointer {
  kind: "reminder" | "file" | "meeting" | "mail";
  source: string;
  externalRef: string;
  at: string;
  direction: GraphInteraction["direction"];
  subject: string | null;
  link?: string | null;
  entityId: string;
}

/** A pointer on the item's timeline, tied to it and to its project or course. Idempotent. */
function point(graph: GraphStore, p: Pointer): string {
  const parent = parentOf(graph, p.entityId);
  const self = graph.getEntity(p.entityId);
  const projectId = self?.kind === "project" ? self.id : (parent ?? null);
  return graph.upsertInteraction({
    kind: p.kind,
    source: p.source,
    externalRef: p.externalRef,
    occurredAt: p.at,
    direction: p.direction,
    subject: p.subject,
    link: p.link ?? null,
    projectId,
    subjects: [{ entityId: p.entityId }],
    participants: [],
  });
}

/** Evidence that the owner worked on an item (and its course): refreshes `last_signal_at`. */
function touch(graph: GraphStore, entityId: string, at: string): void {
  const ids = [entityId];
  const parent = parentOf(graph, entityId);
  if (parent !== undefined) ids.push(parent);
  for (const id of ids) {
    try {
      graph.recordSignal(id, { at, provenance: "owner", startsWork: false });
    } catch {
      // Not a work item any more: nothing to refresh.
    }
  }
}

interface StatusInput {
  /** From the source's own trust: the owner's list, calendar or folder. */
  trusted: boolean;
  cause: "activity" | "reminder_completed";
  sources: string[];
  evidence: string;
  at: string;
  origin?: WorkAsk["origin"];
}

/**
 * The only place a signal reaches a status. Trusted: the state machine decides and the fact is a
 * `deterministic` one citing `sources`. Untrusted: never a change; a completion claim becomes an
 * ask when it would change something (W1).
 */
function moveStatus(
  graph: GraphStore,
  state: WorkState,
  report: WorkSignalReport,
  entityId: string,
  input: StatusInput,
): void {
  const e = graph.getEntity(entityId);
  if (e?.kind !== "assignment" || e.workStatus == null) return;
  if (!input.trusted) {
    if (input.cause !== "reminder_completed") return;
    const t = nextWorkStatus(e.workStatus, { type: "untrusted_text", claims: "done" });
    if (t.ask !== undefined) addAsk(state, report, { ...base(input, entityId), claims: "done" });
    return;
  }
  const cause: WorkCause =
    input.cause === "activity"
      ? { type: "signal", provenance: "owner" }
      : { type: "reminder_completed", trustedList: true };
  const t = nextWorkStatus(e.workStatus, cause);
  if (!t.changed) return;
  const written = graph.setFact({
    entityId,
    attribute: "status",
    value: t.status,
    provenance: "system",
    subjectKind: "deterministic",
    sources: input.sources,
    evidence: input.evidence,
  });
  if (written === undefined) {
    report.refused++;
    return;
  }
  report.statusChanges.push({
    entityId,
    from: e.workStatus,
    to: t.status,
    cause: input.cause,
    sources: input.sources,
  });
}

const base = (input: StatusInput, entityId: string) => ({
  entityId,
  at: input.at,
  sources: input.sources,
  evidence: input.evidence,
  origin: input.origin ?? ("untrusted_text" as const),
});

function addAsk(state: WorkState, report: WorkSignalReport, ask: WorkAsk): void {
  if (state.asks.some((a) => a.entityId === ask.entityId && a.claims === ask.claims)) return;
  state.asks.push(ask);
  report.asks++;
}

/** An ask goes away once the item is already where it said. */
function settleAsks(graph: GraphStore, state: WorkState): void {
  state.asks = state.asks.filter((a) => {
    const e = graph.getEntity(a.entityId);
    if (e?.workStatus == null) return false;
    if (a.claims === "submitted")
      return e.workStatus === "not_started" || e.workStatus === "in_progress";
    return !CLOSED_STATUSES.has(e.workStatus);
  });
}

/** A deadline from a source the owner trusts: the owner's own signal, cited to it. */
function setDeadline(
  graph: GraphStore,
  report: WorkSignalReport,
  entityId: string,
  dueAt: string,
  cite: { sources: string[]; evidence: string },
): boolean {
  try {
    const written = graph.setFact({
      entityId,
      attribute: "deadline",
      value: dueAt,
      provenance: "owner",
      subjectKind: "deterministic",
      sources: cite.sources,
      evidence: cite.evidence,
    });
    if (written === undefined) {
      report.refused++;
      return false;
    }
    return true;
  } catch {
    report.refused++;
    return false;
  }
}

function newAssignment(
  graph: GraphStore,
  report: WorkSignalReport,
  input: { name: string; dueAt: string; parentId?: string; sources: string[]; pointerId?: string },
): GraphEntity | undefined {
  try {
    const entity = graph.createEntity({
      kind: "assignment",
      name: input.name,
      dueAt: input.dueAt,
      source: "rule",
    });
    if (input.parentId !== undefined) {
      graph.setEdge({
        src: entity.id,
        rel: "part_of",
        dst: input.parentId,
        provenance: "system",
        confidence: 0.9,
        sources: input.pointerId === undefined ? input.sources : [input.pointerId],
      });
    }
    return entity;
  } catch {
    report.refused++;
    return undefined;
  }
}

function suggestAssignment(
  graph: GraphStore,
  report: WorkSignalReport,
  input: { name: string; dueAt: string | null; parentId?: string; reason: string },
): void {
  const s = graph.suggest({
    kind: "assignment",
    entityIds: input.parentId === undefined ? [] : [input.parentId],
    name: input.name,
    dueAt: input.dueAt,
    reason: input.reason,
  });
  if (s !== undefined) report.suggestions++;
}

// --- reminders (§3.2 item 2, §3.1 Reminders) -------------------------------------------------

function reminderSignals(
  graph: GraphStore,
  clock: Clock,
  state: WorkState,
  report: WorkSignalReport,
  records: ReminderRecord[],
  tracked: Record<string, string>,
  budget: { left: number },
): void {
  const now = clock.now();
  for (const r of records) {
    const title = cleanTitle(r.title);
    if (title === "") {
      report.skipped++;
      continue;
    }
    const due = normalizeDueAt(r.due);
    const parent = graph.getEntity(tracked[r.listId] ?? "");
    const trackedParent =
      parent !== undefined && parent.kind === "project" && parent.projectStatus !== "done"
        ? parent
        : undefined;
    const anchor = graph
      .routeAnchor("reminder", r.id)
      .find((a) => graph.getEntity(a.entityId)?.kind === "assignment");
    const known = state.reminders[r.id];

    if (anchor === undefined) {
      if (trackedParent === undefined) {
        // Another list: a reminder that names an open assignment is a progress signal, nothing more.
        if (r.trusted && known === undefined) nameSignal(graph, state, report, r, title, now);
        continue;
      }
      if (due === null) {
        report.skipped++;
        continue;
      }
      const doneAt = clampAt(r.completedAt ?? r.modifiedAt, now);
      if (r.completed && now - Date.parse(doneAt) > RECENT_DONE_DAYS * DAY_MS) {
        report.skipped++;
        continue;
      }
      if (!r.trusted) {
        report.untrusted++;
        suggestAssignment(graph, report, {
          name: title,
          dueAt: due,
          parentId: trackedParent.id,
          reason: `A reminder in "${safeName(r.listTitle ?? "a Reminders list", 60)}", which is not marked as yours`,
        });
        continue;
      }
      if (budget.left <= 0) {
        report.skipped++;
        continue;
      }
      const adopted = graph
        .listEntities(["assignment"])
        .find(
          (a) =>
            normalizeName(a.name) === normalizeName(title) &&
            parentOf(graph, a.id) === trackedParent.id &&
            graph.anchors({ entityId: a.id, kind: "reminder" }).length === 0,
        );
      const entity =
        adopted ??
        newAssignment(graph, report, {
          name: title,
          dueAt: due,
          parentId: trackedParent.id,
          sources: [`reminders:${r.id}`],
        });
      if (entity === undefined) continue;
      if (adopted === undefined) {
        budget.left--;
        report.created++;
      } else report.adopted++;
      const pointerId = point(graph, {
        kind: "reminder",
        source: "reminders",
        externalRef: `rem:${r.id}:created`,
        at: clampAt(r.modifiedAt, now),
        direction: "none",
        subject: title,
        link: r.link ?? null,
        entityId: entity.id,
      });
      report.interactions++;
      graph.addAnchor({
        entityId: entity.id,
        kind: "reminder",
        ref: r.id,
        label: title,
        addedBy: "rule",
      });
      report.anchors++;
      const cite = { sources: [pointerId, `reminders:${r.id}`], evidence: title };
      if (adopted === undefined || adopted.dueAt === due)
        setDeadline(graph, report, entity.id, due, cite);
      else report.conflicts++;
      state.reminders[r.id] = { due, done: false };
      if (r.completed) completeReminder(graph, state, report, entity.id, r, title, doneAt, true);
      continue;
    }

    // An assignment this reminder already feeds.
    const entityId = anchor.entityId;
    if (known === undefined) {
      state.reminders[r.id] = { due, done: false };
    }
    const seen = state.reminders[r.id] as { due: string | null; done: boolean };
    if (!r.trusted) {
      report.untrusted++;
      if (r.completed && !seen.done) {
        moveStatus(graph, state, report, entityId, {
          trusted: false,
          cause: "reminder_completed",
          sources: [`reminders:${r.id}`],
          evidence: title,
          at: clampAt(r.completedAt ?? r.modifiedAt, now),
        });
      }
      continue;
    }
    if (due !== null && due !== seen.due) {
      const entity = graph.getEntity(entityId);
      if (entity?.dueAt !== due) {
        const pointerId = point(graph, {
          kind: "reminder",
          source: "reminders",
          externalRef: `rem:${r.id}:due:${due}`,
          at: clampAt(r.modifiedAt, now),
          direction: "none",
          subject: title,
          link: r.link ?? null,
          entityId,
        });
        report.interactions++;
        if (
          setDeadline(graph, report, entityId, due, {
            sources: [pointerId, `reminders:${r.id}`],
            evidence: title,
          })
        )
          report.deadlines++;
      }
      seen.due = due;
    }
    if (r.completed && !seen.done) {
      completeReminder(
        graph,
        state,
        report,
        entityId,
        r,
        title,
        clampAt(r.completedAt ?? r.modifiedAt, now),
        false,
      );
    }
    if (!r.completed) seen.done = false;
  }
  state.reminders = cap(state.reminders);
}

function completeReminder(
  graph: GraphStore,
  state: WorkState,
  report: WorkSignalReport,
  entityId: string,
  r: ReminderRecord,
  title: string,
  at: string,
  created: boolean,
): void {
  const pointerId = point(graph, {
    kind: "reminder",
    source: "reminders",
    externalRef: `rem:${r.id}:done`,
    at,
    direction: "none",
    subject: title,
    link: r.link ?? null,
    entityId,
  });
  report.interactions++;
  moveStatus(graph, state, report, entityId, {
    trusted: r.trusted,
    cause: "reminder_completed",
    sources: [pointerId, `reminders:${r.id}`],
    evidence: title,
    at,
  });
  const seen = state.reminders[r.id];
  if (seen !== undefined) seen.done = true;
  else if (created) state.reminders[r.id] = { due: normalizeDueAt(r.due), done: true };
  touch(graph, entityId, at);
}

/** A reminder in an untracked list whose title names an open assignment: a pointer and a signal. */
function nameSignal(
  graph: GraphStore,
  state: WorkState,
  report: WorkSignalReport,
  r: ReminderRecord,
  title: string,
  now: number,
): void {
  const hit = graph
    .listEntities(["assignment"])
    .filter(isOpenWork)
    .find((a) => workNames(graph, a).some((n) => namedIn(n, title)));
  state.reminders[r.id] = { due: normalizeDueAt(r.due), done: r.completed };
  if (hit === undefined) return;
  const at = clampAt(r.modifiedAt, now);
  point(graph, {
    kind: "reminder",
    source: "reminders",
    externalRef: `rem:${r.id}:named`,
    at,
    direction: "none",
    subject: title,
    link: r.link ?? null,
    entityId: hit.id,
  });
  report.interactions++;
  touch(graph, hit.id, at);
}

// --- calendar (§3.2 item 3, §3.1 Calendar) ---------------------------------------------------

function calendarSignals(
  graph: GraphStore,
  clock: Clock,
  state: WorkState,
  report: WorkSignalReport,
  events: CalendarEventRecord[],
  budget: { left: number },
): void {
  const now = clock.now();
  for (const e of events) {
    const start = normalizeDueAt(e.start);
    const title = cleanTitle(e.title);
    if (start === null || title === "") {
      report.skipped++;
      continue;
    }
    if (DUE_WORDS.test(title)) dueEvent(graph, state, report, e, title, start, budget);
    else if (e.trusted) meetingEvent(graph, report, e, title, start, now);
    else report.untrusted++;
  }
  state.events = cap(state.events);
}

/** A due-type event ("HW5 due"): a trusted calendar creates or confirms the item, others suggest. */
function dueEvent(
  graph: GraphStore,
  state: WorkState,
  report: WorkSignalReport,
  e: CalendarEventRecord,
  title: string,
  start: string,
  budget: { left: number },
): void {
  const calendarAnchor = graph.routeAnchor("calendar", e.calendarId).find((a) => {
    const k = graph.getEntity(a.entityId);
    return k?.kind === "project" && k.projectStatus !== "done";
  });
  const byTitle = calendarAnchor === undefined ? parentFromTitle(graph, title) : undefined;
  const parentId = calendarAnchor?.entityId ?? byTitle?.entity.id;
  const name = stripDue(byTitle === undefined ? title : stripMatched(title, byTitle.matched));
  if (name === "") {
    report.skipped++;
    return;
  }
  const known = state.events[e.id];
  const open = graph.listEntities(["assignment"]).filter(isOpenWork);
  const sameName = open.filter(
    (a) =>
      normalizeName(a.name) === normalizeName(name) &&
      (parentId === undefined || parentOf(graph, a.id) === parentId),
  );
  // A name shared by two open items is not clear: make no new one and touch neither.
  if (known === undefined && sameName.length > 1) {
    report.skipped++;
    return;
  }
  const existing =
    (known === undefined ? undefined : open.find((a) => a.id === known.entityId)) ?? sameName[0];
  if (!e.trusted) {
    report.untrusted++;
    if (existing === undefined) {
      suggestAssignment(graph, report, {
        name,
        dueAt: start,
        ...(parentId === undefined ? {} : { parentId }),
        reason: `A calendar event on "${safeName(e.calendarTitle ?? "a calendar", 60)}", which is not marked as yours`,
      });
    }
    return;
  }
  const cite = { sources: [`calendar:${e.id}`], evidence: title };
  if (existing === undefined) {
    if (budget.left <= 0) {
      report.skipped++;
      return;
    }
    const entity = newAssignment(graph, report, {
      name,
      dueAt: start,
      ...(parentId === undefined ? {} : { parentId }),
      sources: cite.sources,
    });
    if (entity === undefined) return;
    budget.left--;
    report.created++;
    setDeadline(graph, report, entity.id, start, cite);
    state.events[e.id] = { entityId: entity.id, start };
    return;
  }
  if (known === undefined) {
    // First sight of an item that already exists: confirm it, never overwrite what is set.
    report.adopted++;
    if (existing.dueAt === start) setDeadline(graph, report, existing.id, start, cite);
    else report.conflicts++;
    state.events[e.id] = { entityId: existing.id, start };
    return;
  }
  if (known.start !== start) {
    if (existing.dueAt !== start && setDeadline(graph, report, existing.id, start, cite))
      report.deadlines++;
    known.start = start;
  }
}

/** A trusted calendar's other events: a course's meeting series, and work named for an item. */
function meetingEvent(
  graph: GraphStore,
  report: WorkSignalReport,
  e: CalendarEventRecord,
  title: string,
  start: string,
  now: number,
): void {
  const past = Date.parse(start) <= now;
  if (e.seriesId !== undefined && e.seriesId !== null && e.seriesId !== "") {
    let course = graph
      .routeAnchor("calendar_series", e.seriesId)
      .map((a) => graph.getEntity(a.entityId))
      .find((x): x is GraphEntity => x?.kind === "project");
    if (course === undefined) {
      const match = parentFromTitle(graph, title, "course");
      if (match !== undefined) {
        graph.addAnchor({
          entityId: match.entity.id,
          kind: "calendar_series",
          ref: e.seriesId,
          label: title,
          addedBy: "rule",
        });
        report.anchors++;
        course = match.entity;
      }
    }
    if (course !== undefined) {
      if (past) {
        point(graph, {
          kind: "meeting",
          source: "calendar",
          externalRef: `work:cal:${e.id}`,
          at: start,
          direction: "out",
          subject: title,
          link: e.link ?? null,
          entityId: course.id,
        });
        report.interactions++;
      }
      return;
    }
  }
  if (!past) return;
  const hit = graph
    .listEntities(["assignment"])
    .filter(isOpenWork)
    .find((a) => workNames(graph, a).some((n) => namedIn(n, title)));
  if (hit === undefined) return;
  point(graph, {
    kind: "meeting",
    source: "calendar",
    externalRef: `work:cal:${e.id}`,
    at: start,
    direction: "out",
    subject: title,
    link: e.link ?? null,
    entityId: hit.id,
  });
  report.interactions++;
}

// --- files (§3.1 Files, W5, W7) --------------------------------------------------------------

const baseName = (path: string): string => path.replace(/\/+$/, "").split("/").pop() ?? path;
const trimSlash = (path: string): string => (path.length > 1 ? path.replace(/\/+$/, "") : path);

function fileSignals(
  graph: GraphStore,
  clock: Clock,
  state: WorkState,
  report: WorkSignalReport,
  records: FileChangeRecord[],
  offsetMinutes: number,
): void {
  const now = clock.now();
  const anchors = [...graph.anchors({ kind: "folder" }), ...graph.anchors({ kind: "file" })].filter(
    (a) => a.confirmed && graph.getEntity(a.entityId) !== undefined,
  );
  const groups = new Map<string, { anchor: GraphAnchor; at: string; paths: Set<string> }>();
  for (const r of records) {
    if (!r.owner) {
      report.untrusted++;
      continue;
    }
    const path = trimSlash(r.path);
    const hits = anchors.filter((a) => path === a.ref || path.startsWith(`${trimSlash(a.ref)}/`));
    if (hits.length === 0) {
      report.skipped++;
      continue;
    }
    // The most specific anchor wins: the assignment's folder over the course's.
    const longest = Math.max(...hits.map((a) => a.ref.length));
    const at = clampAt(r.at, now);
    for (const anchor of hits.filter((a) => a.ref.length === longest)) {
      const key = `${anchor.id}|${dayKey(at, offsetMinutes)}`;
      const g = groups.get(key) ?? { anchor, at, paths: new Set<string>() };
      if (at > g.at) g.at = at;
      g.paths.add(path);
      groups.set(key, g);
    }
  }
  for (const [key, g] of groups) {
    const all = new Set([...(state.files[key] ?? []), ...g.paths]);
    state.files[key] = [...all].slice(0, MAX_PATHS_PER_DAY);
    const n = all.size;
    const names = [...all]
      .slice(0, 3)
      .map((p) => safeName(baseName(p), 40))
      .join(", ");
    const where = safeName(baseName(g.anchor.ref), 60);
    const subject =
      g.anchor.kind === "file"
        ? where
        : `${n} ${n === 1 ? "file" : "files"} in ${where}: ${names}${n > 3 ? ", …" : ""}`;
    const prior = graph.interactionByRef("files", `work:file:${key}`);
    const at = prior !== undefined && prior.occurredAt > g.at ? prior.occurredAt : g.at;
    const pointerId = point(graph, {
      kind: "file",
      source: "files",
      externalRef: `work:file:${key}`,
      at,
      direction: "none",
      subject,
      entityId: g.anchor.entityId,
    });
    report.interactions++;
    touch(graph, g.anchor.entityId, at);
    moveStatus(graph, state, report, g.anchor.entityId, {
      trusted: true,
      cause: "activity",
      sources: [pointerId, `files:${g.anchor.ref}`],
      evidence: subject,
      at,
    });
  }
  // Keep the per-day path lists for the last few days only.
  const keep = new Set<string>();
  for (let d = 0; d < 4; d++)
    keep.add(dayKey(new Date(now - d * DAY_MS).toISOString(), offsetMinutes));
  for (const key of Object.keys(state.files)) {
    if (!keep.has(key.split("|")[1] ?? "")) delete state.files[key];
  }
}

/**
 * A granted folder whose name matches a course or project is offered as an anchor (W5): a
 * suggestion the owner confirms, or, when the owner chose "all granted folders", a rule anchor.
 * A suggestion is an unconfirmed anchor, so it routes nothing until the owner says yes.
 */
function folderSuggestions(
  graph: GraphStore,
  state: WorkState,
  report: WorkSignalReport,
  folders: FolderRecord[],
  mode: WorkSettings["anchorsFromFolders"],
): void {
  const items = graph.listEntities(["project", "assignment"]).filter(isOpenWork);
  for (const f of folders) {
    if (!f.owner) continue;
    const path = trimSlash(f.path);
    const name = baseName(path);
    const hits = items.filter((i) => workNames(graph, i).some((n) => namedIn(n, name)));
    if (hits.length !== 1) continue;
    const item = hits[0] as GraphEntity;
    const key = `${item.id}|${path}`;
    if (state.folderSuggested.includes(key)) continue;
    state.folderSuggested.push(key);
    graph.addAnchor({
      entityId: item.id,
      kind: "folder",
      ref: path,
      label: safeName(name, 120),
      addedBy: mode === "all_granted" ? "rule" : "model",
    });
    report.anchors++;
  }
  state.folderSuggested = state.folderSuggested.slice(-MAX_STATE_KEYS);
}

// --- mail on anchored threads (§3.1 Sent mail, Received mail) --------------------------------

/** Assignment, then event, then project: the most specific thing a thread is anchored to. */
const SPECIFICITY: Record<string, number> = { assignment: 3, event: 2, project: 1 };

function mailSignals(
  graph: GraphStore,
  clock: Clock,
  state: WorkState,
  report: WorkSignalReport,
  input: WorkSignalInput,
): void {
  const now = clock.now();
  const days = input.mailDays ?? 30;
  const mail = graph
    .interactionsBetween(new Date(now - days * DAY_MS).toISOString(), new Date(now).toISOString())
    .filter((i) => i.kind === "mail" && typeof i.threadKey === "string" && i.threadKey !== "");
  for (const i of mail) {
    const routed = graph
      .routeAnchor("mail_thread", i.threadKey as string)
      .map((a) => graph.getEntity(a.entityId))
      .filter((x): x is GraphEntity => x !== undefined);
    if (routed.length === 0) continue;
    const top = Math.max(...routed.map((x) => SPECIFICITY[x.kind] ?? 0));
    for (const entity of routed.filter((x) => (SPECIFICITY[x.kind] ?? 0) === top)) {
      graph.linkSubject(i.id, entity.id, "rule");
      const parent = parentOf(graph, entity.id);
      if (parent !== undefined) graph.linkSubject(i.id, parent, "rule");
      if (i.projectId == null) {
        graph.setInteractionProject(i.id, entity.kind === "project" ? entity.id : (parent ?? null));
      }
      report.interactions++;
      // Received mail is someone else's text: it is a row on the timeline, never a signal.
      if (i.direction !== "out") {
        report.untrusted++;
        continue;
      }
      const at = clampAt(i.occurredAt, now);
      touch(graph, entity.id, at);
      moveStatus(graph, state, report, entity.id, {
        trusted: true,
        cause: "activity",
        sources: [i.id, `mail:${i.threadKey}`],
        evidence: i.subject ?? "sent mail",
        at,
      });
      submittedAsk(graph, state, report, entity, i, input.attachments?.(i));
    }
  }
}

/**
 * Sent with an attachment to the assigner, or with a name that matches the item, is a
 * "submitted?" question for the owner. It is never a status change (§3.4).
 */
function submittedAsk(
  graph: GraphStore,
  state: WorkState,
  report: WorkSignalReport,
  entity: GraphEntity,
  mail: GraphInteraction,
  attachments: string[] | undefined,
): void {
  if (entity.kind !== "assignment" || attachments === undefined || attachments.length === 0) return;
  if (
    entity.workStatus == null ||
    (entity.workStatus !== "not_started" && entity.workStatus !== "in_progress")
  )
    return;
  const assigners = new Set(
    graph
      .edges(entity.id)
      .filter((e) => e.src === entity.id && e.rel === "assigned_by")
      .map((e) => e.dst),
  );
  const toAssigner = mail.participants.some((p) => p.role === "to" && assigners.has(p.entityId));
  const names = workNames(graph, entity);
  const named = [mail.subject ?? "", ...attachments].some((t) => names.some((n) => namedIn(n, t)));
  if (!toAssigner && !named) return;
  addAsk(state, report, {
    entityId: entity.id,
    claims: "submitted",
    at: mail.occurredAt,
    sources: [mail.id, `mail:${mail.threadKey}`],
    evidence: safeName(mail.subject ?? "", 200),
    origin: "sent_mail",
  });
}

// --- the pass --------------------------------------------------------------------------------

/**
 * Applies the owner's own signals to their work items. Idempotent: every pointer is keyed by its
 * source item, and state moves only on a change. Returns what happened, with the cited status
 * changes; the owner's questions are in `pendingWorkAsks`.
 */
export function runWorkSignals(
  graph: GraphStore,
  clock: Clock,
  input: WorkSignalInput,
): WorkSignalReport {
  const report = emptyReport();
  const state = loadState(graph);
  const budget = { left: MAX_NEW_PER_PASS };
  const offset = input.utcOffsetMinutes ?? 0;
  if (input.folders !== undefined)
    folderSuggestions(graph, state, report, input.folders, input.settings.anchorsFromFolders);
  if (input.reminders !== undefined)
    reminderSignals(
      graph,
      clock,
      state,
      report,
      input.reminders,
      input.settings.trackedLists,
      budget,
    );
  if (input.events !== undefined)
    calendarSignals(graph, clock, state, report, input.events, budget);
  if (input.files !== undefined) fileSignals(graph, clock, state, report, input.files, offset);
  mailSignals(graph, clock, state, report, input);
  settleAsks(graph, state);
  graph.setCursor(STATE_KEY, state);
  return report;
}
