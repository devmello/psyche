import { type JsonObject, PsycheError } from "@psyche/protocol";
import type { OutgoingMail } from "../google/mime.ts";
import { attachmentBytes, messageViewFromRaw } from "../mail/rfc822.ts";
import type {
  MailboxInfo,
  MailboxRole,
  MailChange,
  MailMessageView,
  MailRef,
  MailSearch,
  MailSession,
  MailSummary,
  MailSyncResult,
} from "../mail/types.ts";
import { type GraphApi, GraphError, odataString } from "./api.ts";

/**
 * Outlook mail over Graph as a `MailSession`, so Microsoft accounts get the shared mail tools
 * (`mail_*`) and bindings. Reads fetch the raw MIME (`$value`) and go through the same bounded
 * parser and hidden-text stripping as IMAP / JMAP; drafts and sends upload the MIME the tools
 * built (base64, `text/plain`), so what the owner approved is what Graph sends.
 */

const WELL_KNOWN: [string, MailboxRole][] = [
  ["inbox", "inbox"],
  ["drafts", "drafts"],
  ["sentitems", "sent"],
  ["deleteditems", "trash"],
  ["junkemail", "junk"],
  ["archive", "archive"],
];

const SUMMARY_SELECT =
  "id,conversationId,parentFolderId,subject,from,toRecipients,receivedDateTime,bodyPreview,isRead,flag,categories";
export const OUTLOOK_MAX_PAGE = 50;
const MAX_DELTA_PAGES = 20;

interface GraphAddress {
  emailAddress?: { name?: unknown; address?: unknown };
}

interface GraphMessage {
  id?: string;
  conversationId?: string;
  parentFolderId?: string;
  subject?: string;
  from?: GraphAddress;
  toRecipients?: GraphAddress[];
  receivedDateTime?: string;
  bodyPreview?: string;
  isRead?: boolean;
  flag?: { flagStatus?: string };
  categories?: string[];
}

function address(a: GraphAddress | undefined): string {
  const email = typeof a?.emailAddress?.address === "string" ? a.emailAddress.address : "";
  const name = typeof a?.emailAddress?.name === "string" ? a.emailAddress.name : "";
  return name !== "" && name !== email ? `${name} <${email}>` : email;
}

function flagsOf(m: GraphMessage): string[] {
  const out: string[] = [];
  if (m.isRead === true) out.push("seen");
  if (m.flag?.flagStatus === "flagged") out.push("flagged");
  for (const c of m.categories ?? []) if (typeof c === "string") out.push(c.toLowerCase());
  return out;
}

/** KQL value without quotes or control characters (Graph `$search`). */
function kql(v: string): string {
  let out = "";
  for (const ch of v) out += ch === '"' || ch.charCodeAt(0) < 0x20 ? " " : ch;
  return out.replace(/\s+/g, " ").trim().slice(0, 200);
}

function day(iso: string, name: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new PsycheError("invalid_params", `${name} is not a date`);
  return d.toISOString().slice(0, 10);
}

export class GraphMailSession implements MailSession {
  readonly #api: GraphApi;
  readonly #account: () => string;
  #folders: MailboxInfo[] | undefined;

  constructor(api: GraphApi, account: () => string) {
    this.#api = api;
    this.#account = account;
  }

  async account(): Promise<string> {
    return this.#account();
  }

