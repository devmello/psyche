import { createReadStream, existsSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { PROTOCOL_VERSION } from "@psyche/protocol";
import { handleMapProxy, MAP_PROXY_PREFIX } from "./map-proxy.ts";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json",
};

/** Strict CSP for the web UI: it may talk only to its own origin (security §10, CVE-2026-25253 rules). */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "worker-src 'self' blob:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join("; ");

export interface HttpDeps {
  webRoot: string | null;
  version: string;
  /** The tile origins the map proxy may reach (read per request); no proxy route without it. */
  mapOrigins?: () => string[];
}

function send(res: ServerResponse, status: number, body: string, type = "application/json"): void {
  res.writeHead(status, {
    "content-type": type,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(body);
}

/** A self-authenticating route a composed part mounts (a channel webhook, e.g. Twilio). */
export interface WebhookRequest {
  /** `POST`, or `GET` on a route that declares it. */
  method: WebhookMethod;
  /** Path and query as received. */
  url: string;
  headers: Readonly<Record<string, string | string[] | undefined>>;
  /** The capped body; always empty for `GET`. */
  body: Uint8Array;
}

export interface WebhookResponse {
  status: number;
  headers?: Record<string, string>;
  body: string;
}

export type WebhookMethod = "GET" | "POST";

/**
 * A webhook handler. `POST` only unless it declares `methods` (WhatsApp's subscription handshake
 * is a `GET`); a `GET` is handed over without reading a body.
 */
export type WebhookRoute = ((request: WebhookRequest) => Promise<WebhookResponse>) & {
  readonly methods?: readonly WebhookMethod[];
};

/** The methods a route answers: its declared ones, else `POST`. */
export function webhookMethods(route: WebhookRoute): readonly WebhookMethod[] {
  return route.methods !== undefined && route.methods.length > 0 ? route.methods : ["POST"];
}

/** `fn` as a route that answers `methods` (e.g. `["GET", "POST"]`). */
export function webhookRoute(
  methods: readonly WebhookMethod[],
  fn: (request: WebhookRequest) => Promise<WebhookResponse>,
): WebhookRoute {
  return Object.assign((request: WebhookRequest) => fn(request), { methods: [...methods] });
}

/**
 * An unauthenticated `GET` route a part publishes (the Web Bot Auth key directory, I14): public
 * data only, served even behind the container bind's gate.
 */
export type PublicRoute = () => Promise<{
  status: number;
  headers: Record<string, string>;
  body: string;
}>;

export async function servePublic(
  req: IncomingMessage,
  res: ServerResponse,
  route: PublicRoute,
): Promise<void> {
  try {
    const out = await route();
    res.writeHead(out.status, { "x-content-type-options": "nosniff", ...out.headers });
    res.end(req.method === "HEAD" ? undefined : out.body);
  } catch {
    if (!res.headersSent) send(res, 500, JSON.stringify({ ok: false, error: "unavailable" }));
    else res.destroy();
  }
}

/** Webhook bodies past this are refused unread (413). */
export const WEBHOOK_MAX_BYTES = 64 * 1024;

/** Reads a capped body, hands it to the route, writes its answer; failures say nothing more. */
export async function serveWebhook(
  req: IncomingMessage,
  res: ServerResponse,
  route: WebhookRoute,
): Promise<void> {
  const method: WebhookMethod = req.method === "GET" ? "GET" : "POST";
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    // A GET gets no body: nothing is read from the request stream.
    for await (const chunk of method === "GET" ? [] : req) {
      size += (chunk as Buffer).byteLength;
      if (size > WEBHOOK_MAX_BYTES) {
        send(res, 413, JSON.stringify({ ok: false, error: "payload too large" }));
        req.destroy();
        return;
      }
      chunks.push(chunk as Buffer);
    }
    const out = await route({
      method,
      url: req.url ?? "/",
      headers: req.headers,
      body: Buffer.concat(chunks),
    });
    res.writeHead(out.status, { "x-content-type-options": "nosniff", ...out.headers });
    res.end(out.body);
  } catch {
    if (!res.headersSent) send(res, 500, JSON.stringify({ ok: false, error: "webhook failed" }));
    else res.destroy();
  }
}

export function handleHttp(req: IncomingMessage, res: ServerResponse, deps: HttpDeps): void {
  const url = new URL(req.url ?? "/", "http://gateway.invalid");
  if (req.method !== "GET" && req.method !== "HEAD") {
    send(res, 405, JSON.stringify({ ok: false, error: "method not allowed" }));
    return;
  }
  // Bare, unauthenticated health check (security §10 "Docker defaults").
  if (url.pathname === "/healthz") {
    send(res, 200, JSON.stringify({ ok: true }));
    return;
  }
  if (url.pathname === "/version") {
    send(
      res,
      200,
      JSON.stringify({ name: "psyched", version: deps.version, protocolVersion: PROTOCOL_VERSION }),
    );
    return;
  }
  if (url.pathname.startsWith(MAP_PROXY_PREFIX) && deps.mapOrigins !== undefined) {
    void handleMapProxy(req, res, deps.mapOrigins);
    return;
  }
  serveStatic(url.pathname, res, deps.webRoot);
}

function serveStatic(pathname: string, res: ServerResponse, webRoot: string | null): void {
  if (webRoot === null || !existsSync(join(webRoot, "index.html"))) {
    send(
      res,
      404,
      JSON.stringify({ ok: false, error: "web UI not built (pnpm --filter @psyche/web build)" }),
    );
    return;
  }
  const root = resolve(webRoot);
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    send(res, 400, JSON.stringify({ ok: false, error: "bad path" }));
    return;
  }
  const candidate = resolve(root, `.${normalize(decoded)}`);
  if (candidate !== root && !candidate.startsWith(root + sep)) {
    send(res, 403, JSON.stringify({ ok: false, error: "forbidden" }));
    return;
  }
  let file = candidate;
  if (!existsSync(file) || statSync(file).isDirectory()) {
    // SPA fallback: unknown routes render the app shell.
    file = join(root, "index.html");
  }
  const headers = {
    "content-type": MIME[extname(file)] ?? "application/octet-stream",
    "content-security-policy": CSP,
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "cache-control": file.endsWith("index.html") ? "no-store" : "public, max-age=3600",
  };
  const stream = createReadStream(file);
  stream.once("open", () => res.writeHead(200, headers));
  stream.on("error", () => {
    // EACCES or a file removed after the stat: never let a read error crash the Gateway.
    if (!res.headersSent) send(res, 500, JSON.stringify({ ok: false, error: "read failed" }));
    else res.destroy();
  });
  stream.pipe(res);
}
