import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolResult } from "@psyche/protocol";
import type { StackOverrides } from "../../../packages/testing/src/scenarios/stack.ts";
import type { Json } from "../../../packages/testing/src/scenarios/types.ts";
import { fromLocal } from "../../../packages/testing/src/scenarios/util.ts";
import type {
  ToolCtx,
  ToolImpl,
  ToolInfo,
  World,
} from "../../../packages/testing/src/scenarios/world.ts";
import { ROOT } from "./report.ts";

/**
 * Fakes for the Apple app flows (docs/connectors/apple-apps-2026.md §7.4, flows 1, 2 and 5),
 * plugged into S18's scenario Stack through `StackOverrides.impls`. The tool rows are in
 * tests/scenarios/shared/apple-tools.json; the scenarios are in tests/acceptance/scenarios-apple.
 *
 * Each executor reads its scenario's `fixtures/<app>.json` (mail, reminders, calendar, contacts,
 * notes), keeps an in-memory copy, and records every write in `AppleState.writes` so a test can
 * check what reached "the app". Lists are newest first (mail, notes) or in start order (events).
 * Ids for new objects are deterministic per prefix (`rem_0001`, `note_0001`, `draft_0001`).
 *
 * Reads return `untrusted` results and name their taint sources the way the World does:
 * `email:<sender>`, `calendar:<organizer>` (invitations only), `contact:<email>`, `note:<id>`.
 * Writes record a receipt with the provider ids (the loop then adds none of its own).
 */

export const APPLE_SCENARIOS_DIR = join(ROOT, "tests/acceptance/scenarios-apple");
export const APPLE_SCENARIO_IDS = [
  "v1-apple-mail-to-reminders",
  "v2-apple-meeting-prep",
  "v5-apple-notes-append",
] as const;
export type AppleScenarioId = (typeof APPLE_SCENARIO_IDS)[number];

export interface MailMessage {
  id: string;
  messageId: string;
  mailbox: string;
  from: { name: string; email: string };
  to: string[];
  subject: string;
  date: string;
  read: boolean;
  flagged: boolean;
  body: string;
}

export interface AppleNote {
  id: string;
  title: string;
  folder: string;
  modified: string;
  body: string;
  sharedBy?: string;
}

export interface AppleEvent {
  id: string;
  calendar: string;
  title: string;
  start: string;
  end: string;
  organizer: string;
  attendees: { name: string; email: string; status: string }[];
  notes: string;
  location?: string;
  url?: string;
}

export interface AppleContact {
  id: string;
  name: string;
  emails: string[];
  phones?: string[];
  organization?: string;
  jobTitle?: string;
}

export interface AppleWrite {
  tool: string;
  callId: string;
  approvalId?: string;
  args: Json;
  /** Ids the app allocated or changed. */
  ids: string[];
}

export interface AppleState {
  mail: MailMessage[];
  reminders: Json[];
  events: AppleEvent[];
  contacts: AppleContact[];
  notes: AppleNote[];
  drafts: Json[];
  sent: Json[];
  writes: AppleWrite[];
}

/** `message://%3C<Message-ID>%3E`: the link Mail opens (connector plan §4.1, M4). */
export const mailLink = (m: Pick<MailMessage, "messageId">) => `message://%3C${m.messageId}%3E`;

/** The overrides and the fakes' state for one Apple app scenario. */
export function appleOverrides(): { overrides: StackOverrides; state: AppleState } {
  const state: AppleState = {
    mail: [],
    reminders: [],
    events: [],
    contacts: [],
    notes: [],
    drafts: [],
    sent: [],
    writes: [],
  };
  return { overrides: { impls: (world) => appleImpls(world, state) }, state };
}

/** A date (`YYYY-MM-DD`, local midnight in `tz`) or an ISO instant, as epoch ms. */
export function instant(v: unknown, tz: string): number | undefined {
  if (typeof v !== "string" || v === "") return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return fromLocal(v, 0, tz);
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? undefined : ms;
}

const lc = (v: unknown) => String(v ?? "").toLowerCase();
const snippet = (body: string) => body.replace(/\s+/g, " ").slice(0, 120);

