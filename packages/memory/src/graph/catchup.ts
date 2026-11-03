import type {
  CatchUpAction,
  CatchUpChange,
  CatchUpItem,
  CatchUpResume,
  CatchUpStatus,
  CatchUpUrgency,
  GraphCitationSource,
  GraphEntity,
  GraphFactAttribute,
  GraphTimelineRow,
  GraphWorkStatus,
  MemorySurface,
  MemorySurfacesSettings,
  Provenance,
} from "@psyche/protocol";
import { safeName } from "./clean.ts";
import type { GraphStore } from "./store.ts";
import { type SurfaceItem, surfaceFilter } from "./surfaces.ts";
import {
  isBlocked,
  isClosed,
  isFactStale,
  isOverdue,
  isStale,
  isWorkKind,
  pastDuePhase,
  type WorkSnapshot,
} from "./work.ts";

/**
 * Catching up (docs/design/memory-everything-2026.md §5): the few work items that matter today,
 * ranked, limited and written from fixed templates. `rankCatchUp` is a pure function with no I/O
 * and no model, like `nudges.ts`; `gatherCandidates` is the thin reader that turns the store into
 * its input. Titles and mail subjects are inserted only as quoted, cleaned data.
 */

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

// --- ranking (§5.2) ----------------------------------------------------------------------------

/** overdue 1.0, due within 24 h 0.9, 3 d 0.7, 7 d 0.4, 14 d 0.15, no date 0. */
export function urgencyScore(dueAt: string | null, now: number): number {
  const due = dueAt === null ? Number.NaN : Date.parse(dueAt);
  if (Number.isNaN(due)) return 0;
  const ahead = due - now;
  if (ahead < 0) return 1;
  if (ahead <= DAY_MS) return 0.9;
  if (ahead <= 3 * DAY_MS) return 0.7;
  if (ahead <= 7 * DAY_MS) return 0.4;
  if (ahead <= 14 * DAY_MS) return 0.15;
  return 0;
}

export function urgencyLabel(dueAt: string | null, now: number): CatchUpUrgency {
  const due = dueAt === null ? Number.NaN : Date.parse(dueAt);
  if (Number.isNaN(due)) return "none";
  const ahead = due - now;
  if (ahead < 0) return "overdue";
  if (ahead <= DAY_MS) return "today";
  if (ahead <= 3 * DAY_MS) return "soon";
  return "later";
}

/** Due soon and not begun ranks first. */
export const STATUS_GAP = { not_started: 1, in_progress: 0.5, blocked: 0.8 } as const;
export type GapStatus = keyof typeof STATUS_GAP;

export const CHANGE_STEP = 0.2;
export const CHANGE_CAP = 0.4;
export const MOMENTUM_SCORE = 0.15;
export const MOMENTUM_HOURS = 48;
export const PINNED_SCORE = 0.3;

export interface ScoreInput {
  urgency: number;
  status: GapStatus;
  /** New accepted signals since the owner last looked. */
  newSignals: number;
  /** Worked on in the last 48 hours and not done. */
  momentum: boolean;
  pinned: boolean;
}

/** `gap + change + momentum + pinned`, with `gap = urgency x status`. */
export function scoreOf(i: ScoreInput): number {
  const gap = i.urgency * STATUS_GAP[i.status];
  const change = Math.min(CHANGE_CAP, CHANGE_STEP * i.newSignals);
  const score = gap + change + (i.momentum ? MOMENTUM_SCORE : 0) + (i.pinned ? PINNED_SCORE : 0);
  return Math.round(score * 1e6) / 1e6;
}

// --- limits (§5.3) -----------------------------------------------------------------------------

export const CATCHUP_LIMITS = {
  /** Lines in the brief's "Catching up" and the wrap-up's "Worked on today". */
  brief: 5,
  home: 3,
  worked: 5,
  /** Characters per line. */
  lineChars: 140,
  /** Per project, unless two are due within this many hours. */
  perProject: 1,
  perProjectDueWithinHours: 48,
  /** Changes carried on one item. */
  changes: 2,
} as const;

export type CatchUpSurface = MemorySurface;

const limitFor = (surface: CatchUpSurface): number =>
  surface === "home" ? CATCHUP_LIMITS.home : CATCHUP_LIMITS.brief;

// --- input -------------------------------------------------------------------------------------

/** One thing that happened to an item, already turned into template text. */
export interface WorkSignal {
  id: string;
  at: string;
  /** Template text: titles and subjects are quoted, cleaned data. */
  text: string;
  kind: "mail" | "file" | "chat" | "note" | "reminder" | "work" | "fact";
  /** Facts only. */
  attribute?: GraphFactAttribute;
  /** Facts only: the value before this one. */
  from?: string | null;
  to?: string;
  source: GraphCitationSource;
  provenance: Provenance;
  citationId: string | null;
  /** Mail subjects ride the work-mail tier; everything else is work (W2). */
  tier: "work" | "workMail";
}

