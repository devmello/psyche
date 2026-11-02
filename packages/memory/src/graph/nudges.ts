import type { GraphEntity, GraphInteraction, GraphLoop } from "@psyche/protocol";
import { detectSensitive, looksLikeInstruction } from "../filters.ts";
import { safeName } from "./clean.ts";
import { sha256 } from "./normalize.ts";
import { buildStarters, type NudgeStarter } from "./starters.ts";
import type { GraphStore } from "./store.ts";
import { describeUpcoming, upcoming } from "./upcoming.ts";

export { safeName } from "./clean.ts";

/**
 * Relationship nudges (docs/design/relationship-nudges-2026.md): people you owe a reply, are
 * drifting from, have a birthday coming, or made a promise to. Deterministic: timestamps from
 * the people graph, accepted non-sensitive facts and your own loops. No model, no message text.
 * A nudge sentence is a name, a number of days and a fixed template.
 */

export type NudgeKind = "unanswered" | "drift" | "birthday" | "promise";
export type NudgeSensitivity = "low" | "normal" | "high";
export type NudgeChannel = "mail" | "messages";

export interface Nudge {
  /** Stable for what it is about (the message, the last contact day, the date, the loop). */
  id: string;
  kind: NudgeKind;
  entityId: string;
  name: string;
  /** One plain sentence built from the name, numbers and a template. */
  text: string;
  /** Higher first. */
  priority: number;
  daysAgo: number | null;
  channel: NudgeChannel | null;
  /** Birthdays: the day it falls on (`YYYY-MM-DD`). */
  date: string | null;
  /** Promises: the loop, so "Done" can close it. */
  loopId: string | null;
  /** A promise past its due date: the one amber "needs you" case. */
  overdue: boolean;
  /** Up to three things to bring up, each with where it comes from; empty when little is known. */
  starters: NudgeStarter[];
}

export interface NudgeOptions {
  now: number;
  timeZone?: string;
  sensitivity?: NudgeSensitivity;
  /** Exclusions, blocklist and "forget": whoever this says yes to never gets a nudge. */
  isExcluded: (entityId: string) => boolean;
}

const DAY_MS = 86_400_000;
const CONTACT_KINDS: ReadonlySet<string> = new Set(["mail", "message", "call"]);

/** Days of silence before an unanswered message becomes a nudge. */
export const UNANSWERED_DAYS: Record<NudgeSensitivity, number> = { low: 7, normal: 5, high: 3 };
/** Drift: how many times the usual gap, and the least gap in days. */
export const DRIFT_RULE: Record<NudgeSensitivity, { factor: number; floor: number }> = {
  low: { factor: 3, floor: 28 },
  normal: { factor: 2.5, floor: 21 },
  high: { factor: 2, floor: 14 },
};
const UNANSWERED_MAX_DAYS = 45;
const DRIFT_MIN_EPISODES = 5;
const DRIFT_MIN_SPAN_DAYS = 60;
const DRIFT_MIN_USUAL_DAYS = 5;
const DRIFT_MAX_SILENCE_DAYS = 180;
const DRIFT_MAX_FACTOR = 12;
const EPISODE_JOIN_DAYS = 3;
const HISTORY_DAYS = 365;
const BIRTHDAY_DAYS = 7;
const PROMISE_MIN_AGE_DAYS = 2;
const PROMISE_TEXT_CHARS = 120;

export function nudgeId(kind: NudgeKind, entityId: string, anchor: string): string {
  return `nd_${sha256(`${kind}\n${entityId}\n${anchor}`).slice(0, 20)}`;
}

/** "9 days", "3 weeks", "4 months": whole units, never a fraction. */
export function spanText(days: number): string {
  if (days < 14) return `${days} ${days === 1 ? "day" : "days"}`;
  if (days < 60) return `${Math.round(days / 7)} weeks`;
  const months = Math.round(days / 30);
  return `${months} ${months === 1 ? "month" : "months"}`;
}

/** "every week", "every 2 weeks", "every 10 days", "every month". */
function everyText(days: number): string {
  if (days < 14) return days === 7 ? "every week" : `every ${days} days`;
  if (days < 60) {
    const weeks = Math.round(days / 7);
    return weeks === 1 ? "every week" : `every ${weeks} weeks`;
  }
  const months = Math.round(days / 30);
  return months === 1 ? "every month" : `every ${months} months`;
}

