import { type JsonObject, PsycheError, type ResolvedSecret } from "@psyche/protocol";
import type { OutgoingMail } from "../../google/mime.ts";
import { canonicalAddress } from "../../google/mime.ts";
import {
  attachmentBytes,
  decodeHeaderValue,
  headerValue,
  messageViewFromRaw,
  parseHeaders,
} from "../rfc822.ts";
import { SmtpClient } from "../smtp/client.ts";
import { type MailDialer, tlsDialer } from "../transport.ts";
import type {
  MailBackend,
  MailboxInfo,
  MailboxRole,
  MailChange,
  MailMessageView,
  MailRef,
  MailSearch,
  MailSession,
  MailSummary,
  MailSyncResult,
} from "../types.ts";
import { type CommandPart, ImapClient, ImapError, type ImapListEntry } from "./client.ts";
import { asBytes, asString, internalDateToIso, isoToImapDate } from "./parser.ts";

/**
 * IMAP + SMTP backend (feature M7, "app passwords"): IMAPS for reading, flags, moves and
 * drafts (APPEND), SMTPS for sending (then a copy into Sent). Message ids are the mailbox UID,
 * so every ref carries its mailbox (default INBOX). The app password comes from the vault handle
 * once per session, is used for the IMAP login and the SMTP AUTH, and is dropped on close.
 */

export const IMAP_DEFAULT_PORT = 993;
export const SMTP_DEFAULT_PORT = 465;
export const IMAP_MAX_PAGE = 50;

export interface ImapConfig {
  host: string;
  port: number;
  username: string;
  smtpHost: string;
  smtpPort: number;
  smtpUsername: string;
  /** The owner's address (From and the connector account). */
  account: string | undefined;
}

const HOST =
  /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$|^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

function hostOf(v: unknown, name: string): string {
  if (typeof v !== "string" || !HOST.test(v)) {
    throw new PsycheError("invalid_params", `config.${name} must be a host name`);
  }
  return v.toLowerCase();
}

function portOf(v: unknown, name: string, fallback: number): number {
  if (v === undefined) return fallback;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 65535) {
    throw new PsycheError("invalid_params", `config.${name} must be a port number`);
  }
  return v;
}

export function parseImapConfig(config: Record<string, unknown>): ImapConfig {
  const host = hostOf(config.host, "host");
  if (typeof config.username !== "string" || config.username === "") {
    throw new PsycheError("invalid_params", "config.username is required");
  }
  if (config.tls === false || config.starttls === true) {
    throw new PsycheError("invalid_params", "only implicit TLS (IMAPS / SMTPS) is supported");
  }
  return {
    host,
    port: portOf(config.port, "port", IMAP_DEFAULT_PORT),
    username: config.username,
    smtpHost: config.smtpHost === undefined ? host : hostOf(config.smtpHost, "smtpHost"),
    smtpPort: portOf(config.smtpPort, "smtpPort", SMTP_DEFAULT_PORT),
    smtpUsername: typeof config.smtpUsername === "string" ? config.smtpUsername : config.username,
    account: typeof config.account === "string" ? config.account : undefined,
  };
}

export interface ImapBackendOptions {
  /** Socket factory; default implicit TLS. Tests inject the fake servers. */
  dial?: MailDialer;
}

export class ImapBackend implements MailBackend {
  readonly kind = "imap" as const;
  readonly hosts: string[];
  readonly #cfg: ImapConfig;
  readonly #dial: MailDialer;

