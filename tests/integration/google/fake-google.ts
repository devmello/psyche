import { createHash } from "node:crypto";
import type { StoredTokens, TokenVault } from "@psyche/connectors";

/**
 * Fake Google for scenario 2, adapted from packages/connectors/test/google/fake-google.ts (test
 * dirs are not exported): the OAuth token endpoint with PKCE verification, a consent page that
 * follows the redirect to the loopback receiver, and a small stateful Gmail / Calendar. Every
 * request is recorded; unknown routes answer 599 so a test notices.
 */

export const CLIENT_ID = "1234567890-int2.apps.googleusercontent.com";
export const ACCESS_TOKEN = "ya29.int2-fake-access-token-7f3a9c";
export const REFRESH_TOKEN = "1//int2-fake-refresh-token-c41d0e";
export const OWNER = "owner@example.com";
export const ALICE = "alice@example.org";

export class MemoryVault implements TokenVault {
  readonly tokens = new Map<string, StoredTokens>();
  async load(id: string) {
    return this.tokens.get(id);
  }
  async save(id: string, t: StoredTokens) {
    this.tokens.set(id, structuredClone(t));
  }
  async clear(id: string) {
    this.tokens.delete(id);
  }
}

type Handler = (req: { method: string; url: URL; body: string }) => Response | Promise<Response>;

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");

interface Mail {
  id: string;
  threadId: string;
  from: string;
  subject: string;
  date: string;
  body: string;
}

const INBOX: Mail[] = [
  {
    id: "ma1",
    threadId: "ta",
    from: `Alice <${ALICE}>`,
    subject: "Dentist on Thursday",
    date: "Mon, 19 Oct 2026 08:30:00 +0000",
    body: "Hi! I booked the dentist for you: Thursday 22 October, 15:00-16:00 at Smile Clinic. Can you confirm? Alice",
  },
  {
    id: "mb1",
    threadId: "tb",
    from: "Newsletter <news@shop.example>",
    subject: "Weekly deals",
    date: "Sun, 18 Oct 2026 07:00:00 +0000",
    body: "Deals of the week.",
  },
];

const headers = (m: Mail) => [
  { name: "From", value: m.from },
  { name: "To", value: OWNER },
  { name: "Subject", value: m.subject },
  { name: "Date", value: m.date },
  { name: "Message-ID", value: `<${m.id}@example.org>` },
];

export class FakeGoogle {
  readonly requests: { method: string; url: URL; body: string; auth: string | null }[] = [];
  readonly routes = new Map<string, Handler>();
  readonly codes = new Map<string, { challenge: string; redirect: string; scope: string }>();
  readonly vault = new MemoryVault();
  readonly drafts: { id: string; raw: string; threadId?: string }[] = [];
  readonly sent: { id: string; raw: string; threadId?: string }[] = [];
  readonly events: Record<string, unknown>[] = [];
  lastAuthorize: URLSearchParams | undefined;

  constructor() {
    this.route("GET", "/gmail/v1/users/me/profile", () =>
      Response.json({ emailAddress: "Owner@Example.com", historyId: "9001" }),
    );
    this.route("GET", "/gmail/v1/users/me/threads", () =>
      Response.json({
        threads: [...new Set(INBOX.map((m) => m.threadId))].map((id) => ({ id })),
        resultSizeEstimate: INBOX.length,
      }),
    );
    for (const threadId of new Set(INBOX.map((m) => m.threadId))) {
      this.route("GET", `/gmail/v1/users/me/threads/${threadId}`, ({ url }) => {
        const full = url.searchParams.get("format") === "full";
        return Response.json({
          id: threadId,
          messages: INBOX.filter((m) => m.threadId === threadId).map((m) => ({
            id: m.id,
            threadId,
            labelIds: ["INBOX", "UNREAD"],
            snippet: m.body.slice(0, 40),
            payload: full
              ? {
                  mimeType: "text/plain",
                  headers: headers(m),
                  body: { size: m.body.length, data: b64(m.body) },
                }
              : { headers: headers(m) },
          })),
        });
      });
    }
    this.route("POST", "/gmail/v1/users/me/drafts", ({ body }) => {
      const { message } = JSON.parse(body) as { message: { raw: string; threadId?: string } };
      const id = `draft-${this.drafts.length + 1}`;
      this.drafts.push({ id, ...message });
      return Response.json({ id, message: { id: `dm-${id}`, threadId: message.threadId } });
    });
    this.route("POST", "/gmail/v1/users/me/messages/send", ({ body }) => {
      const msg = JSON.parse(body) as { raw: string; threadId?: string };
      const id = `sent-${this.sent.length + 1}`;
      this.sent.push({ id, ...msg });
      return Response.json({ id, threadId: msg.threadId ?? id, labelIds: ["SENT"] });
    });
    this.route("POST", "/calendar/v3/calendars/primary/events", ({ body }) => {
      const event = {
        id: `evt-${this.events.length + 1}`,
        status: "confirmed",
        ...JSON.parse(body),
      };
      this.events.push(event);
      return Response.json(event);
    });
  }

