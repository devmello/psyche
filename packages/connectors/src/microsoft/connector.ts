import { PsycheError } from "@psyche/protocol";
import { asObject, optInt, optString, reqString, schema, strArray } from "../framework/params.ts";
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
  ScopeMode,
  SyncResult,
  ToolOutput,
} from "../framework/types.ts";
import type { EventInput } from "../google/calendar.ts";
import { calendarBinding, calendarEventSchema } from "../google/connector.ts";
import { actionBinding } from "../mail/binding.ts";
import { MAIL_ACTIONS, mailTools } from "../mail/connector.ts";
import { GraphApi } from "./api.ts";
import {
  MicrosoftAuth,
  MicrosoftAuthError,
  type MicrosoftAuthOptions,
  type MicrosoftClientConfig,
  microsoftScopesFor,
  parseMicrosoftClient,
} from "./auth.ts";
import { GraphCalendar } from "./calendar.ts";
import { OneDriveAppFolder } from "./files.ts";
import { GraphMailSession } from "./mail.ts";

/**
 * Microsoft 365 / Outlook.com over Graph (feature M6): Outlook mail with the shared `mail_*`
 * tools, calendar tools shaped like Google's, contacts search, and OneDrive limited to Psyche's
 * app folder. Change notifications ("subscriptions renewed weekly") need a public HTTPS webhook,
 * which a loopback Gateway does not have, so sync polls Graph's delta queries instead (as M5
 * polls Gmail history); see docs/status/s09.md.
 */

export const MICROSOFT_ACTIONS: ConnectorAction[] = [
  ...MAIL_ACTIONS,
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
  { id: "contacts.read", title: "Search contacts", sideEffect: "read", defaultRule: "allow" },
  {
    id: "files.read",
    title: "Read Psyche's OneDrive folder",
    sideEffect: "read",
    defaultRule: "allow",
  },
  {
    id: "files.upload",
    title: "Upload to Psyche's OneDrive folder",
    sideEffect: "write",
    approvalKind: "connector_action",
    defaultRule: "ask",
  },
];

export const MICROSOFT_CATALOGUE: CatalogueEntry = {
  type: "microsoft",
  id: "microsoft",
  label: "Microsoft 365",
  description: "Outlook mail and calendar, contacts, and a OneDrive folder for Psyche.",
  category: "first_party",
  vendor: "Microsoft",
  auth: "oauth",
  scopes: { read: microsoftScopesFor("read"), read_act: microsoftScopesFor("read_act") },
  actions: MICROSOFT_ACTIONS,
  setupGuide: "packages/connectors/README.md#microsoft-365-m6",
  docsUrl: "https://learn.microsoft.com/graph/auth-v2-user",
  available: true,
};

export class MicrosoftConnector implements Connector {
  readonly id: string;
  readonly type = "microsoft";
  readonly #ctx: ConnectorContext;
  readonly #client: MicrosoftClientConfig;
  readonly #auth: MicrosoftAuth;
  readonly #api: GraphApi;
  readonly #mail: GraphMailSession;
  readonly #calendar: GraphCalendar;
  readonly #files: OneDriveAppFolder;
  #account: string | null;
  #status: ConnectorRecord["status"];
  #mode: ScopeMode;

  constructor(record: ConnectorRecord, ctx: ConnectorContext, options: MicrosoftAuthOptions) {
    this.id = record.id;
    this.#ctx = ctx;
    this.#client = parseMicrosoftClient(record.config as Record<string, unknown>);
    this.#auth = new MicrosoftAuth(record.id, ctx, this.#client, options);
    this.#api = new GraphApi(this.#auth, ctx.fetch);
    this.#mail = new GraphMailSession(this.#api, () => this.#requireAccount());
    this.#calendar = new GraphCalendar(this.#api);
    this.#files = new OneDriveAppFolder(this.#api);
    this.#account = record.account;
    this.#status = record.status;
    this.#mode = record.scopeMode;
  }

  #requireAccount(): string {
    if (this.#account === null) throw new PsycheError("unavailable", "Microsoft is not connected");
    return this.#account;
  }

