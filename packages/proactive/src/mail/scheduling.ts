import type { ActionCall, ModelProvider, ModelRef } from "@psyche/protocol";
import type { ProposalService, ToolLookup } from "../proposals/service.ts";
import { toIso } from "../sqlite.ts";
import type { Draft, DraftRequest, DraftService } from "./drafts.ts";
import { readTool } from "./tools.ts";

/**
 * Scheduling over email (docs/workflows/mail-and-meetings-2026.md §4.4): three free times from
 * free/busy inside working hours with buffers, written in both time zones; an optional hold
 * per time (tentative events, one card); and, when the reply picks one, the event on one card.
 * Nothing moves an existing meeting (meetings [19][27][30]).
 */

export interface Slot {
  start: string;
  end: string;
}

export interface SlotQuery {
  busy: readonly { start: string; end: string }[];
  from: number;
  to: number;
  durationMin: number;
  timezone: string;
  /** Local working hours (default 9–17), weekdays only. */
  workingHours?: { start: number; end: number };
  bufferMin?: number;
  count?: number;
  stepMin?: number;
}

export function localParts(
  ms: number,
  tz: string,
): { hour: number; minute: number; weekday: number } {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  }).formatToParts(new Date(ms));
  const get = (t: string) => f.find((p) => p.type === t)?.value ?? "0";
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return {
    hour: Number(get("hour")),
    minute: Number(get("minute")),
    weekday: days.indexOf(get("weekday")),
  };
}

/** Ranked free slots: earliest first, at most one per day so the three are spread out. */
export function findSlots(q: SlotQuery): Slot[] {
  const dur = q.durationMin * 60_000;
  const buffer = (q.bufferMin ?? 15) * 60_000;
  const step = (q.stepMin ?? 30) * 60_000;
  const { start: wh0, end: wh1 } = q.workingHours ?? { start: 9, end: 17 };
  const busy = q.busy.map((b) => ({
    s: Date.parse(b.start) - buffer,
    e: Date.parse(b.end) + buffer,
  }));
  const out: Slot[] = [];
  const days = new Set<string>();
  let t = Math.ceil(q.from / step) * step;
  while (t + dur <= q.to && out.length < (q.count ?? 3)) {
    const a = localParts(t, q.timezone);
    const b = localParts(t + dur - 60_000, q.timezone);
    const dayKey = new Date(t).toLocaleDateString("en-CA", { timeZone: q.timezone });
    const inHours =
      a.weekday >= 1 &&
      a.weekday <= 5 &&
      a.hour >= wh0 &&
      (b.hour < wh1 || (b.hour === wh1 && b.minute === 0));
    const clashes = busy.some((x) => t < x.e && t + dur > x.s);
    if (inHours && !clashes && !days.has(dayKey)) {
      out.push({ start: toIso(t), end: toIso(t + dur) });
      days.add(dayKey);
    }
    t += step;
  }
  return out;
}

export function formatSlot(s: Slot, tz: string, otherTz?: string): string {
  const fmt = (zone: string) =>
    new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    }).format(new Date(s.start));
  return otherTz === undefined || otherTz === tz ? fmt(tz) : `${fmt(tz)} (${fmt(otherTz)} for you)`;
}

/** Which offered slot a reply picks, or `undefined` when it is ambiguous (ask the owner). */
export function pickSlot(reply: string, slots: readonly Slot[], tz: string): number | undefined {
  const text = reply.toLowerCase();
  const ordinals = ["first", "second", "third"];
  const hits = new Set<number>();
  slots.forEach((s, i) => {
    if (
      text.includes(ordinals[i] ?? "~") ||
      new RegExp(`\\b(option|slot|#)\\s*${i + 1}\\b`).test(text)
    )
      hits.add(i);
    const day = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long" })
      .format(new Date(s.start))
      .toLowerCase();
    const hour = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric" })
      .format(new Date(s.start))
      .toLowerCase()
      .replace(" ", "");
    if (
      text.includes(day) &&
      (text.includes(hour) ||
        !slots.some(
          (o, j) =>
            j !== i &&
            new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long" })
              .format(new Date(o.start))
              .toLowerCase() === day,
        ))
    )
      hits.add(i);
  });
  return hits.size === 1 ? [...hits][0] : undefined;
}

export interface SchedulingServiceOptions {
  tools: ToolLookup;
  drafts: DraftService;
  proposals?: ProposalService;
  /** Read-only mode (Settings → Mail & meetings): reads and writes notes, but proposes nothing. */
  readOnly?: () => boolean;
  timezone: string;
  workingHours?: { start: number; end: number };
  /**
   * Settings → Mail & meetings → Scheduling (`mail.schedule.*`), read on every proposal. Wins over
   * `workingHours`; the buffer is the gap kept either side of other meetings.
   */
  schedule?: () => { workingHours: { start: number; end: number }; bufferMin: number };
  now: () => number;
  /** A scheduling link the owner set in Settings; offered only then (meetings [37][55]). */
  schedulingLink?: string;
  provider?: ModelProvider;
  model?: ModelRef;
}