  constructor(config: Record<string, unknown>, options: ImapBackendOptions = {}) {
    this.#cfg = parseImapConfig(config);
    this.#dial = options.dial ?? tlsDialer();
    this.hosts = [...new Set([this.#cfg.host, this.#cfg.smtpHost])];
  }

  async open(secret: ResolvedSecret, signal?: AbortSignal): Promise<MailSession> {
    const password = secret.use((v) => v);
    const socket = await this.#dial(this.#cfg.host, this.#cfg.port, signal);
    const client = new ImapClient(socket);
    try {
      await client.greeting();
      await client.login(this.#cfg.username, password);
    } catch (err) {
      client.close();
      throw err;
    }
    return new ImapSession(client, this.#cfg, this.#dial, password);
  }
}

const FLAG: Record<string, string> = {
  seen: "\\Seen",
  flagged: "\\Flagged",
  answered: "\\Answered",
  draft: "\\Draft",
  deleted: "\\Deleted",
};

function imapFlag(flag: string): string {
  const f = FLAG[flag];
  if (f !== undefined) return f;
  if (!/^[A-Za-z0-9_$.-]{1,64}$/.test(flag)) {
    throw new PsycheError("invalid_params", `invalid flag ${JSON.stringify(flag.slice(0, 40))}`);
  }
  return flag;
}

function flagsOf(token: unknown): string[] {
  return (Array.isArray(token) ? token : []).map((t) =>
    asString(t as never)
      .replace(/^\\/, "")
      .toLowerCase(),
  );
}

const ROLE_ATTR: Record<string, MailboxRole> = {
  "\\drafts": "drafts",
  "\\sent": "sent",
  "\\trash": "trash",
  "\\junk": "junk",
  "\\archive": "archive",
  "\\all": "all",
};

const ROLE_NAME: [RegExp, MailboxRole][] = [
  [/^inbox$/i, "inbox"],
  [/draft/i, "drafts"],
  [/^sent|sent (items|mail|messages)$/i, "sent"],
  [/trash|deleted/i, "trash"],
  [/junk|spam/i, "junk"],
  [/^archive/i, "archive"],
  [/^all mail$/i, "all"],
];

export function mailboxRole(entry: ImapListEntry): MailboxRole | undefined {
  if (entry.name.toUpperCase() === "INBOX") return "inbox";
  for (const a of entry.attributes) {
    const r = ROLE_ATTR[a.toLowerCase()];
    if (r !== undefined) return r;
  }
  const leaf =
    entry.delimiter === null ? entry.name : (entry.name.split(entry.delimiter).pop() ?? entry.name);
  for (const [re, role] of ROLE_NAME) if (re.test(leaf)) return role;
  return undefined;
}

const SUMMARY_FIELDS = "(FROM TO CC SUBJECT DATE MESSAGE-ID)";

export class ImapSession implements MailSession {
  readonly #client: ImapClient;
  readonly #cfg: ImapConfig;
  readonly #dial: MailDialer;
  #password: string;
  #mailboxes: MailboxInfo[] | undefined;
  #selected: string | undefined;

  constructor(client: ImapClient, cfg: ImapConfig, dial: MailDialer, password: string) {
    this.#client = client;
    this.#cfg = cfg;
    this.#dial = dial;
    this.#password = password;
  }

  async account(): Promise<string> {
    if (this.#cfg.account !== undefined) return this.#cfg.account;
    return this.#cfg.username.includes("@") ? this.#cfg.username : "";
  }

  async listMailboxes(): Promise<MailboxInfo[]> {
    if (this.#mailboxes !== undefined) return this.#mailboxes;
    const entries = await this.#client.list();
    this.#mailboxes = entries
      .filter((e) => !e.attributes.some((a) => a.toLowerCase() === "\\noselect"))
      .map((e) => {
        const info: MailboxInfo = { id: e.name, name: e.name.slice(0, 200) };
        const role = mailboxRole(e);
        if (role !== undefined) info.role = role;
        return info;
      });
    return this.#mailboxes;
  }

  async #resolveMailbox(nameOrRole: string): Promise<string> {
    const boxes = await this.listMailboxes();
    const hit =
      boxes.find((b) => b.id === nameOrRole) ??
      boxes.find((b) => b.name.toLowerCase() === nameOrRole.toLowerCase()) ??
      boxes.find((b) => b.role === nameOrRole.toLowerCase());
    if (hit === undefined) throw new PsycheError("not_found", `no mailbox ${nameOrRole}`);
    return hit.id;
  }

  async #select(mailbox: string | undefined) {
    const name = mailbox === undefined ? "INBOX" : await this.#resolveMailbox(mailbox);
    const sel = await this.#client.select(name);
    this.#selected = name;
    return { name, ...sel };
  }

  async search(input: MailSearch) {
    const { name } = await this.#select(input.mailbox);
    const criteria: CommandPart[] = [];
    let utf8 = false;
    const text = (key: string, value: string) => {
      criteria.push(key, { string: value });
      if (!/^[\x20-\x7e]*$/.test(value)) utf8 = true;
    };
    if (input.query !== undefined) text("TEXT", input.query);
    if (input.from !== undefined) text("FROM", input.from);
    if (input.to !== undefined) text("TO", input.to);
    if (input.subject !== undefined) text("SUBJECT", input.subject);
    for (const [key, value] of [
      ["SINCE", input.since],
      ["BEFORE", input.before],
    ] as const) {
      if (value === undefined) continue;
      const d = isoToImapDate(value);
      if (d === undefined)
        throw new PsycheError("invalid_params", `${key.toLowerCase()} is not a date`);
      criteria.push(key, d);
    }
    if (input.unread === true) criteria.push("UNSEEN");
    if (criteria.length === 0) criteria.push("ALL");
    let uids: number[];
    try {
      uids = await this.#client.uidSearch(criteria, utf8 ? "UTF-8" : undefined);
    } catch (err) {
      if (err instanceof ImapError && err.response.code === "BADCHARSET") {
        throw new PsycheError("invalid_params", "this server cannot search non-ASCII text");
      }
      throw err;
    }
    uids.sort((a, b) => b - a);
    const limit = Math.min(Math.max(input.maxResults ?? 20, 1), IMAP_MAX_PAGE);
    const position = input.pageToken === undefined ? 0 : Number.parseInt(input.pageToken, 10);
    if (!Number.isInteger(position) || position < 0) {
      throw new PsycheError("invalid_params", "pageToken is invalid");
    }
    const page = uids.slice(position, position + limit);
    const messages: MailSummary[] = [];
    if (page.length > 0) {
      const fetched = await this.#client.uidFetch(
        page.join(","),
        `(UID FLAGS INTERNALDATE RFC822.SIZE BODY.PEEK[HEADER.FIELDS ${SUMMARY_FIELDS}])`,
      );
      const byUid = new Map(fetched.map((f) => [f.uid, f]));
      for (const uid of page) {
        const f = byUid.get(uid);
        if (f === undefined) continue;
        const headers = parseHeaders(
          Buffer.from(asBytes(f.items.get(`BODY[HEADER.FIELDS ${SUMMARY_FIELDS}]`))).toString(
            "latin1",
          ),
        );
        const h = (n: string) => decodeHeaderValue(headerValue(headers, n) ?? "").slice(0, 2000);
        const flags = flagsOf(f.items.get("FLAGS"));
        const s: MailSummary = {
          id: String(uid),
          mailbox: name,
          subject: h("Subject"),
          from: h("From"),
          to: h("To"),
          date: internalDateToIso(asString(f.items.get("INTERNALDATE"))) || h("Date"),
          snippet: "",
          unread: !flags.includes("seen"),
          flags,
        };
        const size = Number(asString(f.items.get("RFC822.SIZE")));
        if (Number.isInteger(size)) s.size = size;
        messages.push(s);
      }
    }
    return {
      messages,
      nextPageToken: position + limit < uids.length ? String(position + limit) : null,
    };
  }

  async #fetchRaw(ref: MailRef) {
    const uid = Number(ref.id);
    if (!Number.isInteger(uid) || uid <= 0)
      throw new PsycheError("invalid_params", "id must be a message UID");
    const { name } = await this.#select(ref.mailbox);
    const [f] = await this.#client.uidFetch(
      String(uid),
      "(UID FLAGS INTERNALDATE RFC822.SIZE BODY.PEEK[])",
    );
    if (f === undefined || f.uid !== uid)
      throw new PsycheError("not_found", `message ${ref.id} not found in ${name}`);
    const raw = asBytes(f.items.get("BODY[]"));
    const flags = flagsOf(f.items.get("FLAGS"));
    const size = Number(asString(f.items.get("RFC822.SIZE")));
    return {
      uid,
      name,
      raw,
      flags,
      date: internalDateToIso(asString(f.items.get("INTERNALDATE"))),
      size,
    };
  }

  async read(ref: MailRef): Promise<MailMessageView> {
    const r = await this.#fetchRaw(ref);
    return messageViewFromRaw(r.raw, {
      id: String(r.uid),
      mailbox: r.name,
      date: r.date,
      unread: !r.flags.includes("seen"),
      flags: r.flags,
      ...(Number.isInteger(r.size) ? { size: r.size } : {}),
    });
  }

  async attachment(ref: MailRef & { partId: string }) {
    const r = await this.#fetchRaw(ref);
    const a = attachmentBytes(r.raw, ref.partId);
    if (a === undefined) throw new PsycheError("not_found", "no such attachment");
    return a;
  }

  async modify(ref: MailRef, change: MailChange): Promise<MailRef> {
    const uid = Number(ref.id);
    if (!Number.isInteger(uid) || uid <= 0)
      throw new PsycheError("invalid_params", "id must be a message UID");
    const { name } = await this.#select(ref.mailbox);
    const add = (change.addFlags ?? []).map(imapFlag);
    const remove = (change.removeFlags ?? []).map(imapFlag);
    if (add.length > 0) await this.#client.uidStore(uid, "+FLAGS", add);
    if (remove.length > 0) await this.#client.uidStore(uid, "-FLAGS", remove);
    if (change.moveTo === undefined) return { id: String(uid), mailbox: name };
    const target = await this.#resolveMailbox(change.moveTo);
    const moved = await this.#client.uidMove(uid, target);
    return { id: moved.newUid === undefined ? String(uid) : String(moved.newUid), mailbox: target };
  }

  async createDraft(_mail: OutgoingMail, raw: Uint8Array) {
    const drafts = await this.#resolveMailbox("drafts");
    const r = await this.#client.append(drafts, ["\\Draft", "\\Seen"], raw);
    return { id: r.uid === undefined ? `appended:${drafts}` : String(r.uid) };
  }

  async send(mail: OutgoingMail, raw: Uint8Array, signal?: AbortSignal) {
    const from = canonicalAddress(mail.from ?? (await this.account()));
    const recipients = [
      ...new Set([...mail.to, ...(mail.cc ?? []), ...(mail.bcc ?? [])].map(canonicalAddress)),
    ];
    const socket = await this.#dial(this.#cfg.smtpHost, this.#cfg.smtpPort, signal);
    const smtp = new SmtpClient(socket);
    let queueId: string | undefined;
    try {
      await smtp.greeting();
      await smtp.ehlo();
      await smtp.authPlain(this.#cfg.smtpUsername, this.#password);
      queueId = (await smtp.send(from, recipients, raw)).queueId;
    } finally {
      await smtp.quit().catch(() => undefined);
    }
    // Best effort: servers that do not file submissions themselves need a copy in Sent.
    let sentUid: number | undefined;
    try {
      const sent = await this.#resolveMailbox("sent");
      sentUid = (await this.#client.append(sent, ["\\Seen"], raw)).uid;
    } catch {
      // the message left through SMTP; the receipt records the queue id
    }
    return { id: queueId ?? (sentUid === undefined ? "sent" : String(sentUid)) };
  }

  async sync(cursor: JsonObject | null): Promise<MailSyncResult> {
    const sel = await this.#select(undefined);
    const prev = (cursor?.inbox ?? undefined) as
      | { uidValidity?: unknown; uidNext?: unknown }
      | undefined;
    const last = prev?.uidNext;
    const next = { inbox: { uidValidity: sel.uidValidity, uidNext: sel.uidNext } };
    if (prev === undefined || prev.uidValidity !== sel.uidValidity || typeof last !== "number") {
      return { changes: 0, full: true, cursor: next, newMessageIds: [] };
    }
    if (sel.uidNext <= last) return { changes: 0, full: false, cursor: next, newMessageIds: [] };
    const uids = (await this.#client.uidSearch(["UID", `${last}:*`])).filter((u) => u >= last);
    return { changes: uids.length, full: false, cursor: next, newMessageIds: uids.map(String) };
  }

  async close(): Promise<void> {
    this.#password = "";
    await this.#client.logout();
  }

  /** The mailbox currently selected (tests). */
  get selected(): string | undefined {
    return this.#selected;
  }
}
