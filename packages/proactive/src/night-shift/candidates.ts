import { cleanHeader } from "../mail/classify.ts";
import { NIGHT_DOMAINS, type NightDomain } from "./settings.ts";

/**
 * Night shift candidates (docs/design/night-shift-2026.md §4.4). Candidates are deterministic: no
 * model is used to find work. Each source is pluggable (`CandidateSource`): the promise ledger will
 * replace the `daily.followups` source by passing its own provider to `followupsSource`, with no
 * change to the service.
 *
 * Everything a candidate carries came from mail, calendars or files, so it is data: the service puts
 * it in the job's goal as quoted JSON, never as instructions, and a candidate with
 * `taintSources` makes the job start tainted.
 */

export type CandidateKind = "quiet_thread" | "followup" | "calendar_overlap" | "file" | string;

export interface Candidate {
  /** Stable across restarts: `<source>:<key>`. */
  id: string;
  domain: NightDomain;
  kind: CandidateKind;
  /** The target the job is about (thread id, event id, reminder text key, file path). */
  key: string;
  /** One cleaned line for the job's title and the "why" line. */
  title: string;
  facts: Record<string, string | number | boolean | null>;
  taintSources: { sourceKind: string; origin: string }[];
}

export interface CandidateSource {
  readonly name: string;
  readonly domain: NightDomain;
  /** At most this many candidates from the source. */
  readonly max: number;
  list(now: number): Promise<Candidate[]> | Candidate[];
}

const DAY_MS = 86_400_000;
export const MAX_QUIET_THREADS = 8;
export const MAX_NIGHT_FOLLOWUPS = 6;
export const MAX_CALENDAR = 4;
export const MAX_FILES = 10;
export const CALENDAR_LOOKAHEAD_DAYS = 3;
export const FILE_MIN_AGE_MS = DAY_MS;

const clean = (s: unknown, n: number): string => cleanHeader(typeof s === "string" ? s : "", n);

// --- mail: quiet threads ------------------------------------------------------------------------

export interface QuietThreadInput {
  source: "gmail" | "apple" | "imap" | string;
  /** The reply tool's id: a Gmail thread id, or the last message's id in Mail. */
  threadId?: string;
  messageId?: string;
  mailbox?: string;
  account?: string;
  subject: string;
  who: string;
  kind: "no_reply" | "unanswered_question";
  daysQuiet: number;
}

export function quietThreadCandidates(
  items: readonly QuietThreadInput[],
  max = MAX_QUIET_THREADS,
): Candidate[] {
  const out: Candidate[] = [];
  for (const t of items) {
    const key = t.threadId ?? t.messageId;
    if (key === undefined || key === "") continue;
    out.push({
      id: `mail:${t.source}:${key}`,
      domain: "mail",
      kind: "quiet_thread",
      key,
      title: clean(t.subject, 120) || "(no subject)",
      facts: {
        situation: t.kind,
        subject: clean(t.subject, 200),
        with: clean(t.who, 120),
        daysQuiet: t.daysQuiet,
        source: t.source,
        ...(t.threadId === undefined ? {} : { threadId: t.threadId }),
        ...(t.messageId === undefined ? {} : { messageId: t.messageId }),
        ...(t.mailbox === undefined ? {} : { mailbox: t.mailbox }),
        ...(t.account === undefined ? {} : { account: t.account }),
      },
      // Mail is someone else's words: the job reads it tainted.
      taintSources: [{ sourceKind: "email", origin: t.source }],
    });
    if (out.length >= max) break;
  }
  return out;
}

// --- reminders: follow-ups (replaced by the promise ledger later) -------------------------------

export interface FollowupInput {
  id: string;
  text: string;
  /** ISO time, when the commitment is due. */
  dueAt?: string;
}

/** Commitments due now or earlier, oldest first: each becomes a `reminders_create`. */
export function followupCandidates(
  items: readonly FollowupInput[],
  now: number,
  max = MAX_NIGHT_FOLLOWUPS,
): Candidate[] {
  const due = items
    .map((f) => ({ f, at: f.dueAt === undefined ? Number.NaN : Date.parse(f.dueAt) }))
    .filter(({ at }) => Number.isNaN(at) || at <= now + DAY_MS)
    .sort((a, b) => (a.at || 0) - (b.at || 0));
  return due.slice(0, max).map(({ f }) => ({
    id: `reminders:${f.id}`,
    domain: "reminders" as const,
    kind: "followup",
    key: f.id,
    title: clean(f.text, 120),
    facts: { commitment: clean(f.text, 300), ...(f.dueAt === undefined ? {} : { dueAt: f.dueAt }) },
    taintSources: [],
  }));
}