  route(method: string, path: string, handler: Handler): this {
    this.routes.set(`${method} ${path}`, handler);
    return this;
  }

  /** Raw MIME of a sent message or draft, decoded. */
  static decode(raw: string): string {
    return Buffer.from(raw, "base64url").toString("utf8");
  }

  /** Plays the owner's browser: consent, then follow the redirect to the loopback receiver. */
  readonly openBrowser = async (url: URL) => {
    const q = url.searchParams;
    const code = `code-${this.codes.size + 1}`;
    this.codes.set(code, {
      challenge: q.get("code_challenge") ?? "",
      redirect: q.get("redirect_uri") ?? "",
      scope: q.get("scope") ?? "",
    });
    this.lastAuthorize = q;
    const back = new URL(q.get("redirect_uri") ?? "");
    back.searchParams.set("code", code);
    back.searchParams.set("state", q.get("state") ?? "");
    await fetch(back);
  };

  readonly fetch = async (input: string | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    const body =
      typeof init.body === "string"
        ? init.body
        : init.body === undefined || init.body === null
          ? ""
          : Buffer.from(init.body as Uint8Array).toString("utf8");
    const auth = new Headers(init.headers).get("authorization");
    this.requests.push({ method, url, body, auth });
    if (url.href === "https://oauth2.googleapis.com/token") {
      return this.#token(new URLSearchParams(body));
    }
    if (url.href === "https://oauth2.googleapis.com/revoke")
      return new Response("", { status: 200 });
    if (auth !== `Bearer ${ACCESS_TOKEN}`) {
      return Response.json({ error: { code: 401, status: "UNAUTHENTICATED" } }, { status: 401 });
    }
    const handler = this.routes.get(`${method} ${url.pathname}`);
    if (handler === undefined) {
      return new Response(`no route ${method} ${url.pathname}`, { status: 599 });
    }
    return handler({ method, url, body });
  };

  #token(form: URLSearchParams): Response {
    if (form.get("client_id") !== CLIENT_ID) {
      return Response.json({ error: "invalid_client" }, { status: 401 });
    }
    if (form.get("grant_type") === "authorization_code") {
      const c = this.codes.get(form.get("code") ?? "");
      const challenge = createHash("sha256")
        .update(form.get("code_verifier") ?? "")
        .digest("base64url");
      if (c === undefined || c.challenge !== challenge || c.redirect !== form.get("redirect_uri")) {
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      }
      this.codes.delete(form.get("code") ?? "");
      return Response.json({
        access_token: ACCESS_TOKEN,
        refresh_token: REFRESH_TOKEN,
        expires_in: 3599,
        scope: c.scope,
        token_type: "Bearer",
      });
    }
    if (form.get("grant_type") === "refresh_token") {
      return Response.json({ access_token: ACCESS_TOKEN, expires_in: 3599, token_type: "Bearer" });
    }
    return Response.json({ error: "unsupported_grant_type" }, { status: 400 });
  }
}