export interface CatchUpCandidate extends SurfaceItem {
  tier: "work";
  entityId: string;
  kind: "project" | "assignment" | "event";
  title: string;
  /** `untrusted` when any part of the item came from third-party text. */
  titleProvenance: Provenance;
  parent?: { id: string; name: string };
  dueAt: string | null;
  /** Assignments: the stored status. Projects: `active` or `paused`. */
  workStatus: GraphWorkStatus | null;
  projectStatus: "active" | "paused" | "done" | null;
  statusAsOf: string;
  statusProvenance: Provenance;
  lastSignalAt: string | null;
  pinned: boolean;
  blocked: boolean;
  /** When the owner last looked (opened the line, acted on it, read the brief). */
  seenAt: string | null;
  snoozedUntil: string | null;
  /** Accepted signals, newest first. A pending suggestion is never one. */
  signals: readonly WorkSignal[];
  /** The latest time the owner or a Psyche run worked on it. */
  workedAt: string | null;
  stoppedAt?: { text: string; at: string; provenance: Provenance };
  opener?: { kind: CatchUpResume["open"]["kind"]; ref: string; text: string; at: string };
}

export interface RankOptions {
  now: number;
  timeZone?: string;
  surface: CatchUpSurface;
  settings: MemorySurfacesSettings;
  limit?: number;
}

export interface RankedLine {
  item: CatchUpItem;
  candidate: CatchUpCandidate;
  score: number;
  /** The past-due ask: "Did you finish ...?" */
  ask: boolean;
  /** The changes that survived the surface filter. */
  changes: WorkSignal[];
}

// --- time helpers ------------------------------------------------------------------------------

function parts(ms: number, tz: string): { y: number; m: number; d: number } {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(ms));
  const get = (t: string) => Number(p.find((x) => x.type === t)?.value);
  return { y: get("year"), m: get("month"), d: get("day") };
}

const dayIndex = (ms: number, tz: string): number => {
  const p = parts(ms, tz);
  return Math.round(Date.UTC(p.y, p.m - 1, p.d) / DAY_MS);
};

/** Minutes east of UTC at `ms` in `tz`. */
export function offsetMinutes(ms: number, tz: string): number {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(ms));
  const get = (t: string) => Number(p.find((x) => x.type === t)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), 0);
  return Math.round((asUtc - Math.floor(ms / 60_000) * 60_000) / 60_000);
}

/** The start of the owner's local day containing `ms`. */
export function startOfDay(ms: number, tz: string): number {
  const p = parts(ms, tz);
  const guess = Date.UTC(p.y, p.m - 1, p.d);
  return guess - offsetMinutes(guess, tz) * 60_000;
}

const WEEKDAY = (tz: string) =>
  new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: tz });
const MONTH_DAY = (tz: string) =>
  new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: tz });

/** "today", "tomorrow", "Thu" within the week, otherwise "Nov 9". */
export function whenText(dueAt: string, now: number, tz: string): string {
  const due = Date.parse(dueAt);
  const away = dayIndex(due, tz) - dayIndex(now, tz);
  if (away === 0) return "today";
  if (away === 1) return "tomorrow";
  if (away === -1) return "yesterday";
  if (away > 1 && away < 7) return WEEKDAY(tz).format(due);
  return MONTH_DAY(tz).format(due);
}

// --- text --------------------------------------------------------------------------------------

/** Control and zero-width characters out, whitespace folded, length capped. */
export const clean = (text: string, max: number): string => safeName(text, max);

const quoted = (text: string): string => `“${text}”`;

const SOURCE_WORD: Record<GraphCitationSource, string> = {
  mail: "mail",
  messages: "Messages",
  notes: "your note",
  calendar: "Calendar",
  reminders: "Reminders",
  chats: "your chat",
  files: "your files",
  browser: "the browser",
  transcripts: "a transcript",
  contacts: "Contacts",
};

const RANK: Record<Provenance, number> = { untrusted: 0, agent: 1, system: 2, owner: 3 };

/** The lowest provenance of the parts: any untrusted part makes the whole item untrusted. */
export function lowestProvenance(parts: readonly Provenance[]): Provenance {
  let low: Provenance = "owner";
  for (const p of parts) if (RANK[p] < RANK[low]) low = p;
  return low;
}

function prefixOf(c: CatchUpCandidate): string {
  return c.parent === undefined ? "" : `${clean(c.parent.name, 40)} · `;
}

