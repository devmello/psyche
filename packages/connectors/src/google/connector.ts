import { PsycheError, type ToolCallDescription } from "@psyche/protocol";
import { canonicalJSON, sha256 } from "../framework/binding.ts";
import type {
  CatalogueEntry,
  ConnectInput,
  Connector,
  ConnectorAction,
  ConnectorContext,
  ConnectorFactory,
  ConnectorHealth,
  ConnectorRecord,
  ConnectorTool,
  ConnectResult,
  SyncResult,
  ToolOutput,
} from "../framework/types.ts";
import { GoogleApi } from "./api.ts";
import {
  type GmailScopeChoice,
  GoogleAuth,
  GoogleAuthError,
  type GoogleAuthOptions,
  scopesFor,
} from "./auth.ts";
import { Calendar, type EventInput } from "./calendar.ts";
import { Drive } from "./drive.ts";
import { Gmail } from "./gmail.ts";
import { canonicalAddress, type OutgoingMail } from "./mime.ts";

/** Matrix rows (M11). `send` / calendar writes ask by default; deletes can never be `allow`. */
export const GOOGLE_ACTIONS: ConnectorAction[] = [
  { id: "gmail.read", title: "Read and search mail", sideEffect: "read", defaultRule: "allow" },
  {
    id: "gmail.attachments",
    title: "Save attachments to the Library",
    sideEffect: "read",
    defaultRule: "allow",
  },
  {
    id: "gmail.labels",
    title: "Label and archive threads",
    sideEffect: "write",
    approvalKind: "connector_action",
    defaultRule: "ask",
  },
  {
    id: "gmail.draft",
    title: "Create drafts",
    sideEffect: "write",
    approvalKind: "connector_action",
    defaultRule: "allow",
  },
  {
    id: "gmail.send",
    title: "Send mail",
    // Sending to a third party is irreversible and outward-facing (security §3.1): destructive,
    // so standing grants stop at `task` and the card is device-only.
    sideEffect: "destructive",
    approvalKind: "send_email",
    defaultRule: "ask",
  },
  {
    id: "calendar.read",
    title: "Read calendars and free/busy",
    sideEffect: "read",
    defaultRule: "allow",
  },
  {
    id: "calendar.write",
    title: "Create and change events",
    sideEffect: "write",
    approvalKind: "calendar_write",
    defaultRule: "ask",
  },
  {
    id: "calendar.delete",
    title: "Delete events",
    sideEffect: "destructive",
    approvalKind: "calendar_write",
    defaultRule: "ask",
  },
  {
    id: "drive.read",
    title: "Download files Psyche can see",
    sideEffect: "read",
    defaultRule: "allow",
  },
  {
    id: "drive.upload",
    title: "Upload files to Drive",
    sideEffect: "write",
    approvalKind: "connector_action",
    defaultRule: "ask",
  },
];

export const GOOGLE_CATALOGUE: CatalogueEntry = {
  type: "google",
  id: "google",
  label: "Google",
  description: "Gmail, Google Calendar and the Drive files you pick.",
  category: "first_party",
  vendor: "Google",
  auth: "oauth",
  scopes: { read: scopesFor("read"), read_act: scopesFor("read_act") },
  actions: GOOGLE_ACTIONS,
  setupGuide: "docs/copy/onboarding.md#setting-up-google",
  docsUrl: "https://developers.google.com/identity/protocols/oauth2/native-app",
  available: true,
};

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const str = { type: "string" };
const strs = { type: "array", items: { type: "string" }, maxItems: 100 };
const time = {
  type: "object",
  properties: { dateTime: str, date: str, timeZone: str },
  additionalProperties: false,
};
const eventSchema = obj(
  {
    summary: str,
    description: str,
    location: str,
    start: time,
    end: time,
    attendees: {
      type: "array",
      items: obj({ email: str, optional: { type: "boolean" } }, ["email"]),
      maxItems: 100,
    },
    recurrence: strs,
  },
  [],
);
const mailSchema = obj(
  {
    to: strs,
    cc: strs,
    bcc: strs,
    subject: str,
    body: str,
    threadId: str,
    inReplyTo: str,
    references: strs,
  },
  ["to", "subject", "body"],
);

