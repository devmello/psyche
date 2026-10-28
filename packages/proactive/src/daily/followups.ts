import type { DailyFollowup } from "@psyche/protocol";
import { ulid } from "ulid";
import { cleanHeader } from "../mail/classify.ts";
import { FOLLOWUPS_KEY, type FollowupSensitivity, type KeyValue } from "./settings.ts";
import { localAt, localParts } from "./time.ts";

/**
 * Follow-ups Psyche tracks. Commitments are detected only in text the owner wrote (sent mail,
 * their messages, their chat turns); text from anyone else is data and is never parsed for
 * actions. Detection stores items and sends nothing.
 */

export const MAX_FOLLOWUPS = 300;
const TIME_CUE =
  /\b(today|tonight|tomorrow|this (?:week|afternoon|evening|morning)|next week|by (?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|eod|end of (?:day|week))|on (?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|later|soon|shortly)\b/i;
const ACTION_VERB =
  /\b(send|get|share|follow up|check|review|look into|call|ping|email|reply|respond|book|schedule|finish|draft|write|update|forward|confirm|circle back|get back)\b/i;
const COMMIT =
  /\b(?:I['’]ll|I will|I['’]m going to|I am going to|let me|I can)\s+([^.!?\n]{3,160})/i;
const REMIND = /\bremind me to\s+([^.!?\n]{3,160})/i;

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

export interface DetectedCommitment {
  text: string;
  dueAt?: number;
}

/** Quoted replies (`> …`) and "On … wrote:" tails belong to others; drop them. */
export function ownLines(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    if (/^\s*(On .{5,120} wrote:|-{2,}\s*Original Message|From:\s)/i.test(line)) break;
    if (/^\s*>/.test(line)) continue;
    out.push(line);
  }
  return out;
}

export function dueFromText(text: string, nowMs: number, timezone: string): number | undefined {
  const t = text.toLowerCase();
  if (/\b(today|tonight|this (afternoon|evening)|eod|end of day)\b/.test(t)) {
    return localAt(nowMs, timezone, 0, 17);
  }
  if (/\btomorrow\b/.test(t)) return localAt(nowMs, timezone, 1, 9);
  if (/\bnext week\b/.test(t)) return localAt(nowMs, timezone, 7, 9);
  const day = WEEKDAYS.findIndex((d) => t.includes(d));
  if (day >= 0) {
    const ahead = (day - localParts(nowMs, timezone).weekday + 7) % 7 || 7;
    return localAt(nowMs, timezone, ahead, 9);
  }
  return undefined;
}

/** Commitments in the owner's own text. `high` keeps every "I'll…"; `low` needs a time cue. */
export function detectCommitments(
  text: string,
  options: { sensitivity: FollowupSensitivity; nowMs: number; timezone: string },
): DetectedCommitment[] {
  const out: DetectedCommitment[] = [];
  for (const raw of ownLines(text)) {
    const line = raw.trim();
    if (line === "") continue;
    const remind = REMIND.exec(line);
    const commit = remind === null ? COMMIT.exec(line) : null;
    const match = remind ?? commit;
    if (match === null) continue;
    const hasCue = TIME_CUE.test(line);
    const hasVerb = ACTION_VERB.test(line);
    const keep =
      remind !== null ||
      (options.sensitivity === "high"
        ? true
        : options.sensitivity === "low"
          ? hasCue && hasVerb
          : hasCue || hasVerb);
    if (!keep) continue;
    const phrase = (remind === null ? line : (match[1] ?? line)).replace(/\s+/g, " ").trim();
    const dueAt = dueFromText(line, options.nowMs, options.timezone);
    out.push({
      text: remind === null ? phrase.slice(0, 300) : `Remind: ${phrase.slice(0, 280)}`,
      ...(dueAt === undefined ? {} : { dueAt }),
    });
  }
  return out;
}

export interface AwaitingThread {
  id: string;
  subject: string;
  to?: string;
  sentAt: number;
  link?: string;
}

const iso = (ms: number) => new Date(ms).toISOString();
const norm = (s: string) => s.toLowerCase().replace(/\W+/g, " ").trim();

export class FollowupStore {
  readonly #kv: KeyValue;
  readonly #now: () => number;
  readonly #id: () => string;