function titleText(c: CatchUpCandidate): string {
  const t = clean(c.title, 80);
  return c.titleProvenance === "untrusted" ? quoted(t) : t;
}

const STATUS_TEXT: Record<string, string> = {
  not_started: "not started",
  in_progress: "in progress",
  blocked: "blocked",
  overdue: "overdue",
  active: "in progress",
  paused: "paused",
};

/** "Sam: “Updated numbers attached” (Mon)": a mail change, as data. */
export function mailChangeText(sender: string | undefined, subject: string, day: string): string {
  const who = sender === undefined || sender === "" ? "" : `${clean(sender, 40)}: `;
  return `${who}${quoted(clean(subject, 80))} (${day})`;
}

/** Joins `base` with whichever optional parts still fit under the line limit. */
function fit(base: string, extras: readonly string[]): string {
  const max = CATCHUP_LIMITS.lineChars;
  let line = base.length > max ? `${base.slice(0, max - 1).trimEnd()}…` : base;
  for (const extra of extras) {
    if (extra === "") continue;
    if (line.length + 1 + extra.length <= max) line = `${line} ${extra}`;
  }
  return line;
}

/** The fixed templates of §5.3. */
export function lineFor(input: {
  c: CatchUpCandidate;
  now: number;
  tz: string;
  ask: boolean;
  status: string;
  stale: boolean;
  /** The one change to show in the line, if any. */
  change?: WorkSignal;
  /** The resume sentence's content: where the owner stopped. */
  resume?: string;
}): string {
  const { c, now, tz } = input;
  const lead = `${prefixOf(c)}${titleText(c)}`;
  if (input.ask) {
    const when = c.dueAt === null ? "" : ` It was due ${whenText(c.dueAt, now, tz)}.`;
    return fit(`${prefixOf(c)}Did you finish ${titleText(c)}?${when}`, []);
  }
  const moved = input.change?.attribute === "deadline" && input.change.from != null;
  if (moved && input.change?.to !== undefined) {
    const date = MONTH_DAY(tz).format(Date.parse(input.change.to));
    return fit(`${lead}: due date moved to ${date} (${SOURCE_WORD[input.change.source]}).`, []);
  }
  const state = STATUS_TEXT[input.status] ?? input.status;
  const asOf = input.stale ? `, as of ${WEEKDAY(tz).format(Date.parse(c.statusAsOf))}` : "";
  const base =
    c.dueAt === null
      ? `${lead}: ${state}${asOf}.`
      : `${lead}: due ${whenText(c.dueAt, now, tz)}, ${state}${asOf}.`;
  return fit(base, [
    input.resume === undefined ? "" : `You stopped at ${clean(input.resume, 60)}.`,
    input.change === undefined ? "" : `New: ${clean(input.change.text, 80)}`,
  ]);
}

// --- ranking -----------------------------------------------------------------------------------

function snapshotOf(c: CatchUpCandidate): WorkSnapshot {
  return {
    kind: c.kind,
    workStatus: c.workStatus,
    projectStatus: c.projectStatus,
    dueAt: c.dueAt,
    lastSignalAt: c.lastSignalAt,
  };
}

const HANDED_IN: ReadonlySet<string> = new Set(["submitted", "done", "dropped"]);

/** Done, submitted, dropped, or a project that is paused or done: nothing to catch up on. */
function isOpen(c: CatchUpCandidate): boolean {
  if (c.workStatus !== null && HANDED_IN.has(c.workStatus)) return false;
  if (c.kind === "project" && c.projectStatus !== null && c.projectStatus !== "active")
    return false;
  return !isClosed(snapshotOf(c));
}

const ms = (iso: string | null): number | null => {
  if (iso === null) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
};

function gapStatus(c: CatchUpCandidate): GapStatus {
  if (c.blocked) return "blocked";
  if (c.kind === "assignment")
    return c.workStatus === "in_progress" ? "in_progress" : "not_started";
  // A project is already under way; an event is something to be ready for, not to start.
  return c.kind === "project" ? "in_progress" : "not_started";
}

/** What a stored or computed state is called in a `CatchUpItem`. */
function itemStatus(c: CatchUpCandidate, overdue: boolean): CatchUpStatus {
  if (overdue) return "overdue";
  if (c.blocked) return "blocked";
  if (c.kind === "assignment") return c.workStatus ?? "not_started";
  if (c.kind === "project") return c.projectStatus === "paused" ? "paused" : "active";
  return "active";
}

/** Signals the owner has not seen, after the surface switches (work mail may be off). */
function visibleSignals(
  c: CatchUpCandidate,
  surface: CatchUpSurface,
  settings: MemorySurfacesSettings,
): WorkSignal[] {
  return surfaceFilter(
    c.signals.map((signal) => ({ signal, tier: signal.tier, sources: [signal.source] })),
    surface,
    settings,
  ).map((x) => x.signal);
}