interface MailParams {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  threadId?: string;
  inReplyTo?: string;
  references?: string[];
}

function asObject(params: unknown): Record<string, unknown> {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    throw new PsycheError("invalid_params", "parameters must be an object");
  }
  return params as Record<string, unknown>;
}

function strArray(v: unknown, name: string): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) {
    throw new PsycheError("invalid_params", `${name} must be a list of strings`);
  }
  return v as string[];
}

function reqString(v: unknown, name: string): string {
  if (typeof v !== "string" || v === "")
    throw new PsycheError("invalid_params", `${name} is required`);
  return v;
}

function mailParams(params: unknown): MailParams {
  const p = asObject(params);
  const out: MailParams = {
    to: strArray(p.to, "to"),
    cc: strArray(p.cc, "cc"),
    bcc: strArray(p.bcc, "bcc"),
    subject: typeof p.subject === "string" ? p.subject : "",
    body: typeof p.body === "string" ? p.body : "",
  };
  if (typeof p.threadId === "string") out.threadId = p.threadId;
  if (typeof p.inReplyTo === "string") out.inReplyTo = p.inReplyTo;
  if (p.references !== undefined) out.references = strArray(p.references, "references");
  return out;
}

function toMail(m: MailParams): OutgoingMail {
  const mail: OutgoingMail = {
    to: m.to,
    cc: m.cc ?? [],
    bcc: m.bcc ?? [],
    subject: m.subject,
    text: m.body,
  };
  if (m.inReplyTo !== undefined) mail.inReplyTo = m.inReplyTo;
  if (m.references !== undefined) mail.references = m.references;
  return mail;
}

const sortedLower = (xs: string[] | undefined) => [...(xs ?? [])].map(canonicalAddress).sort();

/** Security §3.5 `email.send`: account, recipients (lowercased, sorted), subject, body hash, attachment hashes. */
export function sendBinding(account: string, params: unknown): ToolCallDescription {
  const m = mailParams(params);
  const to = sortedLower(m.to);
  const cc = sortedLower(m.cc);
  const bcc = sortedLower(m.bcc);
  const recipients = [...new Set([...to, ...cc, ...bcc])].sort();
  return {
    kind: "send_email",
    target: { kind: "recipient", value: recipients.join(","), display: recipients.join(", ") },
    bindingFields: {
      account,
      to,
      cc,
      bcc,
      subject: m.subject,
      bodyHash: sha256(m.body),
      attachmentHashes: [],
      threadId: m.threadId ?? null,
      inReplyTo: m.inReplyTo ?? null,
      references: m.references ?? [],
    },
    grantKey: `send_email:${account}:${recipients.join(",")}`,
    summary: `Sent "${m.subject.slice(0, 60)}" to ${recipients.join(", ").slice(0, 120)}`,
  };
}

/**
 * Security §3.5 `calendar.*`: account, operation, event payload hash; grant key account +
 * calendar + operation. An event that invites people (attendees, or `sendUpdates: "all"`) also
 * emails them, so its target is the attendee set and the grant key includes it: a standing
 * grant for "create events" never covers inviting someone new (§3.6 new-target check).
 */
