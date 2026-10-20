import { type JsonObject, PsycheError, type ResolvedSecret } from "@psyche/protocol";
import type { FetchFn } from "../../framework/types.ts";
import type { OutgoingMail } from "../../google/mime.ts";
import { attachmentBytes, messageViewFromRaw } from "../rfc822.ts";
import {
  MailAuthError,
  type MailBackend,
  type MailboxInfo,
  type MailboxRole,
  type MailChange,
  type MailMessageView,
  type MailRef,
  type MailSearch,
  type MailSession,
  type MailSummary,
  type MailSyncResult,
} from "../types.ts";

/**
 * JMAP (RFC 8620 core, RFC 8621 mail, RFC 8617 submission) as Fastmail serves it: a session
 * resource, one API endpoint, blob upload / download URL templates. The bearer token is read
 * from the vault handle once per session and sent only to HTTPS hosts the session is allowed to
 * use; redirects are never followed with it.
 */

export const JMAP_USING = [
  "urn:ietf:params:jmap:core",
  "urn:ietf:params:jmap:mail",
  "urn:ietf:params:jmap:submission",
];
export const FASTMAIL_SESSION_URL = "https://api.fastmail.com/jmap/session";
const MAIL_CAP = "urn:ietf:params:jmap:mail";
const SUBMISSION_CAP = "urn:ietf:params:jmap:submission";
export const MAX_PAGE = 50;

export interface JmapConfig {
  /** HTTPS session resource URL; default Fastmail's. */
  sessionUrl: string;
  /** Extra hosts (download / upload) the token may be sent to; the session host is implied. */
  extraHosts: string[];
}

export function parseJmapConfig(config: Record<string, unknown>): JmapConfig {
  const raw = typeof config.sessionUrl === "string" ? config.sessionUrl : FASTMAIL_SESSION_URL;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new PsycheError("invalid_params", "config.sessionUrl must be a URL");
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") {
    throw new PsycheError("invalid_params", "config.sessionUrl must be https without credentials");
  }
  const extraHosts = Array.isArray(config.extraHosts)
    ? config.extraHosts
        .filter((h): h is string => typeof h === "string")
        .map((h) => h.toLowerCase())
    : url.host === "api.fastmail.com"
      ? ["www.fastmailusercontent.com"]
      : [];
  return { sessionUrl: url.href, extraHosts };
}

interface Session {
  apiUrl: string;
  downloadUrl: string;
  uploadUrl: string;
  username?: string;
  accountId: string;
  state: string;
}

type MethodCall = [string, JsonObject, string];
type MethodResponse = [string, JsonObject, string];

const ROLE: Record<string, MailboxRole> = {
  inbox: "inbox",
  drafts: "drafts",
  sent: "sent",
  trash: "trash",
  junk: "junk",
  archive: "archive",
  all: "all",
};

const KEYWORD: Record<string, string> = {
  seen: "$seen",
  flagged: "$flagged",
  answered: "$answered",
  draft: "$draft",
  forwarded: "$forwarded",
};

function keywordOf(flag: string): string {
  const k = KEYWORD[flag];
  if (k !== undefined) return k;
  if (!/^[a-z0-9$_.-]{1,255}$/i.test(flag)) {
    throw new PsycheError("invalid_params", `invalid flag ${JSON.stringify(flag.slice(0, 40))}`);
  }
  return flag;
}

function flagOf(keyword: string): string {
  return keyword.replace(/^\$/, "").toLowerCase();
}

function addrList(v: unknown): string {
  if (!Array.isArray(v)) return "";
  return v
    .map((a) => {
      const o =
        typeof a === "object" && a !== null ? (a as { name?: unknown; email?: unknown }) : {};
      const email = typeof o.email === "string" ? o.email : "";
      const name = typeof o.name === "string" && o.name !== "" ? o.name : "";
      return name === "" ? email : `${name} <${email}>`;
    })
    .filter((s) => s !== "")
    .join(", ");
}

/** A standalone ArrayBuffer for `fetch` bodies (typed arrays over shared buffers are refused by the DOM types). */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

export class JmapBackend implements MailBackend {
  readonly kind = "jmap" as const;
  readonly hosts: string[];
  readonly #cfg: JmapConfig;
  readonly #fetch: FetchFn;

