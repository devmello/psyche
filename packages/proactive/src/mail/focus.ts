import type { ActionCall, ActionProposalStatus } from "@psyche/protocol";
import {
  jobMarker,
  type LaunchResult,
  type ProactiveJob,
  parseJobMarker,
  type SchedulerLike,
} from "../jobs.ts";
import type { ProposalService, ToolLookup } from "../proposals/service.ts";
import { toIso } from "../sqlite.ts";
import { findSlots, formatSlot, localParts, type Slot } from "./scheduling.ts";
import { readTool } from "./tools.ts";

/**
 * Focus time (docs/workflows/mail-and-meetings-2026.md §4.4; Settings → Mail & meetings →
 * Scheduling → "Offer focus time", `mail.schedule.focusTime`). Once a week, when the switch is on,
 * Psyche proposes ONE deep-work block for the coming Monday-to-Friday week as a proposal card
 * (the same card holds use). Only when the owner approves does the calendar get an event titled
 * "Focus (Psyche)", created busy, so free/busy reports it and scheduling never offers that time.
 * Nothing here talks to the calendar's write tool: it only builds the proposal.
 */

export const MAIL_FOCUS_JOB = "mail-focus";
/** Sunday 18:00 in the owner's time zone: the week ahead is planned the evening before. */
export const FOCUS_SCHEDULE = "0 18 * * 0";
export const FOCUS_EVENT_TITLE = "Focus (Psyche)";
export const FOCUS_DURATION_MIN = 120;
const CREATED_BY_JOB = "mail.focus";
const DAY_MS = 86_400_000;
/** A decline or an expiry still counts as "this week was offered": no nagging. */
const OFFERED: ActionProposalStatus[] = [
  "pending",
  "awaiting_approval",
  "running",
  "done",
  "partial",
  "dismissed",
  "expired",
];

export interface FocusTimeServiceOptions {
  tools: ToolLookup;
  proposals?: ProposalService;
  scheduler?: SchedulerLike;
  /** `mail.schedule.focusTime`, read on every run. */
  enabled: () => boolean;
  /** Read-only mode (Settings → Mail & meetings): nothing is proposed. */
  readOnly?: () => boolean;
  timezone: string;
  workingHours?: { start: number; end: number };
  /** Settings → Scheduling, read on every run; wins over `workingHours`. */
  schedule?: () => { workingHours: { start: number; end: number }; bufferMin: number };
  now: () => number;
}

export type FocusOutcome =
  | { status: "proposed"; proposalId: string; slot: Slot }
  | {
      status:
        | "off"
        | "read_only"
        | "no_calendar"
        | "already_offered"
        | "already_booked"
        | "no_slot";
    };

/** The first moment of the next Monday after `now` in `tz` (15-minute resolution). */
export function nextWeekStart(now: number, tz: string): number {
  const step = 15 * 60_000;
  let t = Math.ceil(now / step) * step;
  let prevMonday = localParts(t, tz).weekday === 1;
  for (let i = 0; i < 8 * 96; i++) {
    t += step;
    const monday = localParts(t, tz).weekday === 1;
    if (monday && !prevMonday) return t;
    prevMonday = monday;
  }
  return t;
}

function listOf(output: unknown, key: string): Record<string, unknown>[] {
  if (Array.isArray(output)) return output as Record<string, unknown>[];
  const inner = (output as Record<string, unknown> | undefined)?.[key];
  return Array.isArray(inner) ? (inner as Record<string, unknown>[]) : [];
}

export class FocusTimeService {
  readonly #o: FocusTimeServiceOptions;

  constructor(options: FocusTimeServiceOptions) {
    this.#o = options;
  }

