import type { FakeMailMessage, FakeMailStore } from "./store.ts";

/**
 * Fake JMAP server (RFC 8620 / 8621 / 8617 subset) over a `FakeMailStore`, served through a
 * `fetch` function: the session resource, the API endpoint, blob upload and download (on a
 * second host, like Fastmail). Requests are recorded without the token; a wrong bearer token
 * gets 401.
 */

type Json = Record<string, unknown>;

export interface FakeJmapServerOptions {
  /** API host; default `https://api.fastmail.example`. */
  origin?: string;
  /** Blob download host; default `https://files.fastmail.example`. */
  downloadOrigin?: string;
}

const KEYWORD: Record<string, string> = {
  Seen: "$seen",
  Flagged: "$flagged",
  Answered: "$answered",
  Draft: "$draft",
  Forwarded: "$forwarded",
};
const FLAG: Record<string, string> = Object.fromEntries(
  Object.entries(KEYWORD).map(([k, v]) => [v, k]),
);

function keywordsOf(msg: FakeMailMessage): Record<string, true> {
  return Object.fromEntries([...msg.flags].map((f) => [KEYWORD[f] ?? f, true]));
}

function flagOf(keyword: string): string {
  return FLAG[keyword] ?? keyword;
}

function addresses(value: string): { name: string | null; email: string }[] {
  if (value === "") return [];
  return value.split(",").map((part) => {
    const m = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(part);
    if (m === null) return { name: null, email: part.trim() };
    return { name: (m[1] ?? "").replace(/^"|"$/g, "") || null, email: (m[2] ?? "").trim() };
  });
}

export class FakeJmapServer {
  readonly store: FakeMailStore;
  readonly origin: string;
  readonly downloadOrigin: string;
  readonly accountId = "acc_owner";
  readonly identityId = "ident_1";
  readonly requests: { method: string; url: string; authorized: boolean }[] = [];
  readonly submissions: { id: string; emailId: string; identityId: string }[] = [];
  /** When true `Email/changes` answers `cannotCalculateChanges`, forcing a full sync. */
  cannotCalculateChanges = false;
  readonly #blobs = new Map<string, { bytes: Uint8Array; type: string }>();
  #uploads = 0;

  constructor(store: FakeMailStore, options: FakeJmapServerOptions = {}) {
    this.store = store;
    this.origin = options.origin ?? "https://api.fastmail.example";
    this.downloadOrigin = options.downloadOrigin ?? "https://files.fastmail.example";
  }

  get sessionUrl(): string {
    return `${this.origin}/jmap/session`;
  }

  get hosts(): string[] {
    return [new URL(this.origin).host, new URL(this.downloadOrigin).host];
  }

