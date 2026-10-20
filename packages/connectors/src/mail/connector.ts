import { PsycheError, type Target } from "@psyche/protocol";
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
  SyncResult,
  ToolOutput,
  ToolRunContext,
} from "../framework/types.ts";
import {
  buildMime,
  canonicalAddress,
  decodeBase64Url,
  MAX_ATTACHMENT_BYTES,
} from "../google/mime.ts";
import { assertPlaceholder } from "../web/search.ts";
import { actionBinding, mailParams, mailSchema, sendBinding, toMail } from "./binding.ts";
import { MailAuthError, type MailBackend, type MailSearch, type MailSession } from "./types.ts";

/**
 * Gmail's tool surface for any mailbox (feature M7): the same actions, side-effect classes and
 * `send_email` / `connector_action` bindings as the Google connector, over a `MailBackend`
 * (IMAP + SMTP, JMAP). The credential (app password or API token) is a `{{cred:slug}}`
 * placeholder in the record config, resolved through the Credential Broker for every call and
 * handed to the backend once; it never reaches a tool output, a receipt or the record.
 */

export const MAIL_ACTIONS: ConnectorAction[] = [
  { id: "mail.read", title: "Read and search mail", sideEffect: "read", defaultRule: "allow" },
  {
    id: "mail.attachments",
    title: "Save attachments to the Library",
    sideEffect: "read",
    defaultRule: "allow",
  },
  {
    id: "mail.labels",
    title: "Flag, move and archive messages",
    sideEffect: "write",
    approvalKind: "connector_action",
    defaultRule: "ask",
  },
  {
    id: "mail.draft",
    title: "Create drafts",
    sideEffect: "write",
    approvalKind: "connector_action",
    defaultRule: "allow",
  },
  {
    id: "mail.send",
    title: "Send mail",
    // Irreversible and outward-facing (security §3.1), like `gmail.send`.
    sideEffect: "destructive",
    approvalKind: "send_email",
    defaultRule: "ask",
  },
];

/** Scopes are the connector's own vocabulary; the provider has no OAuth scopes. */
export const MAIL_SCOPES = { read: ["mail.read"], read_act: ["mail.read", "mail.write"] };

export type MailCredentialPurpose = "connect" | "tool" | "sync" | "health";

/**
 * Returns the id of an approved `credential_fill` (or a live `site` grant) for the connector's
 * credential. Default: the approval the broker issued for the tool call (`ToolRunContext`);
 * connect, sync and health have none, so without this option they cannot reach the mailbox.
 */
export type ApproveMailCredential = (
  request: {
    connectorId: string;
    placeholder: string;
    target: Target;
    purpose: MailCredentialPurpose;
  },
  run?: ToolRunContext,
) => Promise<string>;

export interface MailConnectorOptions {
  entry: CatalogueEntry;
  /** Config key that holds the credential placeholder (`password`, `token`). */
  credentialKey: string;
  /** Builds the protocol backend from the validated record config. */
  backend: (config: Record<string, unknown>, ctx: ConnectorContext) => MailBackend;
  approveCredential?: ApproveMailCredential;
}

/** Vault binding target: the credential item is bound to `{ connector: <connectorId> }`. */
export function mailCredentialTarget(connectorId: string, hosts: string[]): Target {
  return { kind: "account", value: connectorId, display: `Mail account (${hosts.join(", ")})` };
}

const defaultApprove: ApproveMailCredential = async (req, run) => {
  if (run?.approvalId === undefined) {
    throw new PsycheError(
      "approval_required",
      `the mail credential needs an approved fill (${req.purpose})`,
    );
  }
  return run.approvalId;
};

function flagList(v: unknown, name: string): string[] {
  return strArray(v, name).map((f) =>
    f
      .trim()
      .toLowerCase()
      .replace(/^[\\$]/, ""),
  );
}

export class MailConnector implements Connector {
  readonly id: string;
  readonly type: string;
  readonly #ctx: ConnectorContext;
  readonly #opts: MailConnectorOptions;
  readonly #backend: MailBackend;
  readonly #placeholder: string;
  #account: string | null;
  #status: ConnectorRecord["status"];