/** The follow-up source. Pass `promiseCandidates` from the promise ledger when it exists. */
export function followupsSource(provider: () => readonly FollowupInput[]): CandidateSource {
  return {
    name: "followups",
    domain: "reminders",
    max: MAX_NIGHT_FOLLOWUPS,
    list: (now) => followupCandidates(provider(), now),
  };
}

// --- calendar: overlaps and duplicates among solo events -----------------------------------------

export interface CalendarEventInput {
  id: string;
  calendarId?: string;
  title: string;
  start: string;
  end: string;
  /** Attendees other than the owner. */
  attendees: readonly string[];
}

/** Solo events in the next three days that overlap each other or repeat one (same title and start). */
export function calendarOverlapCandidates(
  events: readonly CalendarEventInput[],
  now: number,
  max = MAX_CALENDAR,
): Candidate[] {
  const horizon = now + CALENDAR_LOOKAHEAD_DAYS * DAY_MS;
  const solo = events
    .filter((e) => e.attendees.length === 0)
    .map((e) => ({ e, s: Date.parse(e.start), x: Date.parse(e.end) }))
    .filter(({ s, x }) => Number.isFinite(s) && Number.isFinite(x) && x > s)
    .filter(({ s }) => s >= now && s <= horizon)
    .sort((a, b) => a.s - b.s);
  const out: Candidate[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < solo.length; i++) {
    const a = solo[i] as (typeof solo)[number];
    for (let j = i + 1; j < solo.length; j++) {
      const b = solo[j] as (typeof solo)[number];
      if (b.s >= a.x) break;
      const duplicate = a.e.title === b.e.title && a.s === b.s;
      const id = `calendar:${a.e.id}:${b.e.id}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({
        id,
        domain: "calendar",
        kind: "calendar_overlap",
        key: a.e.id,
        title: clean(
          duplicate ? `Duplicate: ${a.e.title}` : `${a.e.title} overlaps ${b.e.title}`,
          120,
        ),
        facts: {
          situation: duplicate ? "duplicate" : "overlap",
          eventA: a.e.id,
          titleA: clean(a.e.title, 120),
          startA: a.e.start,
          endA: a.e.end,
          eventB: b.e.id,
          titleB: clean(b.e.title, 120),
          startB: b.e.start,
          endB: b.e.end,
          ...(a.e.calendarId === undefined ? {} : { calendarId: a.e.calendarId }),
        },
        // Event titles are typed by the owner or came from an invitation they accepted alone.
        taintSources: [],
      });
      if (out.length >= max) return out;
    }
  }
  return out;
}

// --- files: older files at the top level of granted folders ---------------------------------------

export interface FileEntryInput {
  /** Absolute path. */
  path: string;
  /** The rw-granted folder it sits directly in (Downloads or Desktop). */
  folder: string;
  name: string;
  size: number;
  mtimeMs: number;
}

export function fileCandidates(
  entries: readonly FileEntryInput[],
  now: number,
  max = MAX_FILES,
): Candidate[] {
  return entries
    .filter((f) => now - f.mtimeMs >= FILE_MIN_AGE_MS && f.path === `${f.folder}/${f.name}`)
    .sort((a, b) => a.mtimeMs - b.mtimeMs)
    .slice(0, max)
    .map((f) => ({
      id: `files:${f.path}`,
      domain: "files" as const,
      kind: "file",
      key: f.path,
      title: clean(f.name, 120),
      facts: {
        path: f.path,
        folder: f.folder,
        name: clean(f.name, 200),
        size: f.size,
        modified: new Date(f.mtimeMs).toISOString(),
      },
      // A file name can be anything a website chose: it is data, and the job reads it tainted.
      taintSources: [{ sourceKind: "file", origin: "granted-folder" }],
    }));
}

// --- gathering ----------------------------------------------------------------------------------

export interface Gathered {
  candidates: Candidate[];
  /** Sources that failed to answer: they contribute nothing and never fail the night. */
  failed: string[];
}

/** Candidates from every source whose domain is on, capped per source, in domain order, de-duplicated. */
export async function gatherCandidates(
  sources: readonly CandidateSource[],
  domains: ReadonlySet<NightDomain>,
  now: number,
): Promise<Gathered> {
  const out: Candidate[] = [];
  const failed: string[] = [];
  const seen = new Set<string>();
  const ordered = [...sources].sort(
    (a, b) => NIGHT_DOMAINS.indexOf(a.domain) - NIGHT_DOMAINS.indexOf(b.domain),
  );
  for (const s of ordered) {
    if (!domains.has(s.domain)) continue;
    let list: Candidate[];
    try {
      list = await s.list(now);
    } catch {
      failed.push(s.name);
      continue;
    }
    for (const c of list.slice(0, s.max)) {
      if (c.domain !== s.domain || seen.has(c.id)) continue;
      seen.add(c.id);
      out.push(c);
    }
  }
  return { candidates: out, failed };
}
