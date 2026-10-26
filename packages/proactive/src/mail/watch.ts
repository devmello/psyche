import type { ToolRunContext } from "@psyche/agent-core";
import type { Automation, Clock, WorkflowEvent } from "@psyche/protocol";
import {
  jobMarker,
  type LaunchRequest,
  type LaunchResult,
  type ProactiveJob,
  parseJobMarker,
  type SchedulerLike,
} from "../jobs.ts";
import type { ToolLookup } from "../proposals/service.ts";
import { toIso } from "../sqlite.ts";

/**
 * The new-mail poller (docs/workflows/mail-and-meetings-2026.md §4.7; #670 W3). Wave 1 has no
 * push for new mail, so a system automation polls every 10 minutes in active hours (hourly
 * outside them; never more often than every 5) and publishes `mail.received` events to the
 * scheduler, which starts the event automations that match. The poll makes no model call: it
 * reads unread mail since each source's durable cursor through the mail tools already
 * registered (Apple Mail `mail_search`, Gmail `gmail_search_threads`) and turns headers into
 * events. Sender and subject are untrusted and travel as data only.
 */

export const MAIL_WATCH_JOB = "mail-watch";
export const MAIL_WATCH_SCHEDULE = "PT10M";
export const MAIL_WATCH_SOURCE = "mail.watch";
/** Outside active hours a poll happens at most this often. */
export const OFF_HOURS_POLL_MS = 60 * 60_000;
/** The first poll of a source looks back this far. */
export const FIRST_POLL_LOOKBACK_MS = 60 * 60_000;
const MAX_PER_POLL = 50;

export interface EventScheduler extends SchedulerLike {
  publishEvent(event: WorkflowEvent): Promise<string[]>;
  getCursor(source: string, key: string): string | undefined;
  setCursor(source: string, key: string, cursor: string): void;
}

/** One mail source: polls new mail since a cursor and returns events plus the next cursor. */
export interface MailEventSource {
  readonly id: string;
  poll(since: string, now: number, signal: AbortSignal): Promise<WorkflowEvent[]>;
}

function asList(output: unknown, key: string): Record<string, unknown>[] {
  if (Array.isArray(output)) return output as Record<string, unknown>[];
  const inner = (output as Record<string, unknown> | null)?.[key];
  return Array.isArray(inner) ? (inner as Record<string, unknown>[]) : [];
}

function str(v: unknown, max: number): string | undefined {
  return typeof v === "string" && v !== "" ? v.slice(0, max) : undefined;
}

async function runRead(
  tools: ToolLookup,
  tool: string,
  params: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  const reg = tools.get(tool);
  if (reg === undefined) return undefined;
  const callId = `mailwatch:${tool}:${Date.now()}`;
  const ctx: ToolRunContext = {
    callId,
    threadId: "system:mail-watch",
    runId: "mail-watch",
    taint: true,
    permissionMode: "balanced",
    mode: "unattended",
    signal,
    onUpdate: () => {},
  };
  const r =
    "run" in reg && reg.run !== undefined
      ? await reg.run(params, ctx)
      : await reg.execute(callId, params, signal, () => {});
  if (r.isError === true) throw new Error(`${tool} failed`);
  return r.output;
}

/** Apple Mail through `mail_search {unread: true, since}` (newest first, #626). */
export function appleMailSource(tools: ToolLookup): MailEventSource {
  return {
    id: "apple-mail",
    async poll(since, _now, signal) {
      const out = await runRead(
        tools,
        "mail_search",
        { unread: true, since, limit: MAX_PER_POLL },
        signal,
      );
      return asList(out, "messages").flatMap((m) => {
        const id = str(m.id, 256);
        if (id === undefined) return [];
        const account = str(m.account, 200) ?? "mail";
        const e: WorkflowEvent = {
          id: `mail:apple:${account}:${id}`,
          source: "mail.received",
          at: str(m.date, 40) ?? since,
          account,
          messageId: id,
        };
        const from = str(m.from, 320);
        const subject = str(m.subject, 500);
        if (from !== undefined) e.from = from;
        if (subject !== undefined) e.subject = subject;
        return [e];
      });
    },
  };
}

/** Gmail through `gmail_search_threads {query: "is:unread after:<epoch>"}`. */
export function gmailSource(tools: ToolLookup, account = "gmail"): MailEventSource {
  return {
    id: "gmail",
    async poll(since, _now, signal) {
      const after = Math.floor(Date.parse(since) / 1000);
      const out = await runRead(
        tools,
        "gmail_search_threads",
        { query: `is:unread after:${after}`, maxResults: MAX_PER_POLL },
        signal,
      );
      return asList(out, "threads").flatMap((t) => {
        const id = str(t.id, 256);
        if (id === undefined) return [];
        const e: WorkflowEvent = {
          // Thread id plus message count: a new message in a known thread is a new event.
          id: `mail:gmail:${id}:${typeof t.messageCount === "number" ? t.messageCount : 1}`,
          source: "mail.received",
          at: str(t.date, 40) ?? since,
          account,
          threadId: id,
        };
        const from = str(t.from, 320);
        const subject = str(t.subject, 500);
        if (from !== undefined) e.from = from;
        if (subject !== undefined) e.subject = subject;
        return [e];
      });
    },
  };
}

