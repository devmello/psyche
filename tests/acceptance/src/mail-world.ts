import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolResult } from "@psyche/protocol";
import type { StackOverrides } from "../../../packages/testing/src/scenarios/stack.ts";
import type { Json } from "../../../packages/testing/src/scenarios/types.ts";
import {
  fromLocal,
  hhmm,
  isoInZone,
  localParts,
} from "../../../packages/testing/src/scenarios/util.ts";
import type {
  ToolCtx,
  ToolImpl,
  ToolInfo,
  World,
} from "../../../packages/testing/src/scenarios/world.ts";
import { type AppleEvent, type AppleWrite, instant, mailLink } from "./apple-world.ts";
import { ROOT } from "./report.ts";

/**
 * Fakes for the mail and meeting workflows (docs/workflows/mail-and-meetings-2026.md §4.1, §4.4,
 * §4.6) at skill level: the agent in a chat turn running the triage, scheduling and meeting-notes
 * skills. Plugged into S18's scenario Stack through `StackOverrides.impls`; the tool rows are in
 * tests/scenarios/shared/mail-tools.json and the scenarios in tests/acceptance/scenarios-mail.
 *
 * Each executor reads its scenario's `fixtures/<name>.json` (mail, calendar, transcript), keeps
 * an in-memory copy, and records every write in `MailState.writes`. Apple Mail serves two
 * accounts (`account` on each message). Ids for new objects are deterministic per prefix
 * (`draft_0001`, `rem_0001`).
 *
 * Reads return `untrusted` results and name their taint sources: `email:<sender>`,
 * `calendar:<organizer>` (events organized by someone else), `transcript:<file name>`.
 * Writes record a receipt with the provider ids.
 */

export const MAIL_SCENARIOS_DIR = join(ROOT, "tests/acceptance/scenarios-mail");
export const MAIL_SCENARIO_IDS = [
  "v1-mail-digest-counts",
  "v2-mail-batch-mark-read",
  "v3-mail-injection",
  "v4-mail-propose-times",
  "v5-meeting-notes",
] as const;
export type MailScenarioId = (typeof MAIL_SCENARIO_IDS)[number];

export interface MailMessage {
  id: string;
  messageId: string;
  account: string;
  mailbox: string;
  from: { name: string; email: string };
  to: string[];
  subject: string;
  date: string;
  read: boolean;
  flagged: boolean;
  headers?: Record<string, string>;
  body: string;
}

export interface TranscriptSegment {
  startMs: number;
  endMs: number;
  text: string;
}

export interface TranscriptFixture {
  path: string;
  engine: string;
  language: string;
  audioMs: number;
  segments: TranscriptSegment[];
}

export interface Slot {
  start: string;
  end: string;
}

export interface MailState {
  mail: MailMessage[];
  events: AppleEvent[];
  transcripts: TranscriptFixture[];
  reminders: Json[];
  drafts: Json[];
  sent: Json[];
  writes: AppleWrite[];
  /** Every `calendar_find_free_time` answer, in call order. */
  freeTime: { callId: string; slots: Slot[] }[];
}

/** The overrides and the fakes' state for one mail workflow scenario. */
export function mailOverrides(): { overrides: StackOverrides; state: MailState } {
  const state: MailState = {
    mail: [],
    events: [],
    transcripts: [],
    reminders: [],
    drafts: [],
    sent: [],
    writes: [],
    freeTime: [],
  };
  return { overrides: { impls: (world) => mailImpls(world, state) }, state };
}