/** Two lines for one project are allowed only when both are due within 48 hours. */
function dueSoonEnough(c: CatchUpCandidate, now: number): boolean {
  const due = ms(c.dueAt);
  return due !== null && due - now <= CATCHUP_LIMITS.perProjectDueWithinHours * HOUR_MS;
}

/**
 * Ranks the open items, applies the §5.3 limits and writes the lines. Pure: the caller passes the
 * clock and the owner's surface settings. Excluded: done, submitted, dropped, snoozed (until the
 * snooze ends), private, anything the surface filter removes and past-due asks that went quiet.
 */
export function rankCatchUp(
  candidates: readonly CatchUpCandidate[],
  opts: RankOptions,
): RankedLine[] {
  const { now, surface, settings } = opts;
  const tz = opts.timeZone ?? "UTC";
  const offset = offsetMinutes(now, tz);
  const allowed = surfaceFilter(candidates, surface, settings);

  const scored: RankedLine[] = [];
  for (const c of allowed) {
    if (!isOpen(c)) continue;
    const snooze = ms(c.snoozedUntil);
    if (snooze !== null && snooze > now) continue;
    const snap = snapshotOf(c);
    const due = ms(c.dueAt);
    // An event is not overdue and not an ask: once it is behind us there is nothing to do.
    if (c.kind === "event" && due !== null && due < now) continue;
    const phase = pastDuePhase(snap, now, offset);
    if (phase === "quiet") continue;
    const ask = phase === "ask";
    const overdue = isOverdue(snap, now) || (c.kind === "project" && due !== null && due < now);

    const seen = ms(c.seenAt);
    const changes = visibleSignals(c, surface, settings).filter(
      (s) => seen === null || Date.parse(s.at) > seen,
    );
    const worked = ms(c.workedAt);
    const momentum = worked !== null && now - worked <= MOMENTUM_HOURS * HOUR_MS;
    const score = scoreOf({
      urgency: urgencyScore(c.dueAt, now),
      status: gapStatus(c),
      newSignals: changes.length,
      momentum,
      pinned: c.pinned,
    });
    if (score <= 0 && !ask) continue;

    const status = itemStatus(c, overdue);
    const stale = isStale(snap, now);
    const shown = changes.slice(0, CATCHUP_LIMITS.changes);
    // The line carries a change the owner did not make themselves, or a moved deadline.
    const lineChange = changes.find(
      (s) => s.provenance === "untrusted" || (s.attribute === "deadline" && s.from != null),
    );
    const changeOut: CatchUpChange[] = shown.map((s) => ({
      text: clean(s.text, 200),
      at: s.at,
      source: s.source,
      provenance: s.provenance,
      citationId: s.citationId,
    }));
    const item: CatchUpItem = {
      entityId: c.entityId,
      kind: c.kind,
      title: clean(c.title, 200),
      titleProvenance: c.titleProvenance,
      ...(c.parent === undefined ? {} : { parent: { id: c.parent.id, name: c.parent.name } }),
      ...(c.dueAt === null ? {} : { dueAt: c.dueAt }),
      urgency: urgencyLabel(c.dueAt, now),
      status,
      statusAsOf: c.statusAsOf,
      stale,
      line: "",
      changes: changeOut,
      actions: actionsFor(c, ask),
      provenance: lowestProvenance([
        c.titleProvenance,
        c.statusProvenance,
        ...shown.map((s) => s.provenance),
      ]),
    };
    item.line = lineFor({
      c,
      now,
      tz,
      ask,
      status,
      stale,
      ...(lineChange === undefined ? {} : { change: lineChange }),
    });
    scored.push({ item, candidate: c, score, ask, changes });
  }

  // The ask needs the owner, so it leads; then by score, then the nearest date, then id.
  scored.sort(
    (a, b) =>
      Number(b.ask) - Number(a.ask) ||
      b.score - a.score ||
      (ms(a.candidate.dueAt) ?? Number.POSITIVE_INFINITY) -
        (ms(b.candidate.dueAt) ?? Number.POSITIVE_INFINITY) ||
      a.candidate.entityId.localeCompare(b.candidate.entityId),
  );

  const limit = Math.max(1, Math.min(opts.limit ?? limitFor(surface), 10));
  const kept: RankedLine[] = [];
  const perProject = new Map<string, RankedLine[]>();
  for (const line of scored) {
    if (kept.length >= limit) break;
    const key = line.candidate.parent?.id ?? line.candidate.entityId;
    const have = perProject.get(key) ?? [];
    if (have.length >= CATCHUP_LIMITS.perProject) {
      // A second line for one project only when both are due within 48 hours.
      const both = [...have, line].every((l) => dueSoonEnough(l.candidate, now));
      if (!both || have.length >= 2) continue;
    }
    have.push(line);
    perProject.set(key, have);
    kept.push(line);
  }

  // At most one resume line: the top momentum item among those shown.
  const resumeFrom = kept
    .filter((l) => !l.ask && momentumOf(l.candidate, now))
    .sort((a, b) => (ms(b.candidate.workedAt) ?? 0) - (ms(a.candidate.workedAt) ?? 0))[0];
  if (resumeFrom !== undefined) applyResume(resumeFrom, now, tz);
  return kept;
}