  /** The system automation that proposes the block (`[psyche:mail-focus weekly]`). */
  async ensureSchedule(options: { enabled?: boolean; timezone?: string } = {}) {
    if (this.#o.scheduler === undefined) return undefined;
    const prompt = jobMarker(MAIL_FOCUS_JOB, "weekly");
    const fields = {
      title: "Offer focus time",
      schedule: FOCUS_SCHEDULE,
      timezone: options.timezone ?? this.#o.timezone,
      sessionTarget: "main",
      delivery: {},
      prompt,
      enabled: options.enabled ?? this.#o.enabled(),
      scratch: null,
    };
    const existing = (await this.#o.scheduler.list()).find((a) => a.prompt.trim() === prompt);
    return existing === undefined
      ? this.#o.scheduler.create({ kind: "cron", system: true, ...fields })
      : this.#o.scheduler.update(existing.id, fields);
  }

  /** A focus proposal for a day in `[from, to)` that was not refused by a failure. */
  #offered(from: number, to: number): boolean {
    const page = this.#o.proposals?.list({ status: OFFERED, limit: 500 });
    return (page?.proposals ?? []).some(
      (p) =>
        p.createdBy.job === CREATED_BY_JOB &&
        p.calls.some((c) => {
          const start = Date.parse(String((c.params as { start?: unknown }).start));
          return c.tool === "calendar_create_event" && start >= from && start < to;
        }),
    );
  }

  /** An event with the focus title already on the calendar that week (approved earlier). */
  async #booked(from: number, to: number): Promise<boolean> {
    if (this.#o.tools.get("calendar_list_events") === undefined) return false;
    try {
      const out = await readTool(this.#o.tools, "calendar_list_events", {
        from: toIso(from),
        to: toIso(to),
        query: FOCUS_EVENT_TITLE,
        limit: 50,
      });
      return listOf(out, "events").some((e) => {
        const title = e.title ?? e.summary;
        return (
          typeof title === "string" &&
          title.trim().toLowerCase() === FOCUS_EVENT_TITLE.toLowerCase()
        );
      });
    } catch {
      // The proposal list above still guards against a repeat; a read failure must not block.
      return false;
    }
  }

  async #busy(from: number, to: number): Promise<{ start: string; end: string }[]> {
    const out = await readTool(this.#o.tools, "calendar_free_busy", {
      from: toIso(from),
      to: toIso(to),
    });
    const list = Array.isArray(out)
      ? out
      : ((out as { busy?: unknown[]; blocks?: unknown[] } | undefined)?.busy ??
        (out as { blocks?: unknown[] } | undefined)?.blocks ??
        []);
    return (list as { start?: string; end?: string }[]).filter(
      (b): b is { start: string; end: string } =>
        typeof b.start === "string" && typeof b.end === "string",
    );
  }

  /** Proposes one block for the coming week, unless it is off, already offered or booked. */
  async run(): Promise<FocusOutcome> {
    if (!this.#o.enabled()) return { status: "off" };
    const proposals = this.#o.readOnly?.() === true ? undefined : this.#o.proposals;
    if (proposals === undefined) return { status: "read_only" };
    if (
      this.#o.tools.get("calendar_free_busy") === undefined ||
      this.#o.tools.get("calendar_create_event") === undefined
    ) {
      return { status: "no_calendar" };
    }
    const from = nextWeekStart(this.#o.now(), this.#o.timezone);
    const to = from + 7 * DAY_MS;
    if (this.#offered(from, to)) return { status: "already_offered" };
    if (await this.#booked(from, to)) return { status: "already_booked" };
    const schedule = this.#o.schedule?.();
    const workingHours = schedule?.workingHours ?? this.#o.workingHours;
    const [slot] = findSlots({
      busy: await this.#busy(from, to),
      from,
      to,
      durationMin: FOCUS_DURATION_MIN,
      timezone: this.#o.timezone,
      count: 1,
      ...(workingHours === undefined ? {} : { workingHours }),
      ...(schedule === undefined ? {} : { bufferMin: schedule.bufferMin }),
    });
    if (slot === undefined) return { status: "no_slot" };
    const when = formatSlot(slot, this.#o.timezone);
    const call: ActionCall = {
      tool: "calendar_create_event",
      // Created busy (not a soft hold), so free/busy reports it and scheduling skips the time.
      params: {
        title: FOCUS_EVENT_TITLE,
        start: slot.start,
        end: slot.end,
        availability: "busy",
      },
      summary: `Block ${when} for focus time`,
    };
    const created = proposals.create({
      title: `Block 2 hours of focus time, ${when}`,
      calls: [call],
      createdBy: { job: CREATED_BY_JOB },
      // The card stays up until the block would have started, at most a week.
      ttlMs: Math.min(7 * DAY_MS, Math.max(3_600_000, Date.parse(slot.start) - this.#o.now())),
    });
    return { status: "proposed", proposalId: created.id, slot };
  }

  job(): ProactiveJob {
    return {
      name: "mail focus",
      matches: (a) => parseJobMarker(a.prompt)?.job === MAIL_FOCUS_JOB,
      run: async (): Promise<LaunchResult> => {
        const r = await this.run();
        return {
          status: "no_reply",
          summary:
            r.status === "proposed" ? `proposed ${formatSlot(r.slot, this.#o.timezone)}` : r.status,
        };
      },
    };
  }
}
