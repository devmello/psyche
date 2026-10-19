import { createReadStream, existsSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { PROTOCOL_VERSION } from "@psyche/protocol";

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
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join("; ");

export interface HttpDeps {
  webRoot: string | null;
  version: string;
}

function send(res: ServerResponse, status: number, body: string, type = "application/json"): void {
  res.writeHead(status, {
    "content-type": type,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(body);
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