function momentumOf(c: CatchUpCandidate, now: number): boolean {
  const worked = ms(c.workedAt);
  return worked !== null && now - worked <= MOMENTUM_HOURS * HOUR_MS && isOpen(c);
}

/** `stopped_at` (fresh: 14 days) and the thing that opens where the owner was working. */
function applyResume(line: RankedLine, now: number, tz: string): void {
  const c = line.candidate;
  const stopped =
    c.stoppedAt !== undefined && !isFactStale(c.stoppedAt.at, now) ? c.stoppedAt : undefined;
  const text = stopped?.text ?? c.opener?.text;
  if (text === undefined) return;
  if (c.opener !== undefined) {
    line.item.resume = {
      text: clean(text, 200),
      at: stopped?.at ?? c.opener.at,
      open: { kind: c.opener.kind, ref: c.opener.ref.slice(0, 1024) },
    };
  }
  const lineChange = line.changes.find(
    (s) => s.provenance === "untrusted" || (s.attribute === "deadline" && s.from != null),
  );
  line.item.line = lineFor({
    c,
    now,
    tz,
    ask: line.ask,
    status: line.item.status,
    stale: line.item.stale,
    ...(lineChange === undefined ? {} : { change: lineChange }),
    resume: text,
  });
  if (stopped !== undefined)
    line.item.provenance = lowestProvenance([line.item.provenance, stopped.provenance]);
}

function actionsFor(c: CatchUpCandidate, ask: boolean): CatchUpAction[] {
  if (ask) return ["open", "done", "snooze"];
  if (c.kind === "event") return ["open", "snooze"];
  return ["open", "continue", "done", "snooze"];
}

// --- pending, counted only ---------------------------------------------------------------------

export function pendingText(assignments: number, courses: number): string | undefined {
  const n = assignments + courses;
  if (n === 0) return undefined;
  if (courses === 0) return `${n} new assignment${n === 1 ? "" : "s"} to confirm`;
  if (assignments === 0) return `${n} new course${n === 1 ? "" : "s"} to confirm`;
  return `${n} new items to confirm`;
}

// --- the wrap-up: "Worked on today" ------------------------------------------------------------

const WORKED_LABEL: Partial<Record<WorkSignal["kind"], string>> = {
  file: "edited files",
  chat: "chatted with Psyche",
  note: "wrote a note",
  reminder: "updated a reminder",
  work: "Psyche worked on it",
};

export interface WorkedLine {
  entityId: string;
  title: string;
  text: string;
  provenance: Provenance;
}

/**
 * "Worked on today" from the day's signals: only the owner's and Psyche's own work counts (not a
 * due date edit, not mail from someone else). At most 5 lines of 140 characters, most active
 * first. Done items belong here: finishing something is working on it.
 */
export function workedOnToday(
  candidates: readonly CatchUpCandidate[],
  opts: {
    now: number;
    timeZone?: string;
    surface: CatchUpSurface;
    settings: MemorySurfacesSettings;
    limit?: number;
  },
): WorkedLine[] {
  const tz = opts.timeZone ?? "UTC";
  const from = startOfDay(opts.now, tz);
  const out: { line: WorkedLine; n: number; last: number }[] = [];
  for (const c of surfaceFilter(candidates, opts.surface, opts.settings)) {
    const today = visibleSignals(c, opts.surface, opts.settings).filter((s) => {
      const t = Date.parse(s.at);
      if (t < from || t > opts.now) return false;
      if (s.provenance === "untrusted") return false;
      if (s.kind === "mail") return s.provenance === "owner";
      if (s.kind === "fact")
        return (
          s.attribute === "progress" || s.attribute === "stopped_at" || s.attribute === "next_step"
        );
      return true;
    });
    if (today.length === 0) continue;
    const labels: string[] = [];
    for (const s of today) {
      const label =
        s.kind === "fact"
          ? s.attribute === "stopped_at"
            ? `stopped at ${clean(s.to ?? "", 40)}`
            : s.attribute === "progress"
              ? `progress: ${clean(s.to ?? "", 40)}`
              : `next: ${clean(s.to ?? "", 40)}`
          : s.kind === "mail"
            ? "sent mail"
            : WORKED_LABEL[s.kind];
      if (label !== undefined && !labels.includes(label)) labels.push(label);
    }
    const lead = `${prefixOf(c)}${titleText(c)}: `;
    const text = fit(`${lead}${labels.join(", ")}.`, []);
    out.push({
      line: {
        entityId: c.entityId,
        title: clean(c.title, 200),
        text,
        provenance: lowestProvenance([c.titleProvenance, ...today.map((s) => s.provenance)]),
      },
      n: today.length,
      last: Math.max(...today.map((s) => Date.parse(s.at))),
    });
  }
  out.sort(
    (a, b) => b.n - a.n || b.last - a.last || a.line.entityId.localeCompare(b.line.entityId),
  );
  return out.slice(0, Math.min(opts.limit ?? CATCHUP_LIMITS.worked, 10)).map((x) => x.line);
}