  async listMailboxes(signal?: AbortSignal): Promise<MailboxInfo[]> {
    if (this.#folders !== undefined) return this.#folders;
    const list = await this.#api.json<{ value?: Record<string, unknown>[] }>("/me/mailFolders", {
      query: { $top: 100, $select: "id,displayName,totalItemCount,unreadItemCount" },
      ...(signal === undefined ? {} : { signal }),
    });
    const roles = new Map<string, MailboxRole>();
    for (const [wk, role] of WELL_KNOWN) {
      try {
        const f = await this.#api.json<{ id?: string }>(`/me/mailFolders/${wk}`, {
          query: { $select: "id" },
          ...(signal === undefined ? {} : { signal }),
        });
        if (typeof f.id === "string") roles.set(f.id, role);
      } catch (err) {
        if (!(err instanceof GraphError && err.status === 404)) throw err;
      }
    }
    this.#folders = (list.value ?? []).map((f) => {
      const id = String(f.id ?? "");
      const info: MailboxInfo = { id, name: String(f.displayName ?? "").slice(0, 200) };
      const role = roles.get(id);
      if (role !== undefined) info.role = role;
      if (typeof f.totalItemCount === "number") info.total = f.totalItemCount;
      if (typeof f.unreadItemCount === "number") info.unread = f.unreadItemCount;
      return info;
    });
    return this.#folders;
  }

  /** A folder id from an id, a display name or a role; default the inbox. */
  async #folder(mailbox: string | undefined, signal?: AbortSignal): Promise<string> {
    if (mailbox === undefined) return "inbox";
    const boxes = await this.listMailboxes(signal);
    const hit =
      boxes.find((b) => b.id === mailbox) ??
      boxes.find((b) => b.name.toLowerCase() === mailbox.toLowerCase()) ??
      boxes.find((b) => b.role === mailbox.toLowerCase());
    if (hit === undefined) throw new PsycheError("not_found", `no mailbox ${mailbox}`);
    return hit.id;
  }

  async search(input: MailSearch, signal?: AbortSignal) {
    const top = Math.min(Math.max(input.maxResults ?? 20, 1), OUTLOOK_MAX_PAGE);
    const folder = await this.#folder(input.mailbox, signal);
    let page: { value?: GraphMessage[]; "@odata.nextLink"?: string };
    if (input.pageToken !== undefined) {
      page = await this.#api.json(input.pageToken, { ...(signal === undefined ? {} : { signal }) });
    } else {
      const query: Record<string, string | number> = { $top: top, $select: SUMMARY_SELECT };
      if (input.query !== undefined || input.to !== undefined) {
        // $search (KQL) cannot be combined with $filter on messages: fold everything into KQL.
        const parts: string[] = [];
        if (input.query !== undefined) parts.push(kql(input.query));
        if (input.from !== undefined) parts.push(`from:${kql(input.from)}`);
        if (input.to !== undefined) parts.push(`to:${kql(input.to)}`);
        if (input.subject !== undefined) parts.push(`subject:${kql(input.subject)}`);
        if (input.since !== undefined) parts.push(`received>=${day(input.since, "since")}`);
        if (input.before !== undefined) parts.push(`received<${day(input.before, "before")}`);
        if (input.unread === true) parts.push("isread:false");
        query.$search = `"${parts.join(" ")}"`;
      } else {
        const filters: string[] = [];
        if (input.from !== undefined)
          filters.push(`from/emailAddress/address eq ${odataString(input.from)}`);
        if (input.subject !== undefined)
          filters.push(`contains(subject,${odataString(input.subject)})`);
        if (input.since !== undefined)
          filters.push(`receivedDateTime ge ${new Date(day(input.since, "since")).toISOString()}`);
        if (input.before !== undefined)
          filters.push(
            `receivedDateTime lt ${new Date(day(input.before, "before")).toISOString()}`,
          );
        if (input.unread === true) filters.push("isRead eq false");
        if (filters.length > 0) query.$filter = filters.join(" and ");
      }
      page = await this.#api.json(`/me/mailFolders/${encodeURIComponent(folder)}/messages`, {
        query,
        ...(signal === undefined ? {} : { signal }),
      });
    }
    const messages: MailSummary[] = (page.value ?? []).map((m) => {
      const s: MailSummary = {
        id: String(m.id ?? ""),
        mailbox: String(m.parentFolderId ?? folder),
        subject: String(m.subject ?? "").slice(0, 2000),
        from: address(m.from),
        to: (m.toRecipients ?? []).map(address).join(", "),
        date: String(m.receivedDateTime ?? ""),
        snippet: String(m.bodyPreview ?? "").slice(0, 256),
        unread: m.isRead !== true,
        flags: flagsOf(m),
      };
      if (typeof m.conversationId === "string") s.threadId = m.conversationId;
      return s;
    });
    const next = page["@odata.nextLink"];
    // Paging links must stay on Graph (the token goes with them).
    if (typeof next === "string") this.#api.url(next);
    return { messages, nextPageToken: typeof next === "string" ? next : null };
  }

  async #meta(id: string, signal?: AbortSignal): Promise<GraphMessage> {
    return this.#api.json<GraphMessage>(`/me/messages/${encodeURIComponent(id)}`, {
      query: { $select: SUMMARY_SELECT },
      ...(signal === undefined ? {} : { signal }),
    });
  }

  async #raw(id: string, signal?: AbortSignal): Promise<Uint8Array> {
    const res = await this.#api.request(`/me/messages/${encodeURIComponent(id)}/$value`, {
      ...(signal === undefined ? {} : { signal }),
    });
    return new Uint8Array(await res.arrayBuffer());
  }

  async read(ref: MailRef, signal?: AbortSignal): Promise<MailMessageView> {
    const meta = await this.#meta(ref.id, signal);
    const raw = await this.#raw(ref.id, signal);
    return messageViewFromRaw(raw, {
      id: ref.id,
      mailbox: String(meta.parentFolderId ?? ref.mailbox ?? ""),
      ...(typeof meta.conversationId === "string" ? { threadId: meta.conversationId } : {}),
      date: String(meta.receivedDateTime ?? ""),
      unread: meta.isRead !== true,
      flags: flagsOf(meta),
    });
  }

  async attachment(ref: MailRef & { partId: string }, signal?: AbortSignal) {
    const a = attachmentBytes(await this.#raw(ref.id, signal), ref.partId);
    if (a === undefined) throw new PsycheError("not_found", "no such attachment");
    return a;
  }

  async modify(ref: MailRef, change: MailChange, signal?: AbortSignal): Promise<MailRef> {
    const add = new Set(change.addFlags ?? []);
    const remove = new Set(change.removeFlags ?? []);
    for (const f of [...add, ...remove]) {
      if (f === "answered" || f === "draft" || f === "deleted") {
        throw new PsycheError("invalid_params", `Outlook does not let clients set ${f}`);
      }
    }
    const patch: JsonObject = {};
    if (add.has("seen")) patch.isRead = true;
    if (remove.has("seen")) patch.isRead = false;
    if (add.has("flagged")) patch.flag = { flagStatus: "flagged" };
    if (remove.has("flagged")) patch.flag = { flagStatus: "notFlagged" };
    const cats = [...add, ...remove].filter((f) => f !== "seen" && f !== "flagged");
    if (cats.length > 0) {
      const current = (await this.#meta(ref.id, signal)).categories ?? [];
      const next = new Set(current.filter((c) => !remove.has(c.toLowerCase())));
      for (const c of add) if (c !== "seen" && c !== "flagged") next.add(c);
      patch.categories = [...next];
    }
    const path = `/me/messages/${encodeURIComponent(ref.id)}`;
    if (Object.keys(patch).length > 0) {
      await this.#api.json(path, {
        method: "PATCH",
        json: patch,
        ...(signal === undefined ? {} : { signal }),
      });
    }
    if (change.moveTo === undefined)
      return { id: ref.id, ...(ref.mailbox === undefined ? {} : { mailbox: ref.mailbox }) };
    const destinationId = await this.#folder(change.moveTo, signal);
    // A move gives the message a new id in its new folder.
    const moved = await this.#api.json<{ id?: string; parentFolderId?: string }>(`${path}/move`, {
      method: "POST",
      json: { destinationId },
      ...(signal === undefined ? {} : { signal }),
    });
    return {
      id: String(moved.id ?? ref.id),
      mailbox: String(moved.parentFolderId ?? destinationId),
    };
  }

  async createDraft(_mail: OutgoingMail, raw: Uint8Array, signal?: AbortSignal) {
    const draft = await this.#api.json<{ id?: string }>("/me/messages", {
      method: "POST",
      body: Buffer.from(raw).toString("base64"),
      contentType: "text/plain",
      ...(signal === undefined ? {} : { signal }),
    });
    if (typeof draft.id !== "string")
      throw new PsycheError("internal", "Graph returned no draft id");
    return { id: draft.id };
  }

  async send(_mail: OutgoingMail, raw: Uint8Array, signal?: AbortSignal) {
    // 202 Accepted with no body; Outlook files the message in Sent Items itself.
    await this.#api.json("/me/sendMail", {
      method: "POST",
      body: Buffer.from(raw).toString("base64"),
      contentType: "text/plain",
      ...(signal === undefined ? {} : { signal }),
    });
    return { id: "accepted" };
  }

  async sync(cursor: JsonObject | null, signal?: AbortSignal): Promise<MailSyncResult> {
    const prev = typeof cursor?.deltaLink === "string" ? cursor.deltaLink : undefined;
    const start = "/me/mailFolders/inbox/messages/delta";
    let full = prev === undefined;
    let url: string = prev ?? start;
    const created: string[] = [];
    let changes = 0;
    for (let i = 0; i < MAX_DELTA_PAGES; i++) {
      let page: {
        value?: { id?: string; "@removed"?: unknown }[];
        "@odata.nextLink"?: string;
        "@odata.deltaLink"?: string;
      };
      try {
        page = await this.#api.json(url, {
          ...(url === start ? { query: { $select: "id" } } : {}),
          ...(signal === undefined ? {} : { signal }),
        });
      } catch (err) {
        // An expired delta token: start over (as Gmail's 404 history).
        if (
          err instanceof GraphError &&
          (err.status === 410 || err.graphCode === "syncStateNotFound") &&
          !full
        ) {
          full = true;
          url = start;
          continue;
        }
        throw err;
      }
      for (const v of page.value ?? []) {
        changes += 1;
        if (!full && v["@removed"] === undefined && typeof v.id === "string") created.push(v.id);
      }
      if (typeof page["@odata.deltaLink"] === "string") {
        this.#api.url(page["@odata.deltaLink"]);
        return {
          changes: full ? 0 : changes,
          full,
          cursor: { deltaLink: page["@odata.deltaLink"] },
          newMessageIds: created,
        };
      }
      const next = page["@odata.nextLink"];
      if (typeof next !== "string") break;
      url = next;
    }
    return {
      changes: full ? 0 : changes,
      full,
      cursor: prev === undefined ? {} : { deltaLink: prev },
      newMessageIds: created,
    };
  }

  async close(): Promise<void> {}
}