export function calendarBinding(
  account: string,
  operation: "create" | "update" | "delete",
  params: unknown,
): ToolCallDescription {
  const p = asObject(params);
  const calendarId = typeof p.calendarId === "string" ? p.calendarId : "primary";
  const event = (typeof p.event === "object" && p.event !== null ? p.event : {}) as {
    attendees?: unknown;
  };
  const attendees = (Array.isArray(event.attendees) ? event.attendees : [])
    .map((a) =>
      typeof a === "object" && a !== null ? (a as { email?: unknown }).email : undefined,
    )
    .filter((e): e is string => typeof e === "string")
    .map((e) => e.trim().toLowerCase())
    .sort();
  const notifies = p.sendUpdates === "all";
  const payload = {
    eventId: p.eventId ?? null,
    event: p.event ?? null,
    sendUpdates: p.sendUpdates ?? "none",
  };
  const verb = operation === "create" ? "Created" : operation === "update" ? "Updated" : "Deleted";
  const invites = attendees.length > 0 || notifies;
  return {
    kind: "calendar_write",
    sideEffect: operation === "delete" ? "destructive" : "write",
    target: invites
      ? {
          kind: "recipient",
          value: attendees.length > 0 ? attendees.join(",") : `notify:${calendarId}`,
          display: attendees.length > 0 ? attendees.join(", ") : "existing attendees",
        }
      : { kind: "account", value: account },
    bindingFields: {
      account,
      calendarId,
      operation,
      attendees,
      sendUpdates: notifies ? "all" : "none",
      eventHash: sha256(canonicalJSON(payload)),
    },
    grantKey: invites
      ? `calendar_write:${account}:${calendarId}:${operation}:invite:${attendees.join(",")}`
      : `calendar_write:${account}:${calendarId}:${operation}`,
    summary: `${verb} an event on ${calendarId}${attendees.length > 0 ? ` with ${attendees.join(", ")}` : ""}`,
  };
}

/** Other writes (labels, drafts, uploads): connector id, tool, params hash. */
export function actionBinding(
  connectorId: string,
  tool: string,
  params: unknown,
): ToolCallDescription {
  return {
    kind: "connector_action",
    target: { kind: "account", value: connectorId },
    bindingFields: { connectorId, tool, paramsHash: sha256(canonicalJSON(params ?? {})) },
    grantKey: `connector_action:${connectorId}:${tool}`,
  };
}

export class GoogleConnector implements Connector {
  readonly id: string;
  readonly type = "google";
  readonly #ctx: ConnectorContext;
  readonly #auth: GoogleAuth;
  readonly #gmail: Gmail;
  readonly #calendar: Calendar;
  readonly #drive: Drive;
  #account: string | null;
  #gmailScopes: GmailScopeChoice;
  #status: ConnectorRecord["status"];

  constructor(record: ConnectorRecord, ctx: ConnectorContext, options: GoogleAuthOptions) {
    this.id = record.id;
    this.#ctx = ctx;
    const cfg = record.config as {
      clientId?: unknown;
      clientSecret?: unknown;
      gmailScopes?: unknown;
    };
    if (typeof cfg.clientId !== "string")
      throw new PsycheError("invalid_params", "config.clientId is required");
    this.#auth = new GoogleAuth(
      record.id,
      ctx,
      {
        clientId: cfg.clientId,
        ...(typeof cfg.clientSecret === "string" ? { clientSecret: cfg.clientSecret } : {}),
      },
      options,
    );
    const api = new GoogleApi(this.#auth, ctx.fetch);
    this.#gmail = new Gmail(api);
    this.#calendar = new Calendar(api);
    this.#drive = new Drive(api);
    this.#account = record.account;
    this.#gmailScopes = cfg.gmailScopes === "readonly_send" ? "readonly_send" : "modify";
    this.#status = record.status;
  }

  async connect(input: ConnectInput): Promise<ConnectResult> {
    const choice = input.config.gmailScopes === "readonly_send" ? "readonly_send" : "modify";
    this.#gmailScopes = choice;
    const scopes = scopesFor(input.scopeMode, choice);
    // Reconnecting (re-auth, mode change): drop the old grant first so a read-only connection
    // cannot keep a refresh token that still carries gmail.send / gmail.modify.
    await this.#auth.revoke(input.signal);
    const tokens = await this.#auth.authorize(scopes, input.signal);
    const granted = (tokens.scope ?? "").split(/\s+/).filter((x) => x !== "");
    const profile = await this.#gmail.profile(input.signal);
    if (typeof profile.emailAddress !== "string")
      throw new PsycheError("internal", "Gmail profile has no address");
    this.#account = profile.emailAddress.toLowerCase();
    this.#status = "connected";
    return {
      account: this.#account,
      scopes: granted.length > 0 ? granted : scopes,
      config: { gmailScopes: choice },
    };
  }