  async connect(input: ConnectInput): Promise<ConnectResult> {
    const scopes = microsoftScopesFor(input.scopeMode);
    // Reconnecting (re-auth, mode change) starts from no tokens.
    await this.#auth.clear();
    const tokens = await this.#auth.authorize(scopes, input.signal);
    const me = await this.#api.json<{ mail?: string | null; userPrincipalName?: string }>("/me", {
      query: { $select: "mail,userPrincipalName" },
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    const account = (me.mail ?? me.userPrincipalName ?? "").toLowerCase();
    if (account === "") throw new PsycheError("internal", "Microsoft returned no account address");
    this.#account = account;
    this.#status = "connected";
    this.#mode = input.scopeMode;
    return {
      account,
      scopes: (tokens.scope ?? scopes.join(" ")).split(/\s+/).filter(Boolean),
      config: { tenant: this.#client.tenant, flow: this.#client.flow },
    };
  }

  async disconnect(): Promise<void> {
    await this.#auth.clear();
    this.#status = "disconnected";
  }

  actions(): ConnectorAction[] {
    // A read-only connection has no OneDrive scope (Graph has no read-only app-folder scope).
    return this.#mode === "read"
      ? MICROSOFT_ACTIONS.filter((a) => !a.id.startsWith("files."))
      : MICROSOFT_ACTIONS;
  }

  async health(): Promise<ConnectorHealth> {
    const checkedAt = this.#ctx.clock.now();
    try {
      await this.#api.json("/me", { query: { $select: "id" } });
      return { ok: true, status: "connected", checkedAt };
    } catch (err) {
      return {
        ok: false,
        status: err instanceof MicrosoftAuthError ? "needs_auth" : "error",
        detail: err instanceof Error ? err.message : String(err),
        checkedAt,
      };
    }
  }

  async sync(cursor: Record<string, unknown> | null, signal?: AbortSignal): Promise<SyncResult> {
    return this.#guard(async () => {
      const c = (cursor ?? {}) as { mail?: Record<string, unknown>; calendar?: string };
      const mail = await this.#mail.sync(c.mail ?? null, signal);
      const cal = await this.#calendar.sync(c.calendar, this.#ctx.clock.now(), signal);
      return {
        changes: mail.changes + cal.changed.length,
        full: mail.full || cal.full,
        cursor: {
          mail: mail.cursor,
          ...(cal.deltaLink === undefined ? {} : { calendar: cal.deltaLink }),
          newMessageIds: mail.newMessageIds.slice(0, 500),
        },
      };
    });
  }

  tools(): ConnectorTool[] {
    const account = () => this.#requireAccount();
    const untrusted = (output: unknown, extra: Partial<ToolOutput> = {}): ToolOutput => ({
      output,
      provenance: "untrusted",
      ...extra,
    });
    const g = <T>(fn: () => Promise<T>) => this.#guard(fn);
    const calendarId = (o: Record<string, unknown>) =>
      typeof o.calendarId === "string" ? o.calendarId : "primary";
    const tools: ConnectorTool[] = [
      ...mailTools({
        connectorId: this.id,
        account,
        library: this.#ctx.library,
        withSession: (_purpose, _run, fn) => this.#guard(() => fn(this.#mail)),
      }),
      {
        name: "calendar_list_calendars",
        action: "calendar.read",
        description: "List the owner's Outlook calendars.",
        inputSchema: schema.obj({}),
        sideEffect: "read",
        execute: (_p, run) =>
          g(async () => untrusted(await this.#calendar.listCalendars(run.signal))),
      },
      {
        name: "calendar_list_events",
        action: "calendar.read",
        description:
          "List events in a time range (RFC 3339 timeMin / timeMax, at most 366 days); times are UTC.",
        inputSchema: schema.obj(
          {
            calendarId: schema.str,
            timeMin: schema.str,
            timeMax: schema.str,
            query: schema.str,
            maxResults: schema.int(1, 250),
          },
          ["timeMin", "timeMax"],
        ),
        sideEffect: "read",
        execute: (p, run) =>
          g(async () => {
            const o = asObject(p);
            const input: Parameters<GraphCalendar["listEvents"]>[0] = {
              calendarId: calendarId(o),
              timeMin: reqString(o.timeMin, "timeMin"),
              timeMax: reqString(o.timeMax, "timeMax"),
            };
            const q = optString(o.query);
            if (q !== undefined) input.query = q;
            const max = optInt(o.maxResults, "maxResults", 1, 250);
            if (max !== undefined) input.maxResults = max;
            return untrusted(await this.#calendar.listEvents(input, run.signal));
          }),
      },
      {
        name: "calendar_free_busy",
        action: "calendar.read",
        description:
          "Busy intervals for up to 50 mailboxes (email addresses; default the owner) in a time range.",
        inputSchema: schema.obj(
          { timeMin: schema.str, timeMax: schema.str, calendarIds: schema.strs },
          ["timeMin", "timeMax"],
        ),
        sideEffect: "read",
        execute: (p, run) =>
          g(async () => {
            const o = asObject(p);
            const ids = strArray(o.calendarIds, "calendarIds");
            return untrusted(
              await this.#calendar.freeBusy(
                {
                  timeMin: reqString(o.timeMin, "timeMin"),
                  timeMax: reqString(o.timeMax, "timeMax"),
                  calendarIds: ids.length === 0 ? [account()] : ids,
                },
                run.signal,
              ),
            );
          }),
      },
      {
        name: "calendar_create_event",
        action: "calendar.write",
        description: "Create an event. Outlook emails invitations to any attendees.",
        inputSchema: schema.obj({ calendarId: schema.str, event: calendarEventSchema }, ["event"]),
        sideEffect: "write",
        // Graph always notifies attendees: bind as an invite whenever there are any.
        describeCall: (p) => calendarBinding(account(), "create", inviteAware(p)),
        execute: (p, run) =>
          g(async () => {
            const o = asObject(p);
            const e = await this.#calendar.createEvent(
              calendarId(o),
              asObject(o.event) as unknown as EventInput,
              run.signal,
            );
            return untrusted(e, {
              externalRefs: { eventId: e.id },
              receiptSummary: `Created "${e.summary.slice(0, 60)}"`,
            });
          }),
      },
      {
        name: "calendar_update_event",
        action: "calendar.write",
        description: "Change fields of an event (partial update). Outlook notifies attendees.",
        inputSchema: schema.obj(
          { calendarId: schema.str, eventId: schema.str, event: calendarEventSchema },
          ["eventId", "event"],
        ),
        sideEffect: "write",
        describeCall: (p) => calendarBinding(account(), "update", inviteAware(p)),
        execute: (p, run) =>
          g(async () => {
            const o = asObject(p);
            const eventId = reqString(o.eventId, "eventId");
            const e = await this.#calendar.updateEvent(
              eventId,
              asObject(o.event) as Partial<EventInput>,
              run.signal,
            );
            return untrusted(e, {
              externalRefs: { eventId },
              receiptSummary: `Updated "${e.summary.slice(0, 60)}"`,
            });
          }),
      },
      {
        name: "calendar_delete_event",
        action: "calendar.delete",
        description: "Delete an event (attendees get a cancellation when the owner organized it).",
        inputSchema: schema.obj({ calendarId: schema.str, eventId: schema.str }, ["eventId"]),
        sideEffect: "destructive",
        describeCall: (p) => calendarBinding(account(), "delete", p),
        execute: (p, run) =>
          g(async () => {
            const eventId = reqString(asObject(p).eventId, "eventId");
            await this.#calendar.deleteEvent(eventId, run.signal);
            return untrusted(
              { deleted: eventId },
              { externalRefs: { eventId }, receiptSummary: `Deleted event ${eventId}` },
            );
          }),
      },
      {
        name: "contacts_search",
        action: "contacts.read",
        description: "Search the owner's Outlook contacts by name or address (or list them).",
        inputSchema: schema.obj({ query: schema.str, maxResults: schema.int(1, 100) }),
        sideEffect: "read",
        execute: (p, run) =>
          g(async () => {
            const o = asObject(p ?? {});
            return untrusted(
              await this.#calendar.searchContacts(
                optString(o.query),
                optInt(o.maxResults, "maxResults", 1, 100) ?? 25,
                run.signal,
              ),
            );
          }),
      },
      {
        name: "onedrive_list",
        action: "files.read",
        description: "List the files in Psyche's OneDrive app folder.",
        inputSchema: schema.obj({}),
        sideEffect: "read",
        execute: (_p, run) => g(async () => untrusted(await this.#files.list(run.signal))),
      },
      {
        name: "onedrive_download",
        action: "files.read",
        description:
          "Download a file from Psyche's OneDrive folder into the Library (25 MB limit).",
        inputSchema: schema.obj({ itemId: schema.str }, ["itemId"]),
        sideEffect: "read",
        execute: (p, run) =>
          g(async () =>
            untrusted(
              await this.#files.download(
                { connectorId: this.id, itemId: reqString(asObject(p).itemId, "itemId") },
                this.#ctx.library,
                run.signal,
              ),
            ),
          ),
      },
      {
        name: "onedrive_upload",
        action: "files.upload",
        description: "Upload a text file (up to 4 MB) to Psyche's OneDrive folder.",
        inputSchema: schema.obj({ name: schema.str, content: schema.str, mimeType: schema.str }, [
          "name",
          "content",
        ]),
        sideEffect: "write",
        describeCall: (p) => actionBinding(this.id, "onedrive_upload", p),
        execute: (p, run) =>
          g(async () => {
            const o = asObject(p);
            const mimeType = optString(o.mimeType);
            const r = await this.#files.upload(
              {
                name: reqString(o.name, "name"),
                content: typeof o.content === "string" ? o.content : "",
                ...(mimeType === undefined ? {} : { mimeType }),
              },
              run.signal,
            );
            return untrusted(r, {
              externalRefs: { itemId: r.id },
              receiptSummary: `Uploaded ${r.name} to OneDrive`,
            });
          }),
      },
    ];
    const allowed = new Set(this.actions().map((a) => a.id));
    return tools.filter((t) => allowed.has(t.action));
  }

  /** Revoked tokens move the connector to `needs_auth` and invalidate pending work. */
  async #guard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (
        err instanceof MicrosoftAuthError &&
        err.reason === "token_revoked" &&
        this.#status !== "needs_auth"
      ) {
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
      throw err;
    }
  }
}

/** Graph notifies attendees on every change: the binding sees `sendUpdates: "all"` then. */
function inviteAware(params: unknown): unknown {
  const o = asObject(params);
  const event = (typeof o.event === "object" && o.event !== null ? o.event : {}) as {
    attendees?: unknown;
  };
  return Array.isArray(event.attendees) && event.attendees.length > 0
    ? { ...o, sendUpdates: "all" }
    : o;
}

export function microsoftFactory(options: MicrosoftAuthOptions): ConnectorFactory {
  return {
    entry: MICROSOFT_CATALOGUE,
    create: (record, ctx) => new MicrosoftConnector(record, ctx, options),
  };
}