// --- due-soon notifications (§5.4, W4) ---------------------------------------------------------

export interface DueNotice {
  title: string;
  body: string;
  count: number;
  /** Whether the body names the items (only when every title is the owner's own). */
  titled: boolean;
}

const LISTED_TITLES = 3;

/**
 * "2 things due tomorrow: Lecture Work 7, Q3 deck." For items due in the next `hours`, or, for the
 * morning message, due before the day ends. Titles appear only when every one of them is the
 * owner's own words; otherwise the text is a count ("1 assignment due tomorrow"), because a
 * title from mail is third-party text on a lock screen (§4).
 */
export function dueNotice(
  candidates: readonly CatchUpCandidate[],
  opts: {
    now: number;
    timeZone?: string;
    settings: MemorySurfacesSettings;
    mode: "wrapup" | "dayOf";
    hours?: number;
  },
): DueNotice | undefined {
  const tz = opts.timeZone ?? "UTC";
  const until =
    opts.mode === "dayOf"
      ? startOfDay(opts.now, tz) + DAY_MS
      : opts.now + (opts.hours ?? 24) * HOUR_MS;
  const due = surfaceFilter(candidates, "notification", opts.settings)
    .filter((c) => {
      if (!isOpen(c)) return false;
      const t = ms(c.dueAt);
      if (t === null || t < opts.now || t > until) return false;
      const snooze = ms(c.snoozedUntil);
      return snooze === null || snooze <= opts.now;
    })
    .sort((a, b) => (ms(a.dueAt) as number) - (ms(b.dueAt) as number));
  if (due.length === 0) return undefined;
  const when = opts.mode === "dayOf" ? "today" : "tomorrow";
  const titled = due.every((c) => c.titleProvenance === "owner");
  const n = due.length;
  const noun = due.every((c) => c.kind === "assignment")
    ? n === 1
      ? "assignment"
      : "assignments"
    : n === 1
      ? "thing"
      : "things";
  let body: string;
  if (titled) {
    const names = due.slice(0, LISTED_TITLES).map((c) => clean(c.title, 40));
    const more = n > LISTED_TITLES ? ` and ${n - LISTED_TITLES} more` : "";
    body = `${n} ${noun} due ${when}: ${names.join(", ")}${more}.`;
  } else {
    body = `${n} ${noun} due ${when}`;
  }
  return { title: opts.mode === "dayOf" ? "Due today" : "Due soon", body, count: n, titled };
}

// --- reading the store -------------------------------------------------------------------------

/** What the owner did to a line: when they last looked, and until when it is snoozed. */
export interface CatchUpMark {
  seenAt?: string;
  snoozedUntil?: string;
}

interface StateDoc {
  marks: Record<string, CatchUpMark>;
  notified: Record<string, string>;
}

const STATE_CURSOR = "catchup.state";

/** Per-item `seen_at` and snooze, plus the day each notification last went out. */
export class CatchUpState {
  readonly #graph: GraphStore;

  constructor(graph: GraphStore) {
    this.#graph = graph;
  }