  async disconnect(): Promise<void> {
    await this.#auth.revoke();
    this.#status = "disconnected";
  }

  actions(): ConnectorAction[] {
    // `readonly + send` cannot label or archive.
    return GOOGLE_ACTIONS.filter(
      (a) => !(a.id === "gmail.labels" && this.#gmailScopes === "readonly_send"),
    );
  }

  async health(): Promise<ConnectorHealth> {
    const checkedAt = this.#ctx.clock.now();
    try {
      await this.#gmail.profile();
      return { ok: true, status: "connected", checkedAt };
    } catch (err) {
      const status = err instanceof GoogleAuthError ? "needs_auth" : "error";
      return {
        ok: false,
        status,
        detail: err instanceof Error ? err.message : String(err),
        checkedAt,
      };
    }
  }

  /** Gmail `history.list` from the saved id and each calendar's `syncToken` (primary by default). */
  async sync(cursor: Record<string, unknown> | null, signal?: AbortSignal): Promise<SyncResult> {
    return this.#guard(async () => {
      const c = (cursor ?? {}) as {
        gmail?: { historyId?: string };
        calendars?: Record<string, string>;
      };
      const mail = await this.#gmail.sync(c.gmail?.historyId, signal);
      const calendars: Record<string, string> = {};
      let events = 0;
      let full = mail.full;
      for (const id of Object.keys(c.calendars ?? { primary: "" })) {
        const token = c.calendars?.[id];
        const r = await this.#calendar.sync(id, token === "" ? undefined : token, signal);
        calendars[id] = r.syncToken;
        events += r.changed.length;
        full = full || r.full;
      }
      return {
        changes: mail.messageIds.length + events,
        full,
        cursor: {
          gmail: { historyId: mail.historyId },
          calendars,
          newMessageIds: mail.messageIds.slice(0, 500),
        },
      };
    });
  }

  tools(): ConnectorTool[] {
    const account = () => {
      if (this.#account === null) throw new PsycheError("unavailable", "Google is not connected");
      return this.#account;
    };
    const untrusted = (output: unknown, extra: Partial<ToolOutput> = {}): ToolOutput => ({
      output,
      provenance: "untrusted",
      ...extra,
    });
    const tools: ConnectorTool[] = [
      {
        name: "gmail_search_threads",
        action: "gmail.read",
        description:
          "Search Gmail threads with Gmail query syntax. Returns subjects, senders and snippets.",
        inputSchema: obj({
          query: str,
          labelIds: strs,
          maxResults: { type: "integer", minimum: 1, maximum: 50 },
          pageToken: str,
        }),
        sideEffect: "read",
        execute: (p, ctx) =>
          this.#guard(async () => {
            const o = asObject(p ?? {});
            const input: Parameters<Gmail["listThreads"]>[0] = {};
            if (typeof o.query === "string") input.query = o.query;
            if (o.labelIds !== undefined) input.labelIds = strArray(o.labelIds, "labelIds");
            if (typeof o.maxResults === "number") input.maxResults = o.maxResults;
            if (typeof o.pageToken === "string") input.pageToken = o.pageToken;
            return untrusted(await this.#gmail.listThreads(input, ctx.signal));
          }),
      },
      {
        name: "gmail_read_thread",
        action: "gmail.read",
        description:
          "Read a Gmail thread: headers, plain-text bodies (HTML stripped of hidden content) and attachment list.",
        inputSchema: obj({ threadId: str }, ["threadId"]),
        sideEffect: "read",
        execute: (p, ctx) =>
          this.#guard(async () =>
            untrusted(
              await this.#gmail.readThread(reqString(asObject(p).threadId, "threadId"), ctx.signal),
            ),
          ),
      },
      {
        name: "gmail_list_labels",
        action: "gmail.read",
        description: "List Gmail labels.",
        inputSchema: obj({}),
        sideEffect: "read",
        execute: (_p, ctx) =>
          this.#guard(async () => untrusted(await this.#gmail.listLabels(ctx.signal))),
      },
      {
        name: "gmail_save_attachment",
        action: "gmail.attachments",
        description:
          "Save one attachment of a message to the Library (25 MB limit). Returns the Library item id.",
        inputSchema: obj({ messageId: str, partId: str }, ["messageId", "partId"]),
        sideEffect: "read",
        execute: (p, ctx) =>
          this.#guard(async () => {
            const o = asObject(p);
            const messageId = reqString(o.messageId, "messageId");
            const partId = reqString(o.partId, "partId");
            const msg = await this.#gmail.message(messageId, ctx.signal);
            const attachment = msg.attachments.find((a) => a.partId === partId);
            if (attachment === undefined) throw new PsycheError("not_found", "no such attachment");
            const saved = await this.#gmail.saveAttachment(
              { connectorId: this.id, messageId, attachment },
              this.#ctx.library,
              ctx.signal,
            );
            return untrusted({
              ...saved,
              filename: attachment.filename,
              mimeType: attachment.mimeType,
            });
          }),
      },
      {
        name: "gmail_modify_labels",
        action: "gmail.labels",
        description: "Add or remove labels on a thread (remove INBOX to archive).",
        inputSchema: obj({ threadId: str, add: strs, remove: strs }, ["threadId"]),
        sideEffect: "write",
        describeCall: (p) => actionBinding(this.id, "gmail_modify_labels", p),
        execute: (p, ctx) =>
          this.#guard(async () => {
            const o = asObject(p);
            const threadId = reqString(o.threadId, "threadId");
            const r = await this.#gmail.modifyThreadLabels(
              threadId,
              strArray(o.add, "add"),
              strArray(o.remove, "remove"),
              ctx.signal,
            );
            return untrusted(
              { threadId: r.id ?? threadId },
              { externalRefs: { threadId }, receiptSummary: `Relabelled thread ${threadId}` },
            );
          }),
      },
      {
        name: "gmail_create_draft",
        action: "gmail.draft",
        description:
          "Create a draft (plain text). Use threadId, inReplyTo and references to reply in a thread.",
        inputSchema: mailSchema,
        sideEffect: "write",
        describeCall: (p) => actionBinding(this.id, "gmail_create_draft", p),
        execute: (p, ctx) =>
          this.#guard(async () => {
            const m = mailParams(p);
            const r = await this.#gmail.createDraft(toMail(m), m.threadId, ctx.signal);
            return untrusted(
              { draftId: r.id, messageId: r.message?.id, threadId: r.message?.threadId },
              {
                externalRefs: { draftId: r.id ?? "" },
                receiptSummary: `Drafted "${m.subject.slice(0, 60)}"`,
              },
            );
          }),
      },
      {
        name: "gmail_send",
        action: "gmail.send",
        description:
          "Send an email (plain text). Requires the owner's approval of the exact recipients, subject and body.",
        inputSchema: mailSchema,
        sideEffect: "destructive",
        describeCall: (p) => sendBinding(account(), p),
        execute: (p, ctx) =>
          this.#guard(async () => {
            const m = mailParams(p);
            const r = await this.#gmail.send(toMail(m), m.threadId, ctx.signal);
            return untrusted(
              { messageId: r.id, threadId: r.threadId },
              {
                externalRefs: { messageId: r.id ?? "", threadId: r.threadId ?? "" },
                receiptSummary: sendBinding(account(), p).summary ?? "Sent mail",
              },
            );
          }),
      },
      {
        name: "calendar_list_calendars",
        action: "calendar.read",
        description: "List the owner's calendars.",
        inputSchema: obj({}),
        sideEffect: "read",
        execute: (_p, ctx) =>
          this.#guard(async () => untrusted(await this.#calendar.listCalendars(ctx.signal))),
      },
      {
        name: "calendar_list_events",
        action: "calendar.read",
        description: "List events in a time range (RFC 3339 timeMin / timeMax, at most 366 days).",
        inputSchema: obj(
          {
            calendarId: str,
            timeMin: str,
            timeMax: str,
            query: str,
            maxResults: { type: "integer", minimum: 1, maximum: 250 },
          },
          ["timeMin", "timeMax"],
        ),
        sideEffect: "read",
        execute: (p, ctx) =>
          this.#guard(async () => {
            const o = asObject(p);
            const input: Parameters<Calendar["listEvents"]>[0] = {
              timeMin: reqString(o.timeMin, "timeMin"),
              timeMax: reqString(o.timeMax, "timeMax"),
            };
            if (typeof o.calendarId === "string") input.calendarId = o.calendarId;
            if (typeof o.query === "string") input.query = o.query;
            if (typeof o.maxResults === "number") input.maxResults = o.maxResults;
            return untrusted(await this.#calendar.listEvents(input, ctx.signal));
          }),
      },
      {
        name: "calendar_free_busy",
        action: "calendar.read",
        description: "Busy intervals for up to 50 calendars in a time range.",
        inputSchema: obj({ timeMin: str, timeMax: str, calendarIds: strs, timeZone: str }, [
          "timeMin",
          "timeMax",
        ]),
        sideEffect: "read",
        execute: (p, ctx) =>
          this.#guard(async () => {
            const o = asObject(p);
            const ids = strArray(o.calendarIds, "calendarIds");
            return untrusted(
              await this.#calendar.freeBusy(
                {
                  timeMin: reqString(o.timeMin, "timeMin"),
                  timeMax: reqString(o.timeMax, "timeMax"),
                  calendarIds: ids.length === 0 ? ["primary"] : ids,
                  ...(typeof o.timeZone === "string" ? { timeZone: o.timeZone } : {}),
                },
                ctx.signal,
              ),
            );
          }),
      },
      {
        name: "calendar_create_event",
        action: "calendar.write",
        description: 'Create an event. sendUpdates "all" emails the attendees.',
        inputSchema: obj(
          { calendarId: str, event: eventSchema, sendUpdates: { enum: ["all", "none"] } },
          ["event"],
        ),
        sideEffect: "write",
        describeCall: (p) => calendarBinding(account(), "create", p),
        execute: (p, ctx) =>
          this.#guard(async () => {
            const o = asObject(p);
            const calendarId = typeof o.calendarId === "string" ? o.calendarId : "primary";
            const e = await this.#calendar.createEvent(
              calendarId,
              asObject(o.event) as unknown as EventInput,
              o.sendUpdates === "all" ? "all" : "none",
              ctx.signal,
            );
            return untrusted(e, {
              externalRefs: { eventId: e.id, calendarId },
              receiptSummary: `Created "${e.summary}"`,
            });
          }),
      },
      {
        name: "calendar_update_event",
        action: "calendar.write",
        description: "Change fields of an event (partial update).",
        inputSchema: obj(
          {
            calendarId: str,
            eventId: str,
            event: eventSchema,
            sendUpdates: { enum: ["all", "none"] },
          },
          ["eventId", "event"],
        ),
        sideEffect: "write",
        describeCall: (p) => calendarBinding(account(), "update", p),
        execute: (p, ctx) =>
          this.#guard(async () => {
            const o = asObject(p);
            const calendarId = typeof o.calendarId === "string" ? o.calendarId : "primary";
            const eventId = reqString(o.eventId, "eventId");
            const e = await this.#calendar.updateEvent(
              calendarId,
              eventId,
              asObject(o.event) as Partial<EventInput>,
              o.sendUpdates === "all" ? "all" : "none",
              ctx.signal,
            );
            return untrusted(e, {
              externalRefs: { eventId, calendarId },
              receiptSummary: `Updated "${e.summary}"`,
            });
          }),
      },
      {
        name: "calendar_delete_event",
        action: "calendar.delete",
        description: "Delete an event.",
        inputSchema: obj(
          { calendarId: str, eventId: str, sendUpdates: { enum: ["all", "none"] } },
          ["eventId"],
        ),
        sideEffect: "destructive",
        describeCall: (p) => calendarBinding(account(), "delete", p),
        execute: (p, ctx) =>
          this.#guard(async () => {
            const o = asObject(p);
            const calendarId = typeof o.calendarId === "string" ? o.calendarId : "primary";
            const eventId = reqString(o.eventId, "eventId");
            await this.#calendar.deleteEvent(
              calendarId,
              eventId,
              o.sendUpdates === "all" ? "all" : "none",
              ctx.signal,
            );
            return untrusted(
              { deleted: eventId },
              { externalRefs: { eventId, calendarId }, receiptSummary: `Deleted event ${eventId}` },
            );
          }),
      },
      {
        name: "drive_download",
        action: "drive.read",
        description:
          "Download a Drive file Psyche has access to into the Library (Google Docs are exported as PDF).",
        inputSchema: obj({ fileId: str }, ["fileId"]),
        sideEffect: "read",
        execute: (p, ctx) =>
          this.#guard(async () =>
            untrusted(
              await this.#drive.download(
                { connectorId: this.id, fileId: reqString(asObject(p).fileId, "fileId") },
                this.#ctx.library,
                ctx.signal,
              ),
            ),
          ),
      },
      {
        name: "drive_upload",
        action: "drive.upload",
        description: "Upload a text file to Drive.",
        inputSchema: obj({ name: str, mimeType: str, content: str, parentId: str }, [
          "name",
          "content",
        ]),
        sideEffect: "write",
        describeCall: (p) => actionBinding(this.id, "drive_upload", p),
        execute: (p, ctx) =>
          this.#guard(async () => {
            const o = asObject(p);
            const r = await this.#drive.upload(
              {
                name: reqString(o.name, "name"),
                mimeType: typeof o.mimeType === "string" ? o.mimeType : "text/plain",
                bytes: Buffer.from(typeof o.content === "string" ? o.content : "", "utf8"),
                ...(typeof o.parentId === "string" ? { parentId: o.parentId } : {}),
              },
              ctx.signal,
            );
            return untrusted(r, {
              externalRefs: { fileId: r.id ?? "" },
              receiptSummary: `Uploaded ${r.name ?? "a file"} to Drive`,
            });
          }),
      },
    ];
    const allowed = new Set(this.actions().map((a) => a.id));
    return tools.filter((t) => allowed.has(t.action));
  }

  /** Revoked or expired tokens move the connector to `needs_auth` and invalidate pending work. */
  async #guard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (
        err instanceof GoogleAuthError &&
        (err.reason === "token_revoked" || err.reason === "testing_mode_expired")
      ) {
        if (this.#status !== "needs_auth") {
          this.#status = "needs_auth";
          this.#ctx.emit({
            type: "status",
            connectorId: this.id,
            status: "needs_auth",
            reason: err.reason,
          });
          this.#ctx.emit({
            type: "invalidated",
            connectorId: this.id,
            reason: "token_revoked",
            previousAccount: this.#account,
            account: this.#account,
          });
        }
      }
      throw err;
    }
  }
}

export function googleFactory(options: GoogleAuthOptions): ConnectorFactory {
  return {
    entry: GOOGLE_CATALOGUE,
    create: (record, ctx) => new GoogleConnector(record, ctx, options),
  };
}