  constructor(kv: KeyValue, now: () => number, newId?: () => string) {
    this.#kv = kv;
    this.#now = now;
    this.#id = newId ?? (() => `fu_${ulid(now())}`);
  }

  #all(): DailyFollowup[] {
    const v = this.#kv.get(FOLLOWUPS_KEY);
    return Array.isArray(v) ? (v as DailyFollowup[]) : [];
  }

  #save(items: DailyFollowup[]): void {
    // Finished items fall off first when the list is full.
    const open = items.filter((i) => i.status === "open" || i.status === "snoozed");
    const rest = items.filter((i) => i.status !== "open" && i.status !== "snoozed");
    this.#kv.set(FOLLOWUPS_KEY, [
      ...rest.slice(-Math.max(0, MAX_FOLLOWUPS - open.length)),
      ...open,
    ]);
  }

  /** Adds an item unless the same text from the same source is already tracked. */
  add(input: Omit<DailyFollowup, "id" | "status" | "createdAt">): DailyFollowup | undefined {
    const items = this.#all();
    const key = `${norm(input.text)}|${input.sourceLink ?? ""}`;
    if (items.some((i) => `${norm(i.text)}|${i.sourceLink ?? ""}` === key)) return undefined;
    const item: DailyFollowup = {
      ...input,
      id: this.#id(),
      status: "open",
      createdAt: iso(this.#now()),
    };
    this.#save([...items, item]);
    return item;
  }

  /** Owner-authored text only: the caller says whose text it is, and anything else is refused. */
  ingestOwnerText(
    text: string,
    source: "sent_mail" | "message" | "chat",
    opts: { sensitivity: FollowupSensitivity; timezone: string; sourceLink?: string },
  ): DailyFollowup[] {
    const added: DailyFollowup[] = [];
    for (const c of detectCommitments(text, {
      sensitivity: opts.sensitivity,
      nowMs: this.#now(),
      timezone: opts.timezone,
    })) {
      const item = this.add({
        text: c.text,
        source,
        ...(opts.sourceLink === undefined ? {} : { sourceLink: opts.sourceLink }),
        ...(c.dueAt === undefined ? {} : { dueAt: iso(c.dueAt) }),
      });
      if (item !== undefined) added.push(item);
    }
    return added;
  }

  /** Threads the owner wrote last and nobody answered for `days` days. Subjects are data. */
  addAwaiting(threads: readonly AwaitingThread[], days: number): DailyFollowup[] {
    const out: DailyFollowup[] = [];
    for (const t of threads) {
      if (this.#now() - t.sentAt < days * 86_400_000) continue;
      const to = t.to === undefined ? "" : ` from ${cleanHeader(t.to, 80)}`;
      const item = this.add({
        text: `Waiting for a reply${to}: ${cleanHeader(t.subject, 160)}`,
        source: "awaiting_reply",
        ...(t.link === undefined ? {} : { sourceLink: t.link }),
      });
      if (item !== undefined) out.push(item);
    }
    return out;
  }

  list(statuses?: readonly DailyFollowup["status"][]): DailyFollowup[] {
    const now = this.#now();
    return this.#all().filter((i) =>
      statuses === undefined
        ? i.status === "open" || (i.status === "snoozed" && Date.parse(i.snoozedUntil ?? "") <= now)
        : statuses.includes(i.status),
    );
  }

  get(id: string): DailyFollowup | undefined {
    return this.#all().find((i) => i.id === id);
  }

  update(
    id: string,
    action: "done" | "snooze" | "dismiss" | "reopen",
    until?: number,
  ): DailyFollowup | undefined {
    const items = this.#all();
    const i = items.findIndex((x) => x.id === id);
    const cur = items[i];
    if (cur === undefined) return undefined;
    const { snoozedUntil: _s, ...base } = cur;
    const next: DailyFollowup =
      action === "done"
        ? { ...base, status: "done" }
        : action === "dismiss"
          ? { ...base, status: "dismissed" }
          : action === "reopen"
            ? { ...base, status: "open" }
            : { ...base, status: "snoozed", snoozedUntil: iso(until ?? this.#now() + 86_400_000) };
    items[i] = next;
    this.#save(items);
    return next;
  }
}