  #read(): StateDoc {
    const v = this.#graph.cursor(STATE_CURSOR) as Partial<StateDoc> | null | undefined;
    return { marks: v?.marks ?? {}, notified: v?.notified ?? {} };
  }

  get(id: string): CatchUpMark {
    return this.#read().marks[id] ?? {};
  }

  /** Marks work items as looked at; returns how many were updated. */
  markSeen(ids: readonly string[], at: string): number {
    const doc = this.#read();
    let n = 0;
    for (const raw of new Set(ids)) {
      const id = this.#graph.resolveMerged(raw);
      const e = this.#graph.getEntity(id);
      if (e === undefined || !isWorkKind(e.kind)) continue;
      doc.marks[id] = { ...doc.marks[id], seenAt: at };
      n++;
    }
    if (n > 0) this.#write(doc);
    return n;
  }

  /** Hides the line until `until`, and counts as having looked at it. */
  snooze(id: string, until: string, seenAt: string): void {
    const doc = this.#read();
    doc.marks[id] = { ...doc.marks[id], snoozedUntil: until, seenAt };
    this.#write(doc);
  }

  /** Acting on a line counts as having seen it. */
  touch(id: string, at: string): void {
    const doc = this.#read();
    doc.marks[id] = { ...doc.marks[id], seenAt: at };
    this.#write(doc);
  }

  lastNotified(kind: "wrapup" | "dayOf"): string | undefined {
    return this.#read().notified[kind];
  }

  setNotified(kind: "wrapup" | "dayOf", day: string): void {
    const doc = this.#read();
    doc.notified[kind] = day;
    this.#write(doc);
  }

  #write(doc: StateDoc): void {
    // Forgotten items leave their marks behind otherwise.
    for (const id of Object.keys(doc.marks)) {
      if (this.#graph.getEntity(id) === undefined) delete doc.marks[id];
    }
    this.#graph.setCursor(STATE_CURSOR, doc);
  }
}

const OPENER_KIND: Partial<Record<WorkSignal["kind"], CatchUpResume["open"]["kind"]>> = {
  file: "file",
  chat: "chat",
};

const INTERACTION_SIGNAL: Record<string, WorkSignal["kind"] | undefined> = {
  mail: "mail",
  file: "file",
  chat: "chat",
  note: "note",
  reminder: "reminder",
  work: "work",
  task: "work",
};

const OWN_WORK: ReadonlySet<WorkSignal["kind"]> = new Set([
  "file",
  "chat",
  "note",
  "reminder",
  "work",
]);
const PROGRESS_FACTS: ReadonlySet<string> = new Set(["progress", "stopped_at", "next_step"]);

const weekday = (iso: string, tz: string): string => WEEKDAY(tz).format(Date.parse(iso));

/**
 * Turns timeline rows into signals. People never come through here: loops (who owes whom), text
 * messages and calls, and the gist of a chat are left out, and mail only counts when it is tied
 * to this item by the owner or a rule (W2).
 */
function signalsOf(
  graph: GraphStore,
  entityId: string,
  rows: readonly GraphTimelineRow[],
  tz: string,
): WorkSignal[] {
  const out: WorkSignal[] = [];
  for (const r of rows) {
    if (r.entityId !== entityId || r.kind === "loop") continue;
    if (r.kind === "fact") {
      out.push({
        id: r.id,
        at: r.at,
        text: r.text,
        kind: "fact",
        ...(r.change === undefined
          ? {}
          : { attribute: r.change.attribute, from: r.change.from, to: r.change.to }),
        source: r.chip?.source ?? "chats",
        provenance: r.provenance,
        citationId: r.chip?.citationId ?? null,
        tier: "work",
      });
      continue;
    }
    const kind =
      r.interactionKind === undefined ? undefined : INTERACTION_SIGNAL[r.interactionKind];
    if (kind === undefined) continue;
    if (kind === "mail") {
      const tied = graph
        .subjectsOf(r.id)
        .some((s) => s.entityId === entityId && s.linkedBy !== "model");
      if (!tied) continue;
      const subject = graph.interaction(r.id)?.subject ?? "";
      out.push({
        id: r.id,
        at: r.at,
        text: mailChangeText(r.chip?.label, subject, weekday(r.at, tz)),
        kind,
        source: "mail",
        provenance: r.provenance,
        citationId: r.chip?.citationId ?? null,
        tier: "workMail",
      });
      continue;
    }
    out.push({
      id: r.id,
      at: r.at,
      // A chat's gist is a conversation summary: it never rides along.
      text: kind === "chat" ? "Chat with Psyche about this" : r.text,
      kind,
      source: r.chip?.source ?? "chats",
      provenance: r.provenance,
      citationId: r.chip?.citationId ?? null,
      tier: "work",
    });
  }
  return out;
}

function latest<T>(items: readonly T[], at: (t: T) => string): T | undefined {
  let best: T | undefined;
  for (const x of items) if (best === undefined || at(x) > at(best)) best = x;
  return best;
}

/**
 * Reads the open work items and what happened to them. Accepted rows only: the store's own
 * readers already skip pending, discarded and quarantined facts, and a suggestion is not an
 * entity until the owner confirms it.
 */
