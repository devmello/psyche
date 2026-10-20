import { createHash } from "node:crypto";
import { FakeClock } from "@psyche/testing";
import type { ConnectorContext } from "../../src/framework/types.ts";
import { MS_LOGIN_ORIGIN } from "../../src/microsoft/auth.ts";
import { MemoryLibrary, MemoryVault } from "../mail/helpers.ts";

export const CLIENT_ID = "11111111-2222-3333-4444-555555555555";
export const OWNER = "owner@contoso.example";
export const CDN = "https://files.cdn.example";

type Req = {
  method: string;
  url: URL;
  body: string;
  bytes: Uint8Array;
  auth: string | null;
  headers: Headers;
};
type Handler = (req: Req) => Response | Promise<Response>;

/**
 * Fake Microsoft identity platform + Graph v1.0 behind the connector's `fetch`: the authorize
 * page (played by `openBrowser`), the token endpoint with PKCE verification, the device code
 * endpoint, and a route table for Graph. Graph routes answer only the current access token.
 */
export class FakeGraph {
  readonly clock = new FakeClock();
  readonly vault = new MemoryVault();
  readonly library = new MemoryLibrary();
  readonly requests: { method: string; url: string; auth: string | null }[] = [];
  readonly routes = new Map<string, Handler>();
  readonly codes = new Map<string, { challenge: string; redirect: string }>();
  grantedScope: (requested: string) => string = (r) => r;
  accessToken = "eyJ0eXAi.fake-graph-access-1";
  refreshToken = "M.R3_BAY.fake-refresh-1";
  refreshResult: "ok" | "invalid_grant" = "ok";
  deviceSteps: string[] = ["authorization_pending", "ok"];
  lastAuthorize: URLSearchParams | undefined;
  deviceScope = "";

  route(method: string, path: string, handler: Handler | unknown): this {
    this.routes.set(
      `${method} ${path}`,
      typeof handler === "function" ? (handler as Handler) : () => Response.json(handler),
    );
    return this;
  }

  readonly openBrowser = async (url: URL) => {
    const q = url.searchParams;
    this.lastAuthorize = q;
    const code = `code-${this.codes.size + 1}`;
    this.codes.set(code, {
      challenge: q.get("code_challenge") ?? "",
      redirect: q.get("redirect_uri") ?? "",
    });
    const back = new URL(q.get("redirect_uri") ?? "");
    back.searchParams.set("code", code);
    back.searchParams.set("state", q.get("state") ?? "");
    await fetch(back);
  };

  #tokens(scope: string): Response {
    return Response.json({
      token_type: "Bearer",
      access_token: this.accessToken,
      refresh_token: this.refreshToken,
      expires_in: 3599,
      scope,
    });
  }

  readonly fetch = async (input: string | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    const headers = new Headers(init.headers);
    const bytes =
      init.body === undefined || init.body === null
        ? new Uint8Array()
        : typeof init.body === "string"
          ? Buffer.from(init.body, "utf8")
          : new Uint8Array(init.body as ArrayBuffer);
    const body = Buffer.from(bytes).toString("utf8");
    const auth = headers.get("authorization");
    this.requests.push({ method, url: url.href, auth });
    if (url.origin === MS_LOGIN_ORIGIN) return this.#login(url, new URLSearchParams(body));
    if (url.origin === CDN) {
      const h = this.routes.get(`${method} ${url.pathname}`);
      return h === undefined
        ? new Response("", { status: 404 })
        : h({ method, url, body, bytes, auth, headers });
    }
    if (url.origin !== "https://graph.microsoft.com")
      return new Response("unknown host", { status: 599 });
    if (auth !== `Bearer ${this.accessToken}`) {
      return Response.json({ error: { code: "InvalidAuthenticationToken" } }, { status: 401 });
    }
    const path = url.pathname.replace(/^\/v1\.0/, "");
    const h = this.routes.get(`${method} ${path}`);
    if (h === undefined)
      return Response.json({ error: { code: "ResourceNotFound" } }, { status: 404 });
    return h({ method, url, body, bytes, auth, headers });
  };

  #login(url: URL, form: URLSearchParams): Response {
    if (form.get("client_id") !== CLIENT_ID)
      return Response.json({ error: "invalid_client" }, { status: 400 });
    if (url.pathname.endsWith("/devicecode")) {
      this.deviceScope = form.get("scope") ?? "";
      return Response.json({
        device_code: "dev-code-xyz",
        user_code: "ABCD-EFGH",
        verification_uri: "https://microsoft.com/devicelogin",
        expires_in: 900,
        interval: 5,
        message: "To sign in, use a web browser…",
      });
    }
    const grant = form.get("grant_type");
    if (grant === "authorization_code") {
      const c = this.codes.get(form.get("code") ?? "");
      const challenge = createHash("sha256")
        .update(form.get("code_verifier") ?? "")
        .digest("base64url");
      if (c === undefined || c.challenge !== challenge || c.redirect !== form.get("redirect_uri")) {
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      }
      return this.#tokens(this.grantedScope(form.get("scope") ?? ""));
    }
    if (grant === "urn:ietf:params:oauth:grant-type:device_code") {
      const step = this.deviceSteps.shift() ?? "ok";
      if (step !== "ok") return Response.json({ error: step }, { status: 400 });
      return this.#tokens(this.grantedScope(this.deviceScope));
    }
    if (grant === "refresh_token") {
      if (
        this.refreshResult === "invalid_grant" ||
        form.get("refresh_token") !== this.refreshToken
      ) {
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      }
      this.accessToken = `${this.accessToken}r`;
      this.refreshToken = `${this.refreshToken}r`;
      return this.#tokens("Mail.Read");
    }
    return Response.json({ error: "unsupported_grant_type" }, { status: 400 });
  }

  context(): Omit<ConnectorContext, "emit"> {
    return { clock: this.clock, fetch: this.fetch, tokens: this.vault, library: this.library };
  }
}