const epochDay = (ms: number, timeZone: string): number => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(ms));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return Math.round(Date.UTC(get("year"), get("month") - 1, get("day")) / DAY_MS);
};

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1
    ? (s[mid] as number)
    : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
};

const eligible = (e: GraphEntity, opts: NudgeOptions): boolean =>
  e.kind === "person" && e.status === "active" && !e.hidden && !e.isOwner && !opts.isExcluded(e.id);

/** A one-to-one mail or message where the other person is the sender. */
function oneToOneFrom(i: GraphInteraction, entityId: string): boolean {
  return (
    (i.kind === "mail" || i.kind === "message") &&
    i.participants.length === 1 &&
    i.participants[0]?.entityId === entityId &&
    i.participants[0]?.role === "from"
  );
}

function unanswered(
  graph: GraphStore,
  e: GraphEntity,
  contact: GraphInteraction[],
  opts: NudgeOptions,
): Nudge | undefined {
  const latest = contact[0];
  if (latest === undefined || latest.direction !== "in" || !oneToOneFrom(latest, e.id))
    return undefined;
  const days = Math.floor((opts.now - Date.parse(latest.occurredAt)) / DAY_MS);
  const min = UNANSWERED_DAYS[opts.sensitivity ?? "normal"];
  if (days < min || days > UNANSWERED_MAX_DAYS) return undefined;
  if (!graph.isTwoWay(e.id)) return undefined;
  const channel: NudgeChannel = latest.kind === "mail" ? "mail" : "messages";
  const name = safeName(e.name);
  return {
    id: nudgeId("unanswered", e.id, latest.id),
    kind: "unanswered",
    entityId: e.id,
    name,
    text: `You haven't replied to ${name}'s ${channel === "mail" ? "email" : "message"} from ${spanText(days)} ago.`,
    priority: 70 + Math.min(days, 30) / 3,
    daysAgo: days,
    channel,
    date: null,
    loopId: null,
    overdue: false,
    starters: [],
  };
}

function drift(
  graph: GraphStore,
  e: GraphEntity,
  contact: GraphInteraction[],
  opts: NudgeOptions,
): Nudge | undefined {
  const tz = opts.timeZone ?? "UTC";
  const today = epochDay(opts.now, tz);
  const days = [
    ...new Set(
      contact
        .map((i) => epochDay(Date.parse(i.occurredAt), tz))
        .filter((d) => d <= today && today - d <= HISTORY_DAYS),
    ),
  ].sort((a, b) => a - b);
  // Days within a few days of each other are one conversation, not several contacts.
  const episodes: { start: number; end: number }[] = [];
  for (const d of days) {
    const last = episodes[episodes.length - 1];
    if (last !== undefined && d - last.end <= EPISODE_JOIN_DAYS) last.end = d;
    else episodes.push({ start: d, end: d });
  }
  const first = episodes[0];
  const last = episodes[episodes.length - 1];
  if (first === undefined || last === undefined) return undefined;
  if (episodes.length < DRIFT_MIN_EPISODES || last.end - first.start < DRIFT_MIN_SPAN_DAYS)
    return undefined;
  const gaps = episodes.slice(1).map((ep, i) => ep.start - (episodes[i] as { end: number }).end);
  const usual = Math.round(median(gaps));
  if (usual < DRIFT_MIN_USUAL_DAYS) return undefined;
  const gap = today - last.end;
  const rule = DRIFT_RULE[opts.sensitivity ?? "normal"];
  if (gap < Math.max(rule.floor, Math.ceil(usual * rule.factor))) return undefined;
  if (gap > DRIFT_MAX_SILENCE_DAYS || gap > usual * DRIFT_MAX_FACTOR) return undefined;
  if (!graph.isTwoWay(e.id)) return undefined;
  const name = safeName(e.name);
  return {
    id: nudgeId("drift", e.id, String(last.end)),
    kind: "drift",
    entityId: e.id,
    name,
    text: `You usually talk to ${name} ${everyText(usual)}; it's been ${spanText(gap)}.`,
    priority: 50 + Math.min(10, gap / usual),
    daysAgo: gap,
    channel: null,
    date: null,
    loopId: null,
    overdue: false,
    starters: [],
  };
}