  readonly fetch = async (input: string | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    const headers = new Headers(init.headers);
    const authorized = headers.get("authorization") === `Bearer ${this.store.account.secret}`;
    this.requests.push({ method, url: url.href, authorized });
    if (!authorized) return Response.json({ type: "unauthorized" }, { status: 401 });
    if (url.href === this.sessionUrl) return Response.json(this.#session());
    if (url.origin === this.origin && url.pathname === "/jmap/api/" && method === "POST") {
      const body = JSON.parse(await bodyText(init.body)) as { methodCalls?: unknown[] };
      const methodResponses = (body.methodCalls ?? []).map((c) =>
        this.#method(c as [string, Json, string], body),
      );
      return Response.json({ methodResponses, sessionState: String(this.store.state) });
    }
    if (
      url.origin === this.origin &&
      url.pathname.startsWith("/jmap/upload/") &&
      method === "POST"
    ) {
      const bytes = await bodyBytes(init.body);
      this.#uploads += 1;
      const blobId = `upl_${String(this.#uploads).padStart(4, "0")}`;
      this.#blobs.set(blobId, {
        bytes,
        type: headers.get("content-type") ?? "application/octet-stream",
      });
      return Response.json({
        accountId: this.accountId,
        blobId,
        type: headers.get("content-type"),
        size: bytes.byteLength,
      });
    }
    if (url.origin === this.downloadOrigin && url.pathname.startsWith("/jmap/download/")) {
      const [, , , , blobId] = url.pathname.split("/");
      const msg = this.store.messages.find((m) => m.blobId === blobId);
      const blob =
        msg === undefined
          ? this.#blobs.get(blobId ?? "")
          : { bytes: msg.raw, type: "message/rfc822" };
      if (blob === undefined) return new Response("not found", { status: 404 });
      return new Response(
        blob.bytes.buffer.slice(
          blob.bytes.byteOffset,
          blob.bytes.byteOffset + blob.bytes.byteLength,
        ) as ArrayBuffer,
        { headers: { "content-type": blob.type } },
      );
    }
    return new Response(`no route ${method} ${url.pathname}`, { status: 599 });
  };

  #session(): Json {
    return {
      capabilities: { "urn:ietf:params:jmap:core": { maxSizeUpload: 50_000_000 } },
      accounts: {
        [this.accountId]: { name: this.store.account.address, isPersonal: true, isReadOnly: false },
      },
      primaryAccounts: {
        "urn:ietf:params:jmap:mail": this.accountId,
        "urn:ietf:params:jmap:submission": this.accountId,
      },
      username: this.store.account.address,
      apiUrl: `${this.origin}/jmap/api/`,
      downloadUrl: `${this.downloadOrigin}/jmap/download/{accountId}/{blobId}/{name}?type={type}`,
      uploadUrl: `${this.origin}/jmap/upload/{accountId}/`,
      eventSourceUrl: `${this.origin}/jmap/event/`,
      state: String(this.store.state),
    };
  }

  #email(msg: FakeMailMessage, properties?: string[]): Json {
    const h = (name: string) => this.store.header(msg, name);
    const text = this.store.searchable(msg).split("\n").slice(-3).join(" ").trim();
    const all: Json = {
      id: msg.id,
      blobId: msg.blobId,
      threadId: msg.threadId,
      mailboxIds: { [msg.mailbox]: true },
      keywords: keywordsOf(msg),
      size: msg.raw.byteLength,
      receivedAt: msg.receivedAt,
      from: addresses(h("From")),
      to: addresses(h("To")),
      cc: addresses(h("Cc")),
      subject: h("Subject"),
      preview: text.slice(0, 256),
      messageId: h("Message-ID") === "" ? null : [h("Message-ID").replace(/^<|>$/g, "")],
    };
    if (properties === undefined) return all;
    return Object.fromEntries(["id", ...properties].map((p) => [p, all[p] ?? null]));
  }

  #method(call: [string, Json, string], body: { methodCalls?: unknown[] }): [string, Json, string] {
    const [name, args, tag] = call;
    if (args.accountId !== this.accountId) return ["error", { type: "accountNotFound" }, tag];
    const resolveIds = (): string[] | null => {
      if (Array.isArray(args.ids)) return args.ids as string[];
      const ref = args["#ids"] as { resultOf?: string; name?: string; path?: string } | undefined;
      if (ref !== undefined) {
        const prior = this.#responses.find((r) => r[2] === ref.resultOf && r[0] === ref.name);
        const ids = prior?.[1].ids;
        return Array.isArray(ids) ? (ids as string[]) : [];
      }
      return null;
    };
    const respond = (r: [string, Json, string]) => {
      this.#responses.push(r);
      return r;
    };
    if (body.methodCalls?.[0] === call) this.#responses = [];
    switch (name) {
      case "Mailbox/get":
        return respond([
          name,
          {
            accountId: this.accountId,
            state: String(this.store.state),
            list: this.store.mailboxes.map((m) => ({
              id: m.id,
              name: m.name,
              role: m.role ?? null,
              parentId: null,
              totalEmails: this.store.inMailbox(m.id).length,
              unreadEmails: this.store.inMailbox(m.id).filter((x) => !x.flags.has("Seen")).length,
            })),
            notFound: [],
          },
          tag,
        ]);
      case "Identity/get":
        return respond([
          name,
          {
            accountId: this.accountId,
            state: "1",
            list: [
              {
                id: this.identityId,
                name: "",
                email: this.store.account.address,
                mayDelete: false,
              },
            ],
            notFound: [],
          },
          tag,
        ]);
      case "Email/query": {
        const f = (args.filter ?? {}) as Record<string, unknown>;
        let list = this.store.messages.filter((m) => {
          if (typeof f.inMailbox === "string" && m.mailbox !== f.inMailbox) return false;
          const s = this.store.searchable(m);
          for (const key of ["text", "from", "to", "subject"] as const) {
            const v = f[key];
            if (typeof v !== "string") continue;
            const hay = key === "text" ? s : this.store.header(m, key).toLowerCase();
            if (!hay.includes(v.toLowerCase())) return false;
          }
          if (typeof f.after === "string" && m.receivedAt < f.after) return false;
          if (typeof f.before === "string" && m.receivedAt >= f.before) return false;
          if (f.notKeyword === "$seen" && m.flags.has("Seen")) return false;
          return true;
        });
        list = list.sort((a, b) => (a.receivedAt < b.receivedAt ? 1 : -1));
        const position = typeof args.position === "number" ? args.position : 0;
        const limit = typeof args.limit === "number" ? args.limit : 50;
        const ids = list.slice(position, position + limit).map((m) => m.id);
        return respond([
          name,
          {
            accountId: this.accountId,
            queryState: String(this.store.state),
            canCalculateChanges: false,
            position,
            ids,
            total: list.length,
          },
          tag,
        ]);
      }
      case "Email/get": {
        const ids = resolveIds();
        const props = Array.isArray(args.properties) ? (args.properties as string[]) : undefined;
        const found =
          ids === null
            ? this.store.messages
            : ids
                .map((id) => this.store.get(id))
                .filter((m): m is FakeMailMessage => m !== undefined);
        const notFound = ids === null ? [] : ids.filter((id) => this.store.get(id) === undefined);
        return respond([
          name,
          {
            accountId: this.accountId,
            state: String(this.store.state),
            list: found.map((m) => this.#email(m, props)),
            notFound,
          },
          tag,
        ]);
      }
      case "Email/set": {
        const updated: Json = {};
        const notUpdated: Json = {};
        for (const [id, patch] of Object.entries((args.update ?? {}) as Record<string, Json>)) {
          const msg = this.store.get(id);
          if (msg === undefined) {
            notUpdated[id] = { type: "notFound" };
            continue;
          }
          this.#applyPatch(msg, patch);
          updated[id] = null;
        }
        const destroyed: string[] = [];
        for (const id of Array.isArray(args.destroy) ? (args.destroy as string[]) : []) {
          this.store.remove(id);
          destroyed.push(id);
        }
        return respond([
          name,
          {
            accountId: this.accountId,
            oldState: String(this.store.state - 1),
            newState: String(this.store.state),
            updated,
            notUpdated,
            destroyed,
          },
          tag,
        ]);
      }
      case "Email/import": {
        const created: Json = {};
        const notCreated: Json = {};
        for (const [cid, spec] of Object.entries((args.emails ?? {}) as Record<string, Json>)) {
          const blob = this.#blobs.get(String(spec.blobId));
          const mailbox = Object.keys((spec.mailboxIds ?? {}) as Json)[0];
          if (
            blob === undefined ||
            mailbox === undefined ||
            this.store.mailbox(mailbox) === undefined
          ) {
            notCreated[cid] = { type: blob === undefined ? "blobNotFound" : "invalidProperties" };
            continue;
          }
          const flags = Object.keys((spec.keywords ?? {}) as Json).map(flagOf);
          const msg = this.store.add(mailbox, blob.bytes, { flags });
          created[cid] = {
            id: msg.id,
            blobId: msg.blobId,
            threadId: msg.threadId,
            size: msg.raw.byteLength,
          };
        }
        return respond([
          name,
          {
            accountId: this.accountId,
            oldState: String(this.store.state - 1),
            newState: String(this.store.state),
            created,
            notCreated,
          },
          tag,
        ]);
      }
      case "EmailSubmission/set": {
        const created: Json = {};
        const notCreated: Json = {};
        for (const [cid, spec] of Object.entries((args.create ?? {}) as Record<string, Json>)) {
          const msg = this.store.get(String(spec.emailId));
          if (msg === undefined || spec.identityId !== this.identityId) {
            notCreated[cid] = { type: msg === undefined ? "emailNotFound" : "invalidProperties" };
            continue;
          }
          const id = `sub_${String(this.submissions.length + 1).padStart(4, "0")}`;
          this.submissions.push({ id, emailId: msg.id, identityId: this.identityId });
          created[cid] = { id, undoStatus: "final" };
          const patch = ((args.onSuccessUpdateEmail ?? {}) as Record<string, Json>)[`#${cid}`];
          if (patch !== undefined) this.#applyPatch(msg, patch);
        }
        return respond([name, { accountId: this.accountId, created, notCreated }, tag]);
      }
      case "Email/changes": {
        if (this.cannotCalculateChanges)
          return respond(["error", { type: "cannotCalculateChanges" }, tag]);
        const since = Number(args.sinceState);
        const created = this.store.messages.filter((m) => m.addedAt > since).map((m) => m.id);
        const updated = this.store.messages
          .filter((m) => m.addedAt <= since && m.updatedAt > since)
          .map((m) => m.id);
        const destroyed = this.store.removed.filter((r) => r.at > since).map((r) => r.id);
        return respond([
          name,
          {
            accountId: this.accountId,
            oldState: String(since),
            newState: String(this.store.state),
            hasMoreChanges: false,
            created,
            updated,
            destroyed,
          },
          tag,
        ]);
      }
      default:
        return respond(["error", { type: "unknownMethod" }, tag]);
    }
  }

  #responses: [string, Json, string][] = [];

  #applyPatch(msg: FakeMailMessage, patch: Json): void {
    const add: string[] = [];
    const remove: string[] = [];
    for (const [key, value] of Object.entries(patch)) {
      if (key.startsWith("keywords/")) {
        (value === null ? remove : add).push(flagOf(key.slice("keywords/".length)));
      } else if (key === "mailboxIds") {
        const target = Object.keys((value ?? {}) as Json)[0];
        if (target !== undefined && target !== msg.mailbox) this.store.move(msg.id, target);
      } else if (key.startsWith("mailboxIds/") && value === true) {
        const target = key.slice("mailboxIds/".length);
        if (target !== msg.mailbox) this.store.move(msg.id, target);
      } else if (key === "keywords") {
        const next = Object.keys((value ?? {}) as Json).map(flagOf);
        remove.push(...[...msg.flags].filter((f) => !next.includes(f)));
        add.push(...next);
      }
    }
    if (add.length > 0 || remove.length > 0) this.store.setFlags(msg.id, add, remove);
  }
}

async function bodyText(body: RequestInit["body"]): Promise<string> {
  if (body === undefined || body === null) return "";
  if (typeof body === "string") return body;
  return Buffer.from(await bodyBytes(body)).toString("utf8");
}

async function bodyBytes(body: RequestInit["body"]): Promise<Uint8Array> {
  if (body === undefined || body === null) return new Uint8Array();
  if (typeof body === "string") return Buffer.from(body, "utf8");
  if (body instanceof Uint8Array) return body;
  return new Uint8Array(await new Response(body).arrayBuffer());
}