export interface MailWatcherOptions {
  scheduler: EventScheduler;
  clock: Clock;
  sources: () => readonly MailEventSource[];
  /** Local active hours (default 08–22) and their timezone; outside them, hourly. */
  activeHours?: { start: number; end: number };
  timezone?: string;
  /**
   * Whether anything listens for `mail.received` (default: an enabled event automation does).
   * Nothing listening, nothing is read.
   */
  wanted?: () => Promise<boolean>;
  onError?: (error: unknown) => void;
}

function localHour(ms: number, timezone: string): number {
  return Number(
    new Intl.DateTimeFormat("en-GB", {
      hour: "2-digit",
      hourCycle: "h23",
      timeZone: timezone,
    }).format(new Date(ms)),
  );
}

export class MailWatcher {
  readonly #o: MailWatcherOptions;

  constructor(options: MailWatcherOptions) {
    this.#o = options;
  }

  /** The system automation that runs the poll (interval, `[psyche:mail-watch poll]`). */
  async ensureSchedule(
    options: { enabled?: boolean; timezone?: string } = {},
  ): Promise<Automation> {
    const prompt = jobMarker(MAIL_WATCH_JOB, "poll");
    const fields = {
      title: "Check for new mail",
      schedule: MAIL_WATCH_SCHEDULE,
      timezone: options.timezone ?? this.#o.timezone ?? "UTC",
      sessionTarget: "main",
      delivery: {},
      prompt,
      enabled: options.enabled ?? true,
      scratch: null,
    };
    const existing = (await this.#o.scheduler.list()).find((a) => a.prompt.trim() === prompt);
    return existing === undefined
      ? this.#o.scheduler.create({ kind: "interval", system: true, ...fields })
      : this.#o.scheduler.update(existing.id, fields);
  }

  /**
   * Polls every source since its cursor and publishes the events. Outside active hours it
   * polls at most hourly (the last-poll time is a cursor too). Returns the events published.
   */
  async poll(
    signal: AbortSignal = new AbortController().signal,
  ): Promise<{ published: number; skipped?: string }> {
    const wanted =
      this.#o.wanted ??
      (async () =>
        (await this.#o.scheduler.list()).some(
          (a) => a.kind === "event" && a.enabled && a.trigger?.source === "mail.received",
        ));
    if (!(await wanted())) return { published: 0, skipped: "nothing listens for new mail" };
    const now = this.#o.clock.now();
    const tz = this.#o.timezone ?? "UTC";
    const { start, end } = this.#o.activeHours ?? { start: 8, end: 22 };
    const hour = localHour(now, tz);
    const active = hour >= start && hour < end;
    const last = this.#o.scheduler.getCursor(MAIL_WATCH_SOURCE, "lastPoll");
    if (!active && last !== undefined && now - Date.parse(last) < OFF_HOURS_POLL_MS) {
      return { published: 0, skipped: "outside active hours" };
    }
    let published = 0;
    for (const source of this.#o.sources()) {
      const since =
        this.#o.scheduler.getCursor(MAIL_WATCH_SOURCE, source.id) ??
        toIso(now - FIRST_POLL_LOOKBACK_MS);
      try {
        const events = await source.poll(since, now, signal);
        for (const e of events) {
          if ((await this.#o.scheduler.publishEvent(e)).length > 0) published += 1;
        }
        // The next poll starts where this one began, so a message that arrived mid-poll is
        // seen again (and deduplicated) rather than missed.
        this.#o.scheduler.setCursor(MAIL_WATCH_SOURCE, source.id, toIso(now));
      } catch (e) {
        this.#o.onError?.(e);
      }
    }
    this.#o.scheduler.setCursor(MAIL_WATCH_SOURCE, "lastPoll", toIso(now));
    return { published };
  }

  /** The in-process job behind the poll automation (`withProactiveJobs`). */
  job(): ProactiveJob {
    return {
      name: "mail watch",
      matches: (a) => parseJobMarker(a.prompt)?.job === MAIL_WATCH_JOB,
      run: async (_request: LaunchRequest): Promise<LaunchResult> => {
        const r = await this.poll();
        return {
          status: "no_reply",
          summary: r.skipped === undefined ? `${r.published} new` : `skipped: ${r.skipped}`,
        };
      },
    };
  }
}