export interface TimesProposal {
  slots: Slot[];
  draft: Draft;
  holdsProposalId: string | null;
}

export class SchedulingService {
  readonly #o: SchedulingServiceOptions;

  constructor(options: SchedulingServiceOptions) {
    this.#o = options;
  }

  /** The proposal service, unless the owner turned on read-only: then nothing is proposed. */
  get #proposals(): ProposalService | undefined {
    return this.#o.readOnly?.() === true ? undefined : this.#o.proposals;
  }

  async #busy(from: number, to: number) {
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

  /** Three times, a reply draft that offers them, and an optional holds card. */
  async proposeTimes(
    r: DraftRequest & {
      durationMin?: number;
      withinDays?: number;
      recipientTimezone?: string;
      holds?: boolean;
      who?: string;
    },
  ): Promise<TimesProposal> {
    const now = this.#o.now();
    const from = now + 3_600_000;
    const to = now + (r.withinDays ?? 7) * 86_400_000;
    const busy = await this.#busy(from, to);
    const schedule = this.#o.schedule?.();
    const workingHours = schedule?.workingHours ?? this.#o.workingHours;
    const slots = findSlots({
      busy,
      from,
      to,
      durationMin: r.durationMin ?? 30,
      timezone: this.#o.timezone,
      ...(workingHours === undefined ? {} : { workingHours }),
      ...(schedule === undefined ? {} : { bufferMin: schedule.bufferMin }),
    });
    const lines = slots
      .map((s) => `- ${formatSlot(s, this.#o.timezone, r.recipientTimezone)}`)
      .join("\n");
    const draft = await this.#o.drafts.draft({
      ...r,
      instruction: `${r.instruction === undefined ? "" : `${r.instruction}\n`}Offer these times and ask which works:\n${lines}${this.#o.schedulingLink === undefined ? "" : `\nIf none works, they can pick another time here: ${this.#o.schedulingLink}`}`,
    });
    let holdsProposalId: string | null = null;
    if (
      r.holds === true &&
      this.#proposals !== undefined &&
      this.#o.tools.get("calendar_create_event") !== undefined &&
      slots.length > 0
    ) {
      const calls: ActionCall[] = slots.map((s) => ({
        tool: "calendar_create_event",
        params: {
          title: `Hold: ${r.who ?? "meeting"}`,
          start: s.start,
          end: s.end,
          availability: "free",
        },
        summary: `Hold ${formatSlot(s, this.#o.timezone)}`,
      }));
      holdsProposalId = this.#proposals.create({
        title: `Hold ${slots.length} times`,
        calls,
        createdBy: { job: "mail.schedule" },
      }).id;
    }
    return { slots, draft, holdsProposalId };
  }

  /**
   * The reply picked a slot: the event on one card. Ambiguous replies return a question for the
   * owner instead of a guess. Releasing the other holds is a delete, so it is never in the
   * batch: the agent asks for each one on its own card.
   */
  confirm(input: {
    reply: string;
    slots: readonly Slot[];
    title: string;
    holdEventIds?: readonly string[];
    attendees?: string[];
  }): { question: string } | { slot: Slot; proposalId: string | null; releaseHoldIds: string[] } {
    const i = pickSlot(input.reply, input.slots, this.#o.timezone);
    if (i === undefined) {
      return {
        question: `Which time did they pick? ${input.slots.map((s, j) => `${j + 1}) ${formatSlot(s, this.#o.timezone)}`).join(" ")}`,
      };
    }
    const slot = input.slots[i] as Slot;
    let proposalId: string | null = null;
    if (this.#proposals !== undefined && this.#o.tools.get("calendar_create_event") !== undefined) {
      proposalId = this.#proposals.create({
        title: `Add "${input.title}" ${formatSlot(slot, this.#o.timezone)}`,
        calls: [
          {
            tool: "calendar_create_event",
            params: {
              title: input.title,
              start: slot.start,
              end: slot.end,
              ...(input.attendees === undefined ? {} : { attendees: input.attendees }),
            },
            summary: `Add ${input.title}`,
          },
        ],
        createdBy: { job: "mail.schedule" },
      }).id;
    }
    return {
      slot,
      proposalId,
      releaseHoldIds: (input.holdEventIds ?? []).filter((_, j) => j !== i),
    };
  }
}