export function gatherCandidates(
  graph: GraphStore,
  state: CatchUpState,
  opts: { now: number; timeZone?: string },
): CatchUpCandidate[] {
  const tz = opts.timeZone ?? "UTC";
  const entities = graph.listEntities(["project", "assignment", "event"]);
  const out: CatchUpCandidate[] = [];
  for (const e of entities) {
    if (e.hidden || e.status !== "active") continue;
    if (e.kind === "project" && e.projectType === "course") continue;
    const links = graph
      .edges(e.id)
      .filter((x) => x.rel === "part_of" && x.src === e.id)
      .map((x) => graph.getEntity(x.dst))
      .filter((p): p is GraphEntity => p !== undefined && p.kind === "project");
    const parentEntity = links[0];
    // A life event ("Ava's party") is the people tier. Only an event inside a project or course
    // is work.
    if (e.kind === "event" && parentEntity === undefined) continue;
    // The assignments of a private course are private with it: the line would name the course.
    if (parentEntity?.private === true) continue;

    const facts = graph.facts(e.id);
    const pick = (a: GraphFactAttribute) => facts.find((f) => f.attribute === a);
    const status = pick("status");
    const stopped = pick("stopped_at");
    const blockedOn = pick("blocked_on");
    const deadline = pick("deadline");
    const timeline = graph.timeline(e.id, { limit: 60 }).rows;
    const signals = signalsOf(graph, e.id, timeline, tz);
    const mark = state.get(e.id);

    const worked = latest(
      signals.filter(
        (s) =>
          (s.provenance === "owner" || s.provenance === "agent") &&
          (OWN_WORK.has(s.kind) ||
            (s.kind === "mail" && s.provenance === "owner") ||
            (s.kind === "fact" && s.attribute !== undefined && PROGRESS_FACTS.has(s.attribute))),
      ),
      (s) => s.at,
    );
    const openerSignal = latest(
      signals.filter((s) => OPENER_KIND[s.kind] !== undefined),
      (s) => s.at,
    );
    const opener =
      openerSignal === undefined
        ? undefined
        : (() => {
            const i = graph.interaction(openerSignal.id);
            return {
              kind: OPENER_KIND[openerSignal.kind] as CatchUpResume["open"]["kind"],
              ref: i?.link ?? i?.subject ?? openerSignal.id,
              text: openerSignal.text,
              at: openerSignal.at,
            };
          })();

    const waiting = graph.loops({
      status: ["open"],
      direction: "waiting_on",
      projectId: e.id,
      limit: 1,
    }).length;
    const untrustedFact = facts.some(
      (f) =>
        f.provenance === "untrusted" &&
        (f.attribute === "deadline" || f.attribute === "status" || f.attribute === "progress"),
    );
    const deadlineRow = timeline.find(
      (r) => r.kind === "fact" && r.change?.attribute === "deadline" && r.entityId === e.id,
    );
    const candidate: CatchUpCandidate = {
      tier: "work",
      kind: e.kind as CatchUpCandidate["kind"],
      entityId: e.id,
      title: e.name,
      titleProvenance: untrustedFact ? "untrusted" : "owner",
      ...(parentEntity === undefined
        ? {}
        : { parent: { id: parentEntity.id, name: parentEntity.name } }),
      dueAt: e.dueAt ?? deadline?.value ?? null,
      workStatus: e.kind === "assignment" ? (e.workStatus ?? "not_started") : null,
      projectStatus: e.kind === "project" ? (e.projectStatus ?? "active") : null,
      statusAsOf: status?.recordedAt ?? e.lastSignalAt ?? e.createdAt,
      statusProvenance: status?.provenance ?? "owner",
      lastSignalAt: e.lastSignalAt ?? null,
      pinned: e.pinned,
      blocked: isBlocked({ openWaitingLoops: waiting, blockedOn: blockedOn?.value ?? null }),
      seenAt: mark.seenAt ?? e.createdAt,
      snoozedUntil: mark.snoozedUntil ?? null,
      signals,
      workedAt: worked?.at ?? null,
      ...(stopped === undefined
        ? {}
        : {
            stoppedAt: {
              text: clean(stopped.value, 120),
              at: stopped.recordedAt,
              provenance: stopped.provenance,
            },
          }),
      ...(opener === undefined ? {} : { opener }),
      // Keep private, and the per-source veto: a due date learned from Messages goes with it.
      ...(e.private === true ? { private: true } : {}),
      ...(deadlineRow?.chip == null ? {} : { sources: [deadlineRow.chip.source] }),
    };
    out.push(candidate);
  }
  return out;
}

/** Work suggestions waiting for the owner: counted, never listed. */
export function pendingCounts(graph: GraphStore): { assignments: number; courses: number } {
  let assignments = 0;
  let courses = 0;
  for (const s of graph.suggestions(["pending"])) {
    if (s.kind === "assignment") assignments++;
    else if (s.kind === "project" && s.projectType === "course") courses++;
  }
  return { assignments, courses };
}