function appleImpls(world: World, state: AppleState): Record<string, ToolImpl> {
  const fixture = <T>(name: string, key: string): T[] => {
    const p = join(world.fx.dir, "fixtures", `${name}.json`);
    return existsSync(p) ? (structuredClone(JSON.parse(readFileSync(p, "utf8"))[key]) as T[]) : [];
  };
  state.mail = fixture<MailMessage>("mail", "messages");
  state.reminders = fixture<Json>("reminders", "reminders");
  state.events = fixture<AppleEvent>("calendar", "events");
  state.contacts = fixture<AppleContact>("contacts", "contacts");
  state.notes = fixture<AppleNote>("notes", "notes");
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
  /** Records the write and its receipt; returns the result the loop sees. */
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
  const note = (id: unknown) => state.notes.find((n) => n.id === id);
  const newestFirst = <T extends { date?: string; modified?: string }>(xs: T[]) =>
    [...xs].sort(
      (a, b) => Date.parse(String(b.date ?? b.modified)) - Date.parse(String(a.date ?? a.modified)),
    );

  return {
    // --- Mail (connector plan §4.1) ------------------------------------------------------------
    mail_search: async (_i, a, ctx) => {
      const since = instant(a.since, tz);
      const until = instant(a.until, tz);
      const from = lc(a.from);
      const text = lc(a.query ?? a.text);
      const hits = newestFirst(
        state.mail.filter(
          (m) =>
            (a.mailbox === undefined || m.mailbox === a.mailbox) &&
            (a.unread === undefined || m.read !== a.unread) &&
            (since === undefined || Date.parse(m.date) >= since) &&
            (until === undefined || Date.parse(m.date) < until) &&
            (from === "" || lc(`${m.from.name} ${m.from.email}`).includes(from)) &&
            (text === "" || lc(`${m.subject} ${m.body}`).includes(text)),
        ),
      ).slice(0, Number(a.limit ?? 50));
      return read(
        hits.map((m) => ({
          id: m.id,
          from: m.from,
          subject: m.subject,
          date: m.date,
          read: m.read,
          flagged: m.flagged,
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
          from: m.from,
          to: m.to,
          subject: m.subject,
          date: m.date,
          read: m.read,
          body: m.body,
          link: mailLink(m),
        },
        ctx,
        [`email:${m.from.email}`],
      );
    },
    mail_set_flags: async (info, a, ctx) => {
      const ids = Array.isArray(a.ids) ? a.ids.map(String) : [];
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

    // --- Reminders (§4.2) ----------------------------------------------------------------------
    reminders_create: async (info, a, ctx) => {
      const title = String(a.title ?? "").trim();
      if (title === "") return fail("title is required");
      if (a.url !== undefined && !/^(message|https?):\/\//.test(String(a.url)))
        return fail("url must be a message:// or http(s) link");
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

    // --- Calendar (§4.3) -----------------------------------------------------------------------
    calendar_list_events: async (_i, a, ctx) => {
      const start = instant(a.start, tz) ?? Number.NEGATIVE_INFINITY;
      const end = instant(a.end, tz) ?? Number.POSITIVE_INFINITY;
      const q = lc(a.query);
      const hits = state.events
        .filter(
          (e) =>
            Date.parse(e.start) < end &&
            Date.parse(e.end) > start &&
            (q === "" || lc(`${e.title} ${e.notes}`).includes(q)),
        )
        .sort((x, y) => Date.parse(x.start) - Date.parse(y.start));
      return read(
        hits,
        ctx,
        hits.filter((e) => e.organizer !== owner).map((e) => `calendar:${e.organizer}`),
      );
    },

    // --- Contacts (§4.5) -----------------------------------------------------------------------
    contacts_search: async (_i, a, ctx) => {
      const q = lc(a.query);
      if (q === "") return fail("query is required");
      const hits = state.contacts.filter((c) =>
        lc(
          [c.name, ...c.emails, ...(c.phones ?? []), c.organization ?? "", c.jobTitle ?? ""].join(
            " ",
          ),
        ).includes(q),
      );
      return read(
        hits,
        ctx,
        hits.flatMap((c) => c.emails.map((e) => `contact:${e}`)),
      );
    },

    // --- Notes (§4.4) --------------------------------------------------------------------------
    notes_search: async (_i, a, ctx) => {
      const q = lc(a.query);
      const since = instant(a.since, tz);
      const hits = newestFirst(
        state.notes.filter(
          (n) =>
            (q === "" || lc(`${n.title} ${n.body}`).includes(q)) &&
            (a.folder === undefined || n.folder === a.folder) &&
            (since === undefined || Date.parse(n.modified) >= since),
        ),
      ).slice(0, Number(a.limit ?? 20));
      return read(
        hits.map((n) => ({
          id: n.id,
          title: n.title,
          folder: n.folder,
          modified: n.modified,
          snippet: snippet(n.body),
          ...(n.sharedBy === undefined ? {} : { sharedBy: n.sharedBy }),
        })),
        ctx,
        hits.map((n) => `note:${n.id}`),
      );
    },
    notes_read: async (_i, a, ctx) => {
      const n = note(a.id);
      if (n === undefined) return fail(`no note ${String(a.id)}`, "not_found");
      return read({ ...n }, ctx, [`note:${n.id}`]);
    },
    notes_create: async (info, a, ctx) => {
      const title = String(a.title ?? "").trim();
      if (title === "") return fail("title is required");
      const id = nextId("note");
      const now = new Date(world.clock.now()).toISOString();
      state.notes.push({
        id,
        title,
        folder: String(a.folder ?? "Notes"),
        modified: now,
        body: String(a.body ?? ""),
      });
      return wrote(info, ctx, a, [id], { id, title });
    },
    notes_append: async (info, a, ctx) => {
      const n = note(a.id);
      if (n === undefined) return fail(`no note ${String(a.id)}`, "not_found");
      const text = String(a.text ?? "");
      if (text.trim() === "") return fail("text is required");
      n.body = `${n.body}\n\n${text}`;
      n.modified = new Date(world.clock.now()).toISOString();
      return wrote(info, ctx, a, [n.id], { id: n.id, appended: text.length });
    },
  };
}