function promise(e: GraphEntity, loop: GraphLoop, opts: NudgeOptions): Nudge | undefined {
  const age = (opts.now - Date.parse(loop.createdAt)) / DAY_MS;
  const overdue = loop.dueAt != null && Date.parse(loop.dueAt) < opts.now;
  if (!overdue && age < PROMISE_MIN_AGE_DAYS) return undefined;
  const words = safeName(loop.text, PROMISE_TEXT_CHARS);
  if (words === "" || detectSensitive(words).length > 0 || looksLikeInstruction(words))
    return undefined;
  const name = safeName(e.name);
  return {
    id: nudgeId("promise", e.id, loop.id),
    kind: "promise",
    entityId: e.id,
    name,
    text: `You promised ${name}: “${words}”. Did you do it?`,
    priority: 80 + (overdue ? 10 : 0),
    daysAgo: Math.floor(age),
    channel: null,
    date: null,
    loopId: loop.id,
    overdue,
    starters: [],
  };
}

/**
 * Every nudge the data supports right now, best first, at most one per person. Snoozes, "done"
 * and mutes are applied by the caller (`NudgeState`); exclusions are applied here.
 */
export function computeNudges(graph: GraphStore, opts: NudgeOptions): Nudge[] {
  const found = new Map<string, Nudge>();
  const keep = (n: Nudge | undefined) => {
    if (n === undefined) return;
    const cur = found.get(n.entityId);
    if (cur === undefined || n.priority > cur.priority) found.set(n.entityId, n);
  };
  const since = opts.now - HISTORY_DAYS * DAY_MS;
  const people = graph.listEntities(["person"]).filter((e) => eligible(e, opts));
  const byId = new Map(people.map((e) => [e.id, e]));

  // Message signals: only people in touch within the last year, only mail, messages and calls.
  for (const e of people) {
    if (e.lastInteractionAt == null || Date.parse(e.lastInteractionAt) < since) continue;
    const contact = graph
      .interactions(e.id, { limit: 200 })
      .filter((i) => CONTACT_KINDS.has(i.kind));
    keep(unanswered(graph, e, contact, opts));
    keep(drift(graph, e, contact, opts));
  }

  // Promises you made, from your own words (never `untrusted`), still open.
  for (const loop of graph.loops({ status: ["open"], direction: "i_owe", limit: 500 })) {
    if (loop.counterpartId == null || loop.provenance === "untrusted") continue;
    const e = byId.get(graph.resolveMerged(loop.counterpartId));
    if (e !== undefined) keep(promise(e, loop, opts));
  }

  // Birthdays and anniversaries: accepted facts with no sensitivity class, nothing else.
  for (const u of upcoming(graph, {
    now: opts.now,
    days: BIRTHDAY_DAYS,
    ...(opts.timeZone === undefined ? {} : { timeZone: opts.timeZone }),
    fact: (f) => f.sensitivity === "none",
  })) {
    if (u.entityKind !== "person" || u.kind === "event") continue;
    const e = byId.get(u.entityId);
    if (e === undefined) continue;
    const name = safeName(e.name);
    keep({
      id: nudgeId("birthday", e.id, `${u.kind}:${u.date}`),
      kind: "birthday",
      entityId: e.id,
      name,
      text: describeUpcoming({ ...u, name, lastContactAt: null }, opts.now),
      priority: u.daysAway <= 3 ? 100 - u.daysAway : 40 - u.daysAway / 10,
      daysAgo: null,
      channel: null,
      date: u.date,
      loopId: null,
      overdue: false,
      starters: [],
    });
  }
  // Starters are built last, only for the nudges that survived (one per person).
  return [...found.values()]
    .sort((a, b) => b.priority - a.priority || a.name.localeCompare(b.name))
    .map((n) => ({
      ...n,
      starters: buildStarters(graph, n.entityId, {
        now: opts.now,
        birthday: n.kind === "birthday",
        excludeLoopId: n.loopId,
      }),
    }));
}