  constructor(config: Record<string, unknown>, fetch: FetchFn) {
    this.#cfg = parseJmapConfig(config);
    this.#fetch = fetch;
    this.hosts = [new URL(this.#cfg.sessionUrl).host];
  }

  async open(secret: ResolvedSecret, signal?: AbortSignal): Promise<MailSession> {
    const token = secret.use((v) => v);
    const http = new JmapHttp(
      this.#fetch,
      token,
      new Set([...this.hosts, ...this.#cfg.extraHosts]),
    );
    const doc = (await http.json(this.#cfg.sessionUrl, { method: "GET" }, signal)) as {
      apiUrl?: unknown;
      downloadUrl?: unknown;
      uploadUrl?: unknown;
      username?: unknown;
      primaryAccounts?: Record<string, unknown>;
      state?: unknown;
    };
    const accountId = doc.primaryAccounts?.[MAIL_CAP];
    if (
      typeof doc.apiUrl !== "string" ||
      typeof doc.downloadUrl !== "string" ||
      typeof doc.uploadUrl !== "string" ||
      typeof accountId !== "string"
    ) {
      throw new PsycheError("internal", "JMAP session resource is incomplete");
    }
    const session: Session = {
      apiUrl: new URL(doc.apiUrl, this.#cfg.sessionUrl).href,
      downloadUrl: doc.downloadUrl,
      uploadUrl: doc.uploadUrl,
      accountId,
      state: str(doc.state),
    };
    if (typeof doc.username === "string") session.username = doc.username;
    return new JmapSession(http, session);
  }
}

/** HTTP with the bearer token pinned to the allowed hosts; the token never leaves this object. */
class JmapHttp {
  readonly #fetch: FetchFn;
  readonly #token: string;
  readonly #hosts: Set<string>;

  constructor(fetch: FetchFn, token: string, hosts: Set<string>) {
    this.#fetch = fetch;
    this.#token = token;
    this.#hosts = hosts;
  }

  async request(url: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    const u = new URL(url);
    if (u.protocol !== "https:" || !this.#hosts.has(u.host.toLowerCase())) {
      throw new PsycheError("policy_denied", `JMAP credential may not be sent to ${u.host}`);
    }
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${this.#token}`);
    headers.set("accept", "application/json");
    const res = await this.#fetch(u, {
      ...init,
      headers,
      redirect: "manual",
      ...(signal === undefined ? {} : { signal }),
    });
    if (res.status === 401 || res.status === 403) throw new MailAuthError("token_revoked");
    if (res.status >= 300 && res.status < 400) {
      throw new PsycheError("unavailable", `JMAP endpoint redirected (${res.status})`);
    }
    if (!res.ok) {
      throw new PsycheError(
        res.status === 429 ? "rate_limited" : "unavailable",
        `JMAP HTTP ${res.status}`,
        {
          retryable: res.status >= 500 || res.status === 429,
        },
      );
    }
    return res;
  }

  async json(url: string, init: RequestInit, signal?: AbortSignal): Promise<unknown> {
    const res = await this.request(url, init, signal);
    return res.json();
  }
}

export class JmapSession implements MailSession {
  readonly #http: JmapHttp;
  readonly #s: Session;
  #mailboxes: MailboxInfo[] | undefined;

  constructor(http: JmapHttp, session: Session) {
    this.#http = http;
    this.#s = session;
  }

  async account(): Promise<string> {
    if (this.#s.username?.includes("@")) return this.#s.username;
    const [r] = await this.#call([["Identity/get", { accountId: this.#s.accountId }, "i"]]);
    const list = Array.isArray(r?.[1].list) ? (r[1].list as { email?: unknown }[]) : [];
    return str(list[0]?.email);
  }

  async listMailboxes(signal?: AbortSignal): Promise<MailboxInfo[]> {
    if (this.#mailboxes !== undefined) return this.#mailboxes;
    const [r] = await this.#call(
      [["Mailbox/get", { accountId: this.#s.accountId, ids: null }, "m"]],
      signal,
    );
    const list = Array.isArray(r?.[1].list) ? (r[1].list as Record<string, unknown>[]) : [];
    this.#mailboxes = list.map((m) => {
      const info: MailboxInfo = { id: str(m.id), name: str(m.name).slice(0, 200) };
      const role = ROLE[str(m.role)];
      if (role !== undefined) info.role = role;
      if (typeof m.totalEmails === "number") info.total = m.totalEmails;
      if (typeof m.unreadEmails === "number") info.unread = m.unreadEmails;
      return info;
    });
    return this.#mailboxes;
  }

  async #mailboxId(role: MailboxRole, signal?: AbortSignal): Promise<string> {
    const boxes = await this.listMailboxes(signal);
    const hit =
      boxes.find((b) => b.role === role) ?? boxes.find((b) => b.name.toLowerCase() === role);
    if (hit === undefined) throw new PsycheError("not_found", `no ${role} mailbox`);
    return hit.id;
  }

  async search(input: MailSearch, signal?: AbortSignal) {
    const filter: JsonObject = {};
    filter.inMailbox = input.mailbox ?? (await this.#mailboxId("inbox", signal));
    if (input.query !== undefined) filter.text = input.query;
    if (input.from !== undefined) filter.from = input.from;
    if (input.to !== undefined) filter.to = input.to;
    if (input.subject !== undefined) filter.subject = input.subject;
    if (input.since !== undefined) filter.after = input.since;
    if (input.before !== undefined) filter.before = input.before;
    if (input.unread === true) filter.notKeyword = "$seen";
    const limit = Math.min(Math.max(input.maxResults ?? 20, 1), MAX_PAGE);
    const position = input.pageToken === undefined ? 0 : Number.parseInt(input.pageToken, 10);
    if (!Number.isInteger(position) || position < 0) {
      throw new PsycheError("invalid_params", "pageToken is invalid");
    }
    const [q, g] = await this.#call(
      [
        [
          "Email/query",
          {
            accountId: this.#s.accountId,
            filter,
            sort: [{ property: "receivedAt", isAscending: false }],
            position,
            limit,
            calculateTotal: false,
          },
          "q",
        ],
        [
          "Email/get",
          {
            accountId: this.#s.accountId,
            "#ids": { resultOf: "q", name: "Email/query", path: "/ids" },
            properties: [
              "id",
              "threadId",
              "mailboxIds",
              "keywords",
              "from",
              "to",
              "subject",
              "receivedAt",
              "preview",
              "size",
            ],
          },
          "g",
        ],
      ],
      signal,
    );
    const ids = Array.isArray(q?.[1].ids) ? (q[1].ids as string[]) : [];
    const list = Array.isArray(g?.[1].list) ? (g[1].list as Record<string, unknown>[]) : [];
    const mailbox = String(filter.inMailbox);
    const messages = list.map((e) => this.#summary(e, mailbox));
    return { messages, nextPageToken: ids.length === limit ? String(position + limit) : null };
  }

  #summary(e: Record<string, unknown>, mailbox: string): MailSummary {
    const keywords =
      typeof e.keywords === "object" && e.keywords !== null ? Object.keys(e.keywords) : [];
    const boxes =
      typeof e.mailboxIds === "object" && e.mailboxIds !== null ? Object.keys(e.mailboxIds) : [];
    const s: MailSummary = {
      id: str(e.id),
      mailbox: boxes.includes(mailbox) ? mailbox : (boxes[0] ?? mailbox),
      subject: str(e.subject).slice(0, 2000),
      from: addrList(e.from),
      to: addrList(e.to),
      date: str(e.receivedAt),
      snippet: str(e.preview).slice(0, 256),
      unread: !keywords.includes("$seen"),
      flags: keywords.map(flagOf),
    };
    if (typeof e.threadId === "string") s.threadId = e.threadId;
    if (typeof e.size === "number") s.size = e.size;
    return s;
  }

  async #raw(id: string, signal?: AbortSignal) {
    const [g] = await this.#call(
      [
        [
          "Email/get",
          {
            accountId: this.#s.accountId,
            ids: [id],
            properties: [
              "id",
              "blobId",
              "threadId",
              "mailboxIds",
              "keywords",
              "receivedAt",
              "size",
            ],
          },
          "g",
        ],
      ],
      signal,
    );
    const e = (Array.isArray(g?.[1].list) ? (g[1].list as Record<string, unknown>[]) : [])[0];
    if (e === undefined) throw new PsycheError("not_found", `message ${id} not found`);
    const url = this.#s.downloadUrl
      .replace("{accountId}", encodeURIComponent(this.#s.accountId))
      .replace("{blobId}", encodeURIComponent(str(e.blobId)))
      .replace("{name}", "message.eml")
      .replace("{type}", encodeURIComponent("message/rfc822"));
    const res = await this.#http.request(url, { method: "GET" }, signal);
    const raw = new Uint8Array(await res.arrayBuffer());
    return { e, raw };
  }

  async read(ref: MailRef, signal?: AbortSignal): Promise<MailMessageView> {
    const { e, raw } = await this.#raw(ref.id, signal);
    const keywords =
      typeof e.keywords === "object" && e.keywords !== null ? Object.keys(e.keywords) : [];
    const boxes =
      typeof e.mailboxIds === "object" && e.mailboxIds !== null ? Object.keys(e.mailboxIds) : [];
    return messageViewFromRaw(raw, {
      id: ref.id,
      mailbox: ref.mailbox ?? boxes[0] ?? "",
      ...(typeof e.threadId === "string" ? { threadId: e.threadId } : {}),
      date: str(e.receivedAt),
      unread: !keywords.includes("$seen"),
      flags: keywords.map(flagOf),
      ...(typeof e.size === "number" ? { size: e.size } : {}),
    });
  }

  async attachment(ref: MailRef & { partId: string }, signal?: AbortSignal) {
    const { raw } = await this.#raw(ref.id, signal);
    const a = attachmentBytes(raw, ref.partId);
    if (a === undefined) throw new PsycheError("not_found", "no such attachment");
    return a;
  }

  async modify(ref: MailRef, change: MailChange, signal?: AbortSignal): Promise<MailRef> {
    const patch: JsonObject = {};
    for (const f of change.addFlags ?? []) patch[`keywords/${keywordOf(f)}`] = true;
    for (const f of change.removeFlags ?? []) patch[`keywords/${keywordOf(f)}`] = null;
    let mailbox = ref.mailbox;
    if (change.moveTo !== undefined) {
      const boxes = await this.listMailboxes(signal);
      const target =
        boxes.find((b) => b.id === change.moveTo) ??
        boxes.find((b) => b.name.toLowerCase() === change.moveTo?.toLowerCase()) ??
        boxes.find((b) => b.role === change.moveTo);
      if (target === undefined) throw new PsycheError("not_found", `no mailbox ${change.moveTo}`);
      patch.mailboxIds = { [target.id]: true };
      mailbox = target.id;
    }
    const [r] = await this.#call(
      [["Email/set", { accountId: this.#s.accountId, update: { [ref.id]: patch } }, "u"]],
      signal,
    );
    const notUpdated = r?.[1].notUpdated as Record<string, { type?: string }> | undefined;
    if (notUpdated?.[ref.id] !== undefined) {
      throw new PsycheError(
        "not_found",
        `message ${ref.id}: ${notUpdated[ref.id]?.type ?? "notUpdated"}`,
      );
    }
    return { id: ref.id, ...(mailbox === undefined ? {} : { mailbox }) };
  }

  async #upload(raw: Uint8Array, signal?: AbortSignal): Promise<string> {
    const url = this.#s.uploadUrl.replace("{accountId}", encodeURIComponent(this.#s.accountId));
    const res = await this.#http.request(
      url,
      { method: "POST", headers: { "content-type": "message/rfc822" }, body: toArrayBuffer(raw) },
      signal,
    );
    const body = (await res.json()) as { blobId?: unknown };
    if (typeof body.blobId !== "string")
      throw new PsycheError("internal", "upload returned no blobId");
    return body.blobId;
  }

  async #import(
    raw: Uint8Array,
    mailboxId: string,
    keywords: Record<string, boolean>,
    signal?: AbortSignal,
  ) {
    const blobId = await this.#upload(raw, signal);
    const [r] = await this.#call(
      [
        [
          "Email/import",
          {
            accountId: this.#s.accountId,
            emails: { m1: { blobId, mailboxIds: { [mailboxId]: true }, keywords } },
          },
          "i",
        ],
      ],
      signal,
    );
    const created = (r?.[1].created as Record<string, { id?: unknown }> | undefined)?.m1;
    if (typeof created?.id !== "string") {
      const why = (r?.[1].notCreated as Record<string, { type?: string }> | undefined)?.m1?.type;
      throw new PsycheError(
        "internal",
        `Email/import failed${why === undefined ? "" : ` (${why})`}`,
      );
    }
    return created.id;
  }

  async createDraft(_mail: OutgoingMail, raw: Uint8Array, signal?: AbortSignal) {
    const drafts = await this.#mailboxId("drafts", signal);
    return { id: await this.#import(raw, drafts, { $draft: true, $seen: true }, signal) };
  }

  async send(mail: OutgoingMail, raw: Uint8Array, signal?: AbortSignal) {
    const drafts = await this.#mailboxId("drafts", signal);
    const sent = await this.#mailboxId("sent", signal).catch(() => drafts);
    const [ident] = await this.#call(
      [["Identity/get", { accountId: this.#s.accountId }, "i"]],
      signal,
    );
    const identities = Array.isArray(ident?.[1].list)
      ? (ident[1].list as { id?: unknown; email?: unknown }[])
      : [];
    const from = (mail.from ?? "").toLowerCase();
    const identity =
      identities.find((i) => typeof i.email === "string" && i.email.toLowerCase() === from) ??
      identities[0];
    if (typeof identity?.id !== "string")
      throw new PsycheError("unavailable", "no sending identity");
    const emailId = await this.#import(raw, drafts, { $draft: true, $seen: true }, signal);
    const [r] = await this.#call(
      [
        [
          "EmailSubmission/set",
          {
            accountId: this.#s.accountId,
            create: { s1: { identityId: identity.id, emailId } },
            onSuccessUpdateEmail: {
              "#s1": {
                [`mailboxIds/${drafts}`]: null,
                [`mailboxIds/${sent}`]: true,
                "keywords/$draft": null,
                "keywords/$seen": true,
              },
            },
          },
          "s",
        ],
      ],
      signal,
    );
    const created = (r?.[1].created as Record<string, unknown> | undefined)?.s1;
    if (created === undefined) {
      const why = (r?.[1].notCreated as Record<string, { type?: string }> | undefined)?.s1?.type;
      throw new PsycheError(
        "unavailable",
        `EmailSubmission failed${why === undefined ? "" : ` (${why})`}`,
      );
    }
    return { id: emailId };
  }

  async sync(cursor: JsonObject | null, signal?: AbortSignal): Promise<MailSyncResult> {
    const since = typeof cursor?.state === "string" ? cursor.state : undefined;
    if (since !== undefined) {
      const [r] = await this.#call(
        [
          [
            "Email/changes",
            { accountId: this.#s.accountId, sinceState: since, maxChanges: 500 },
            "c",
          ],
        ],
        signal,
        true,
      );
      if (r !== undefined && r[0] !== "error") {
        const created = Array.isArray(r[1].created) ? (r[1].created as string[]) : [];
        const updated = Array.isArray(r[1].updated) ? (r[1].updated as string[]) : [];
        const destroyed = Array.isArray(r[1].destroyed) ? (r[1].destroyed as string[]) : [];
        return {
          changes: created.length + updated.length + destroyed.length,
          full: false,
          cursor: { state: str(r[1].newState) },
          newMessageIds: created,
        };
      }
    }
    const [g] = await this.#call(
      [["Email/get", { accountId: this.#s.accountId, ids: [] }, "g"]],
      signal,
    );
    return { changes: 0, full: true, cursor: { state: str(g?.[1].state) }, newMessageIds: [] };
  }

  async close(): Promise<void> {
    // Nothing to release: the token lives in the HTTP wrapper, which is dropped with the session.
  }

  /** One JMAP request; method-level errors become `PsycheError` unless `tolerateErrors`. */
  async #call(
    calls: MethodCall[],
    signal?: AbortSignal,
    tolerateErrors = false,
  ): Promise<MethodResponse[]> {
    const body = (await this.#http.json(
      this.#s.apiUrl,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ using: JMAP_USING, methodCalls: calls }),
      },
      signal,
    )) as { methodResponses?: unknown; sessionState?: unknown };
    const responses = Array.isArray(body.methodResponses)
      ? (body.methodResponses as MethodResponse[])
      : [];
    const out: MethodResponse[] = [];
    for (const call of calls) {
      const r = responses.find((x) => Array.isArray(x) && x[2] === call[2]);
      if (r === undefined)
        throw new PsycheError("internal", `JMAP returned no response for ${call[0]}`);
      if (r[0] === "error" && !tolerateErrors) {
        const type = str(r[1].type);
        throw new PsycheError(
          type === "forbidden" ? "forbidden" : type === "notFound" ? "not_found" : "unavailable",
          `JMAP ${call[0]} failed: ${type || "error"}`,
        );
      }
      out.push(r);
    }
    void SUBMISSION_CAP;
    return out;
  }
}
