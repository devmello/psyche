import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { FakeClock } from "@psyche/testing";
import type {
  ConnectorContext,
  LibrarySink,
  StoredTokens,
  TokenVault,
} from "../../src/framework/types.ts";

/** Recorded response bodies (shapes from the Gmail / Calendar / Drive references). */
export function fixture<T = unknown>(name: string): T {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8")) as T;
}

export const CLIENT_ID = "1234567890-abc.apps.googleusercontent.com";

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

export class MemoryLibrary implements LibrarySink {
  readonly items: Parameters<LibrarySink["put"]>[0][] = [];
  async put(input: Parameters<LibrarySink["put"]>[0]) {
    this.items.push(input);
    return { libraryItemId: `lib_${this.items.length}` };
  }
}

type Handler = (req: {
  method: string;
  url: URL;
  body: string;
  headers: Headers;
}) => Response | Promise<Response>;

/**
 * Fake Google: OAuth token endpoint with PKCE verification, plus a route table for the REST
 * APIs. Every request is recorded; requests to unknown routes fail the test with a 599.
 */
export class FakeGoogle {
  readonly requests: { method: string; url: URL; body: string; auth: string | null }[] = [];
  readonly routes = new Map<string, Handler>();
  readonly codes = new Map<string, { challenge: string; redirect: string; scope: string }>();
  grantScope: ((requested: string) => string) | undefined;
  refreshResult: "ok" | "invalid_grant" = "ok";
  accessToken = "ya29.fake-access-token-1";
  readonly clock = new FakeClock();
  readonly vault = new MemoryVault();
  readonly library = new MemoryLibrary();
  readonly events: unknown[] = [];

  route(method: string, path: string, handler: Handler | unknown): this {
    this.routes.set(
      `${method} ${path}`,
      typeof handler === "function" ? (handler as Handler) : () => Response.json(handler),
    );
    return this;
  }

  /** Plays the owner's browser: consent, then follow the redirect to the loopback receiver. */
  readonly openBrowser = async (url: URL) => {
    const q = url.searchParams;
    const code = `code-${this.codes.size + 1}`;
    const scope = this.grantScope?.(q.get("scope") ?? "") ?? q.get("scope") ?? "";
    this.codes.set(code, {
      challenge: q.get("code_challenge") ?? "",
      redirect: q.get("redirect_uri") ?? "",
      scope,
    });
    this.lastAuthorize = q;
    const back = new URL(q.get("redirect_uri") ?? "");
    back.searchParams.set("code", code);
    back.searchParams.set("state", q.get("state") ?? "");
    await fetch(back);
  };
  lastAuthorize: URLSearchParams | undefined;

  readonly fetch = async (input: string | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    const body =
      typeof init.body === "string"
        ? init.body
        : init.body === undefined
          ? ""
          : Buffer.from(init.body as Uint8Array).toString("utf8");
    const headers = new Headers(init.headers);
    this.requests.push({ method, url, body, auth: headers.get("authorization") });
    if (url.href === "https://oauth2.googleapis.com/token")
      return this.#token(new URLSearchParams(body));
    if (url.href === "https://oauth2.googleapis.com/revoke")
      return new Response("", { status: 200 });
    if (headers.get("authorization") !== `Bearer ${this.accessToken}`) {
      return Response.json({ error: { code: 401, status: "UNAUTHENTICATED" } }, { status: 401 });
    }
    const handler = this.routes.get(`${method} ${url.pathname}`);
    if (handler === undefined)
      return new Response(`no route ${method} ${url.pathname}`, { status: 599 });
    return handler({ method, url, body, headers });
  };

  #token(form: URLSearchParams): Response {
    if (form.get("client_id") !== CLIENT_ID)
      return Response.json({ error: "invalid_client" }, { status: 401 });
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
        access_token: this.accessToken,
        refresh_token: "1//fake-refresh-token-abcdef",
        expires_in: 3599,
        scope: c.scope,
        token_type: "Bearer",
      });
    }
    if (form.get("grant_type") === "refresh_token") {
      if (this.refreshResult === "invalid_grant")
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      return Response.json({
        access_token: this.accessToken,
        expires_in: 3599,
        token_type: "Bearer",
      });
    }
    return Response.json({ error: "unsupported_grant_type" }, { status: 400 });
  }

  context(): Omit<ConnectorContext, "emit"> {
    return { clock: this.clock, fetch: this.fetch, tokens: this.vault, library: this.library };
  }
}