/** `mm:ss` (or `h:mm:ss` from one hour) for a transcript offset. */
export function stamp(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Bulk mail per §4.1 step 2: List-Unsubscribe or Precedence: bulk. */
export const isBulk = (m: Pick<MailMessage, "headers">) =>
  m.headers?.["List-Unsubscribe"] !== undefined ||
  (m.headers?.Precedence ?? "").toLowerCase() === "bulk";

interface Hours {
  days: string[];
  start: string;
  end: string;
  lunch?: { start: string; end: string; protected?: boolean };
}

/** Owner busy intervals: declined and `free` events do not count. */
export function busyBlocks(events: AppleEvent[], owner: string) {
  return events
    .filter((e) => (e as AppleEvent & { availability?: string }).availability !== "free")
    .filter((e) => e.attendees.find((a) => a.email === owner)?.status !== "declined")
    .map((e) => ({ id: e.id, s: Date.parse(e.start), e: Date.parse(e.end) }));
}

/**
 * §4.4 step 2: candidate starts on a 30-minute grid inside working hours (lunch protected),
 * at least `bufferMinutes` away from every busy block and after `now`; ranked round-robin across
 * days (each day's earliest slot first), so the top three fall on different days.
 */
export function findFreeTime(opts: {
  events: AppleEvent[];
  owner: string;
  tz: string;
  hours: Hours;
  from: number;
  to: number;
  durationMin: number;
  bufferMin: number;
  now: number;
}): Slot[] {
  const busy = busyBlocks(opts.events, opts.owner);
  const buffer = opts.bufferMin * 60_000;
  const dur = opts.durationMin * 60_000;
  const byDay: number[][] = [];
  const first = localParts(opts.from, opts.tz).date;
  for (let d = 0; d < 31; d += 1) {
    const date = new Date(Date.parse(`${first}T12:00:00Z`) + d * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const dayStart = fromLocal(date, 0, opts.tz);
    if (dayStart >= opts.to) break;
    if (!opts.hours.days.includes(localParts(dayStart + 12 * 3_600_000, opts.tz).weekday)) continue;
    const starts: number[] = [];
    for (let m = hhmm(opts.hours.start); m + opts.durationMin <= hhmm(opts.hours.end); m += 30) {
      const s = fromLocal(date, m, opts.tz);
      const e = s + dur;
      if (s < opts.from || e > opts.to || s < opts.now) continue;
      const lunch = opts.hours.lunch;
      if (lunch?.protected && m < hhmm(lunch.end) && m + opts.durationMin > hhmm(lunch.start))
        continue;
      if (busy.some((b) => s < b.e + buffer && b.s - buffer < e)) continue;
      starts.push(s);
    }
    if (starts.length > 0) byDay.push(starts);
  }
  const ranked: number[] = [];
  for (let round = 0; byDay.some((d) => d.length > round); round += 1)
    for (const d of byDay) if (d[round] !== undefined) ranked.push(d[round] as number);
  return ranked.map((s) => ({ start: isoInZone(s, opts.tz), end: isoInZone(s + dur, opts.tz) }));
}

const lc = (v: unknown) => String(v ?? "").toLowerCase();
const snippet = (body: string) => body.replace(/\s+/g, " ").slice(0, 120);

function mailImpls(world: World, state: MailState): Record<string, ToolImpl> {
  const fixture = <T>(name: string, key: string): T[] => {
    const p = join(world.fx.dir, "fixtures", `${name}.json`);
    return existsSync(p) ? (structuredClone(JSON.parse(readFileSync(p, "utf8"))[key]) as T[]) : [];
  };
  state.mail = fixture<MailMessage>("mail", "messages");
  state.events = fixture<AppleEvent>("calendar", "events");
  state.transcripts = fixture<TranscriptFixture>("transcript", "transcripts");
  const tz = world.tz;
  const owner = world.owner;
  const counters = new Map<string, number>();
  const nextId = (prefix: string) => {
    const n = (counters.get(prefix) ?? 0) + 1;
    counters.set(prefix, n);
    return `${prefix}_${String(n).padStart(4, "0")}`;
  };
  const read = (output: unknown, ctx: ToolCtx, sources: string[]): ToolResult => {
    world.sources.set(ctx.callId, [...new Set(sources)]);
    return { output, provenance: "untrusted" };
  };
  const fail = (error: string, errorCode = "invalid_arguments"): ToolResult => ({
    output: { error, errorCode },
    isError: true,
    provenance: "trusted",
  });
  const wrote = async (
    info: ToolInfo,
    ctx: ToolCtx,
    args: Json,
    ids: string[],
    output: Json,
  ): Promise<ToolResult> => {
    state.writes.push({
      tool: info.name,
      callId: ctx.callId,
      ...(ctx.approvalId === undefined ? {} : { approvalId: ctx.approvalId }),
      args: structuredClone(args),
      ids,
    });
    const receipt = await world.broker().recordReceipt({
      kind: info.receiptKind ?? info.name,
      outcome: "ok",
      summary: `${info.name} ${ids.join(",")}`,
      taskId: ctx.taskId ?? null,
      toolCallId: ctx.callId,
      approvalId: ctx.approvalId ?? null,
      externalRefs: { ids: ids.join(",") },
      payload: { evaluator: { verdict: "verified" } },
    });
    return { output, provenance: "trusted", receiptId: receipt.id };
  };
  const message = (id: unknown) => state.mail.find((m) => m.id === id);
  const idList = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);

  return {
    // --- Mail ----------------------------------------------------------------------------------
    mail_search: async (_i, a, ctx) => {
      const since = instant(a.since, tz);
      const until = instant(a.until, tz);
      const from = lc(a.from);
      const text = lc(a.query);
      const hits = state.mail
        .filter(
          (m) =>
            (a.account === undefined || m.account === a.account) &&
            (a.mailbox === undefined || m.mailbox === a.mailbox) &&
            (a.unread === undefined || m.read !== a.unread) &&
            (since === undefined || Date.parse(m.date) >= since) &&
            (until === undefined || Date.parse(m.date) < until) &&
            (from === "" || lc(`${m.from.name} ${m.from.email}`).includes(from)) &&
            (text === "" || lc(`${m.subject} ${m.body}`).includes(text)),
        )
        .sort((x, y) => Date.parse(y.date) - Date.parse(x.date))
        .slice(0, Number(a.limit ?? 200));
      return read(
        hits.map((m) => ({
          id: m.id,
          account: m.account,
          from: m.from,
          subject: m.subject,
          date: m.date,
          read: m.read,
          flagged: m.flagged,
          bulk: isBulk(m),
          snippet: snippet(m.body),
        })),
        ctx,
        hits.map((m) => `email:${m.from.email}`),
      );
    },
    mail_read: async (_i, a, ctx) => {
      const m = message(a.id);
      if (m === undefined) return fail(`no message ${String(a.id)}`, "not_found");
      return read(
        {
          id: m.id,
          account: m.account,
          from: m.from,
          to: m.to,
          subject: m.subject,
          date: m.date,
          read: m.read,
          headers: m.headers ?? {},
          body: m.body,
          link: mailLink(m),
        },
        ctx,
        [`email:${m.from.email}`],
      );
    },
    mail_set_flags: async (info, a, ctx) => {
      const ids = idList(a.ids);
      if (ids.length === 0 || ids.length > 100) return fail("ids: 1 to 100 message ids");
      const missing = ids.filter((id) => message(id) === undefined);
      if (missing.length > 0) return fail(`no message ${missing.join(", ")}`, "not_found");
      for (const id of ids) {
        const m = message(id) as MailMessage;
        if (typeof a.read === "boolean") m.read = a.read;
        if (typeof a.flagged === "boolean") m.flagged = a.flagged;
      }
      return wrote(info, ctx, a, ids, { updated: ids.length });
    },
    mail_move: async (info, a, ctx) => {
      const ids = idList(a.ids);
      const box = String(a.mailbox ?? "").trim();
      if (ids.length === 0 || ids.length > 100 || box === "")
        return fail("ids (1 to 100) and mailbox are required");
      const missing = ids.filter((id) => message(id) === undefined);
      if (missing.length > 0) return fail(`no message ${missing.join(", ")}`, "not_found");
      for (const id of ids) (message(id) as MailMessage).mailbox = box;
      return wrote(info, ctx, a, ids, { moved: ids.length, mailbox: box });
    },
    mail_reply_draft: async (info, a, ctx) => {
      const m = message(a.id);
      if (m === undefined) return fail(`no message ${String(a.id)}`, "not_found");
      const body = String(a.body ?? "");
      if (body.trim() === "") return fail("body is required");
      const id = nextId("draft");
      state.drafts.push({
        id,
        replyTo: m.id,
        account: m.account,
        to: [m.from.email],
        subject: m.subject.startsWith("Re: ") ? m.subject : `Re: ${m.subject}`,
        body,
      });
      return wrote(info, ctx, a, [id], { draftId: id, to: [m.from.email] });
    },
    mail_forward_draft: async (info, a, ctx) => {
      const m = message(a.id);
      if (m === undefined) return fail(`no message ${String(a.id)}`, "not_found");
      const id = nextId("draft");
      state.drafts.push({ id, forwardOf: m.id, to: a.to, body: a.body ?? "" });
      return wrote(info, ctx, a, [id], { draftId: id });
    },
    mail_send_draft: async (info, a, ctx) => {
      const d = state.drafts.find((x) => x.id === a.draftId);
      if (d === undefined) return fail(`no draft ${String(a.draftId)}`, "not_found");
      state.sent.push(structuredClone(d));
      return wrote(info, ctx, a, [String(d.id)], { sent: d.id });
    },

    // --- Calendar (§4.4 step 2) ----------------------------------------------------------------
    calendar_find_free_time: async (_i, a, ctx) => {
      const w = (a.window ?? {}) as Json;
      const from = instant(w.start, tz);
      const to = instant(w.end, tz);
      const duration = Number(a.duration);
      if (from === undefined || to === undefined || !(to > from))
        return fail("window.start and window.end are required");
      if (!Number.isInteger(duration) || duration < 15 || duration > 240)
        return fail("duration: 15 to 240 minutes");
      const wh = (world.fx.owner.owner as Json).workingHours as Hours;
      const slots = findFreeTime({
        events: state.events,
        owner,
        tz,
        hours: { ...wh, ...((a.workingHours as Partial<Hours> | undefined) ?? {}) },
        from,
        to,
        durationMin: duration,
        bufferMin: Number(a.bufferMinutes ?? 15),
        now: world.clock.now(),
      }).slice(0, Number(a.limit ?? 10));
      state.freeTime.push({ callId: ctx.callId, slots });
      const inWindow = state.events.filter(
        (e) => Date.parse(e.start) < to && Date.parse(e.end) > from && e.organizer !== owner,
      );
      return read(
        { timeZone: tz, durationMinutes: duration, slots },
        ctx,
        inWindow.map((e) => `calendar:${e.organizer}`),
      );
    },

    // --- Speech (§8.4) -------------------------------------------------------------------------
    "speech.transcribe_file": async (_i, a, ctx) => {
      const t = state.transcripts.find((x) => x.path === a.path);
      if (t === undefined)
        return fail(`no file ${String(a.path)} in a granted folder`, "not_found");
      const max = Number(a.maxDurationMs ?? 4 * 3_600_000);
      if (t.audioMs > Math.min(max, 4 * 3_600_000))
        return fail("recording is longer than 4 hours", "too_long");
      const name = t.path.split("/").at(-1) ?? t.path;
      return read(
        {
          text: t.segments.map((s) => s.text).join(" "),
          segments: t.segments,
          engine: t.engine,
          language: t.language,
          audioMs: t.audioMs,
        },
        ctx,
        [`transcript:${name}`],
      );
    },

    // --- Reminders (R2) ------------------------------------------------------------------------
    reminders_create: async (info, a, ctx) => {
      const title = String(a.title ?? "").trim();
      if (title === "") return fail("title is required");
      const id = nextId("rem");
      state.reminders.push({
        id,
        list: a.list ?? "Reminders",
        title,
        due: a.due ?? null,
        notes: a.notes ?? "",
        url: a.url ?? null,
        completed: false,
      });
      return wrote(info, ctx, a, [id], { id, title });
    },
  };
}
