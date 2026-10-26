import type { IncomingMessage, ServerResponse } from "node:http";
import { isIP } from "node:net";

/**
 * The map tile proxy (`GET /maps/o/<base64url origin>/<path>`). The web UI's CSP lets the page talk
 * only to its own origin, so MapLibre's requests (style, tiles, glyphs, sprites) are rewritten to
 * this route by `transformRequest`. It forwards to one of the owner's configured tile origins and
 * nothing else: the default OpenFreeMap host or the origins of `ui.map.styleUrl` and
 * `ui.map.styleUrlDark`. It sends no cookies, credentials or referrer, so the tile host sees the
 * Gateway, not the viewer. Responses are size- and time-limited and typed (no HTML), and tile
 * responses are cacheable.
 */

export const DEFAULT_TILE_ORIGIN = "https://tiles.openfreemap.org";
export const MAP_PROXY_PREFIX = "/maps/o/";
const MAX_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 10_000;
const MAX_INFLIGHT = 16;
const MAX_REDIRECTS = 3;
const DEFAULT_MAX_AGE = 86_400;
const TYPES =
  /^(application\/(json|x-protobuf|vnd\.mapbox-vector-tile|octet-stream|gzip)|image\/(png|jpeg|webp|avif|gif)|font\/|text\/plain)/i;

let inflight = 0;

const b64url = (s: string): string => Buffer.from(s, "utf8").toString("base64url");

/** The `base64url(origin)` path segment the client uses. */
export const proxySegment = b64url;

/** The origin of a configured style URL if it is a URL we may fetch; null otherwise. */
export function originOf(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return blocked(u.hostname) ? null : u.origin;
  } catch {
    return null;
  }
}

/** Link-local and metadata addresses are never fetched (a private LAN tile server still is). */
function blocked(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "metadata.google.internal") return true;
  if (isIP(h) === 4) return h.startsWith("169.254.") || h === "0.0.0.0";
  if (isIP(h) === 6) return h.startsWith("fe80:") || h === "::" || h.includes("fd00:ec2");
  return false;
}

/** Origins the proxy may reach, from the current settings (`get` reads a setting value). */
export function allowedMapOrigins(get: (key: string) => unknown): string[] {
  const out = new Set<string>([DEFAULT_TILE_ORIGIN]);
  for (const key of ["ui.map.styleUrl", "ui.map.styleUrlDark"]) {
    const o = originOf(get(key));
    if (o !== null) out.add(o);
  }
  return [...out];
}

const fail = (res: ServerResponse, status: number, msg: string): void => {
  res.writeHead(status, { "content-type": "text/plain", "cache-control": "no-store" });
  res.end(msg);
};

/** Handles a `/maps/o/...` request. `allowed` is evaluated per request so settings changes apply. */
export async function handleMapProxy(
  req: IncomingMessage,
  res: ServerResponse,
  allowed: () => string[],
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://gateway.invalid");
  const rest = url.pathname.slice(MAP_PROXY_PREFIX.length);
  const slash = rest.indexOf("/");
  const seg = slash === -1 ? rest : rest.slice(0, slash);
  let origin: string;
  try {
    origin = Buffer.from(seg, "base64url").toString("utf8");
  } catch {
    return fail(res, 400, "bad origin");
  }
  // Exact match against the configured origins: no open proxy.
  if (!allowed().includes(origin)) return fail(res, 403, "origin not allowed");
  if (inflight >= MAX_INFLIGHT) return fail(res, 503, "busy");
  const path = slash === -1 ? "/" : rest.slice(slash);
  inflight++;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  req.once("close", () => ctl.abort());
  try {
    let target = `${origin}${path}${url.search}`;
    let up: Response | null = null;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      up = await fetchImpl(target, {
        method: "GET",
        redirect: "manual",
        signal: ctl.signal,
        credentials: "omit",
        referrerPolicy: "no-referrer",
        headers: { accept: "*/*", "user-agent": "psyche-gateway" },
      });
      if (up.status < 300 || up.status >= 400) break;
      const next = up.headers.get("location");
      if (next === null) break;
      const resolved = new URL(next, target);
      // A redirect may only stay on an allowed origin.
      if (!allowed().includes(resolved.origin)) return fail(res, 502, "redirect not allowed");
      target = resolved.href;
    }
    if (up === null || !up.ok || up.body === null)
      return fail(res, up?.status === 404 ? 404 : 502, "upstream error");
    const type = up.headers.get("content-type") ?? "";
    if (!TYPES.test(type)) return fail(res, 502, "unsupported content type");
    const declared = Number(up.headers.get("content-length") ?? 0);
    if (declared > MAX_BYTES) return fail(res, 502, "too large");
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of up.body as unknown as AsyncIterable<Uint8Array>) {
      size += chunk.byteLength;
      if (size > MAX_BYTES) {
        ctl.abort();
        return fail(res, 502, "too large");
      }
      chunks.push(chunk);
    }
    const headers: Record<string, string> = {
      "content-type": type,
      "x-content-type-options": "nosniff",
      "cache-control": up.headers.get("cache-control") ?? `public, max-age=${DEFAULT_MAX_AGE}`,
    };
    for (const h of ["etag", "last-modified", "content-encoding"]) {
      const v = up.headers.get(h);
      if (v !== null) headers[h] = v;
    }
    res.writeHead(200, headers);
    res.end(Buffer.concat(chunks));
  } catch {
    if (!res.headersSent) fail(res, 502, "upstream failed");
    else res.destroy();
  } finally {
    clearTimeout(timer);
    inflight--;
  }
}