// --- snooze, done, mute ---------------------------------------------------------------------

export const NUDGE_STATE_KEY = "nudges.state";

export interface NudgeStateData {
  /** Nudge id -> when it was marked done. */
  done: Record<string, string>;
  /** Nudge id -> snoozed until. */
  snoozed: Record<string, string>;
  /** Entity id -> when nudges for them were muted. */
  muted: Record<string, string>;
  /** Nudge id -> when its Feed card was posted. */
  posted: Record<string, string>;
}

export interface NudgeKeyValue {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
}

const PRUNE_DAYS = 120;

const record = (v: unknown): Record<string, string> => {
  const out: Record<string, string> = {};
  if (typeof v === "object" && v !== null && !Array.isArray(v))
    for (const [k, val] of Object.entries(v)) if (typeof val === "string") out[k] = val;
  return out;
};

/**
 * Snooze, done, mute and "already posted" for nudges. Holds ids and dates only: no names, no
 * text from anyone. Done and snooze are per nudge (a new message or a new year is a new nudge);
 * mute is per person.
 */
export class NudgeState {
  readonly #kv: NudgeKeyValue;
  readonly #now: () => number;

  constructor(kv: NudgeKeyValue, now: () => number) {
    this.#kv = kv;
    this.#now = now;
  }

  read(): NudgeStateData {
    const raw = this.#kv.get(NUDGE_STATE_KEY);
    const o = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
    return {
      done: record(o.done),
      snoozed: record(o.snoozed),
      muted: record(o.muted),
      posted: record(o.posted),
    };
  }

  #write(data: NudgeStateData): void {
    const cutoff = this.#now() - PRUNE_DAYS * DAY_MS;
    const recent = (r: Record<string, string>) =>
      Object.fromEntries(Object.entries(r).filter(([, at]) => Date.parse(at) >= cutoff));
    this.#kv.set(NUDGE_STATE_KEY, {
      done: recent(data.done),
      // A snooze that ended is kept until it ages out, so a card is not re-posted the same day.
      snoozed: recent(data.snoozed),
      muted: data.muted,
      posted: recent(data.posted),
    });
  }

  #iso(ms = this.#now()): string {
    return new Date(ms).toISOString();
  }

  isMuted(entityId: string): boolean {
    return this.read().muted[entityId] !== undefined;
  }

  /** Hidden by a mute, a "done" or a snooze that has not ended. */
  hides(n: Pick<Nudge, "id" | "entityId">): boolean {
    const s = this.read();
    if (s.muted[n.entityId] !== undefined || s.done[n.id] !== undefined) return true;
    const until = s.snoozed[n.id];
    return until !== undefined && Date.parse(until) > this.#now();
  }

  visible<T extends Pick<Nudge, "id" | "entityId">>(all: readonly T[]): T[] {
    const s = this.read();
    const now = this.#now();
    return all.filter((n) => {
      if (s.muted[n.entityId] !== undefined || s.done[n.id] !== undefined) return false;
      const until = s.snoozed[n.id];
      return until === undefined || Date.parse(until) <= now;
    });
  }

  done(id: string): void {
    const s = this.read();
    s.done[id] = this.#iso();
    this.#write(s);
  }

  snooze(id: string, days: number): void {
    const s = this.read();
    s.snoozed[id] = this.#iso(this.#now() + days * DAY_MS);
    this.#write(s);
  }

  mute(entityId: string): void {
    const s = this.read();
    s.muted[entityId] = this.#iso();
    this.#write(s);
  }

  unmute(entityId: string): void {
    const s = this.read();
    delete s.muted[entityId];
    this.#write(s);
  }

  markPosted(id: string): void {
    const s = this.read();
    s.posted[id] = this.#iso();
    this.#write(s);
  }

  wasPosted(id: string): boolean {
    return this.read().posted[id] !== undefined;
  }

  /** Posts made since `ms`, for the daily cap. */
  postedSince(ms: number): number {
    return Object.values(this.read().posted).filter((at) => Date.parse(at) >= ms).length;
  }

  mutedIds(): string[] {
    return Object.keys(this.read().muted);
  }
}