  constructor(record: ConnectorRecord, ctx: ConnectorContext, options: MailConnectorOptions) {
    this.id = record.id;
    this.type = options.entry.type;
    this.#ctx = ctx;
    this.#opts = options;
    const cfg = record.config as Record<string, unknown>;
    this.#placeholder = assertPlaceholder(
      cfg[options.credentialKey],
      `config.${options.credentialKey}`,
    );
    this.#backend = options.backend(cfg, ctx);
    this.#account = record.account;
    this.#status = record.status;
  }

  async connect(input: ConnectInput): Promise<ConnectResult> {
    const configured = optString(input.config.account);
    if (configured === undefined) {
      throw new PsycheError("invalid_params", "config.account (the mailbox address) is required");
    }
    let account = canonicalAddress(configured);
    if (this.#ctx.credentials === undefined) {
      throw new PsycheError("unavailable", "no credential broker to resolve the mail credential");
    }
    // Verify the credential when a standing approval is available (the Gateway supplies one);
    // otherwise the connection is recorded and verified by the first tool call.
    if (this.#opts.approveCredential !== undefined) {
      const reported = await this.#withSession(
        "connect",
        undefined,
        (s) => s.account(),
        input.signal,
      );
      if (reported !== "" && canonicalAddress(reported) !== account) {
        account = canonicalAddress(reported);
      }
    }
    this.#account = account;
    this.#status = "connected";
    return { account, scopes: MAIL_SCOPES[input.scopeMode], config: { account } };
  }

  async disconnect(): Promise<void> {
    this.#status = "disconnected";
  }

  actions(): ConnectorAction[] {
    return MAIL_ACTIONS;
  }

  async health(): Promise<ConnectorHealth> {
    const checkedAt = this.#ctx.clock.now();
    if (this.#opts.approveCredential === undefined) {
      return { ok: this.#status === "connected", status: this.#status, checkedAt };
    }
    try {
      await this.#withSession("health", undefined, async () => undefined);
      return { ok: true, status: "connected", checkedAt };
    } catch (err) {
      return {
        ok: false,
        status: err instanceof MailAuthError ? "needs_auth" : "error",
        detail: err instanceof Error ? err.message : String(err),
        checkedAt,
      };
    }
  }

  async sync(cursor: Record<string, unknown> | null, signal?: AbortSignal): Promise<SyncResult> {
    const r = await this.#withSession("sync", undefined, (s) => s.sync(cursor, signal), signal);
    return {
      changes: r.changes,
      full: r.full,
      cursor: { ...r.cursor, newMessageIds: r.newMessageIds.slice(0, 500) },
    };
  }

  tools(): ConnectorTool[] {
    const account = () => {
      if (this.#account === null)
        throw new PsycheError("unavailable", "the mailbox is not connected");
      return this.#account;
    };
    const untrusted = (output: unknown, extra: Partial<ToolOutput> = {}): ToolOutput => ({
      output,
      provenance: "untrusted",
      ...extra,
    });
    const ref = (o: Record<string, unknown>) => ({
      id: reqString(o.id, "id"),
      ...(typeof o.mailbox === "string" ? { mailbox: o.mailbox } : {}),
    });
    const tools: ConnectorTool[] = [
      {
        name: "mail_search_messages",
        action: "mail.read",
        description:
          "Search messages (free text, from, to, subject, since / before ISO dates, unread) in a mailbox (default inbox). Returns subjects, senders, dates and snippets.",
        inputSchema: schema.obj({
          query: schema.str,
          mailbox: schema.str,
          from: schema.str,
          to: schema.str,
          subject: schema.str,
          since: schema.str,
          before: schema.str,
          unread: schema.bool,
          maxResults: schema.int(1, 50),
          pageToken: schema.str,
        }),
        sideEffect: "read",
        execute: (p, run) =>
          this.#withSession(
            "tool",
            run,
            async (s) => {
              const o = asObject(p ?? {});
              const input: MailSearch = {};
              for (const k of [
                "query",
                "mailbox",
                "from",
                "to",
                "subject",
                "since",
                "before",
                "pageToken",
              ] as const) {
                const v = optString(o[k]);
                if (v !== undefined) input[k] = v;
              }
              if (typeof o.unread === "boolean") input.unread = o.unread;
              const max = optInt(o.maxResults, "maxResults", 1, 50);
              if (max !== undefined) input.maxResults = max;
              return untrusted(await s.search(input, run.signal));
            },
            run.signal,
          ),
      },
      {
        name: "mail_read_message",
        action: "mail.read",
        description:
          "Read one message: headers, plain-text body (HTML stripped of hidden content) and attachment list.",
        inputSchema: schema.obj({ id: schema.str, mailbox: schema.str }, ["id"]),
        sideEffect: "read",
        execute: (p, run) =>
          this.#withSession(
            "tool",
            run,
            async (s) => untrusted(await s.read(ref(asObject(p)), run.signal)),
            run.signal,
          ),
      },
      {
        name: "mail_list_mailboxes",
        action: "mail.read",
        description: "List mailboxes (folders) with their roles and counts.",
        inputSchema: schema.obj({}),
        sideEffect: "read",
        execute: (_p, run) =>
          this.#withSession(
            "tool",
            run,
            async (s) => untrusted(await s.listMailboxes(run.signal)),
            run.signal,
          ),
      },
      {
        name: "mail_save_attachment",
        action: "mail.attachments",
        description:
          "Save one attachment of a message to the Library (25 MB limit). Returns the Library item id.",
        inputSchema: schema.obj({ id: schema.str, mailbox: schema.str, partId: schema.str }, [
          "id",
          "partId",
        ]),
        sideEffect: "read",
        execute: (p, run) =>
          this.#withSession(
            "tool",
            run,
            async (s) => {
              const o = asObject(p);
              const partId = reqString(o.partId, "partId");
              const a = await s.attachment({ ...ref(o), partId }, run.signal);
              if (a.bytes.byteLength > MAX_ATTACHMENT_BYTES) {
                throw new PsycheError("invalid_params", "attachment is larger than 25 MB");
              }
              const library = this.#ctx.library;
              if (library === undefined)
                throw new PsycheError("unavailable", "no Library to save attachments into");
              const saved = await library.put({
                name: a.filename,
                mimeType: a.mimeType,
                bytes: a.bytes,
                source: { connectorId: this.id, ref: `${ref(o).id}/${partId}` },
                provenance: "untrusted",
              });
              return untrusted({
                ...saved,
                filename: a.filename,
                mimeType: a.mimeType,
                size: a.bytes.byteLength,
              });
            },
            run.signal,
          ),
      },
      {
        name: "mail_modify_flags",
        action: "mail.labels",
        description:
          "Add or remove flags (seen, flagged, answered or custom keywords) and/or move a message to another mailbox (archive = move to the archive mailbox).",
        inputSchema: schema.obj(
          {
            id: schema.str,
            mailbox: schema.str,
            addFlags: schema.strs,
            removeFlags: schema.strs,
            moveTo: schema.str,
          },
          ["id"],
        ),
        sideEffect: "write",
        describeCall: (p) => actionBinding(this.id, "mail_modify_flags", p),
        execute: (p, run) =>
          this.#withSession(
            "tool",
            run,
            async (s) => {
              const o = asObject(p);
              const r = ref(o);
              const change = {
                addFlags: flagList(o.addFlags, "addFlags"),
                removeFlags: flagList(o.removeFlags, "removeFlags"),
                ...(typeof o.moveTo === "string" ? { moveTo: o.moveTo } : {}),
              };
              const out = await s.modify(r, change, run.signal);
              return untrusted(out, {
                externalRefs: { messageId: out.id },
                receiptSummary: `Updated message ${r.id}${change.moveTo === undefined ? "" : ` (moved to ${change.moveTo})`}`,
              });
            },
            run.signal,
          ),
      },
      {
        name: "mail_create_draft",
        action: "mail.draft",
        description:
          "Create a draft (plain text). Use inReplyTo and references to reply in a thread.",
        inputSchema: mailSchema,
        sideEffect: "write",
        describeCall: (p) => actionBinding(this.id, "mail_create_draft", p),
        execute: (p, run) =>
          this.#withSession(
            "tool",
            run,
            async (s) => {
              const m = mailParams(p);
              const mail = toMail(m, account());
              const raw = decodeBase64Url(buildMime(mail)) ?? new Uint8Array();
              const r = await s.createDraft(mail, raw, run.signal);
              return untrusted(
                { draftId: r.id },
                {
                  externalRefs: { draftId: r.id },
                  receiptSummary: `Drafted "${m.subject.slice(0, 60)}"`,
                },
              );
            },
            run.signal,
          ),
      },
      {
        name: "mail_send",
        action: "mail.send",
        description:
          "Send an email (plain text). Requires the owner's approval of the exact recipients, subject and body.",
        inputSchema: mailSchema,
        sideEffect: "destructive",
        describeCall: (p) => sendBinding(account(), p),
        execute: (p, run) =>
          this.#withSession(
            "tool",
            run,
            async (s) => {
              const m = mailParams(p);
              const mail = toMail(m, account());
              const raw = decodeBase64Url(buildMime(mail)) ?? new Uint8Array();
              const r = await s.send(mail, raw, run.signal);
              return untrusted(
                { messageId: r.id, ...(r.threadId === undefined ? {} : { threadId: r.threadId }) },
                {
                  externalRefs: { messageId: r.id },
                  receiptSummary: sendBinding(account(), p).summary ?? "Sent mail",
                },
              );
            },
            run.signal,
          ),
      },
    ];
    return tools;
  }

  /**
   * Resolve the credential for this call, open a session, run `fn`, close. The secret handle is
   * spent inside the backend's `open`; an auth failure moves the connector to `needs_auth` and
   * invalidates pending work, like a revoked Google token.
   */
  async #withSession<T>(
    purpose: MailCredentialPurpose,
    run: ToolRunContext | undefined,
    fn: (session: MailSession) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const credentials = this.#ctx.credentials;
    if (credentials === undefined) {
      throw new PsycheError("unavailable", "no credential broker to resolve the mail credential");
    }
    const target = mailCredentialTarget(this.id, this.#backend.hosts);
    const approve = this.#opts.approveCredential ?? defaultApprove;
    const approvalId = await approve(
      { connectorId: this.id, placeholder: this.#placeholder, target, purpose },
      run,
    );
    const secret = await credentials.resolve(this.#placeholder, target, approvalId, {
      executor: "connector",
      ...(signal === undefined ? {} : { signal }),
    });
    let session: MailSession | undefined;
    try {
      session = await this.#backend.open(secret, signal);
      const out = await fn(session);
      return out;
    } catch (err) {
      if (err instanceof MailAuthError) {
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
        throw new PsycheError("forbidden", "the mail server rejected the credential", {
          details: { reason: err.reason },
        });
      }
      throw err;
    } finally {
      secret.dispose();
      await session?.close().catch(() => undefined);
    }
  }
}

export function mailFactory(options: MailConnectorOptions): ConnectorFactory {
  return {
    entry: options.entry,
    create: (record, ctx) => new MailConnector(record, ctx, options),
  };
}
