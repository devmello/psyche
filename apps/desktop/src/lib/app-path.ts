import { extname, normalize, resolve, sep } from "node:path";

/**
 * Maps an `app://psyche/<path>` request onto the built renderer directory. The renderer leaves
 * `file://` (security §12): a custom standard scheme gets its own origin, so the
 * `GrantFileProtocolExtraPrivileges` fuse can be off. Paths that escape the root are refused;
 * extensionless paths are app routes and get `index.html` (client-side routing, docs/06 §2.7).
 */
export const APP_SCHEME = "app";
export const APP_HOST = "psyche";
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;

export function resolveAppPath(root: string, requestUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return null;
  }
  if (url.protocol !== `${APP_SCHEME}:` || url.host !== APP_HOST) return null;
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  if (pathname.includes("\0")) return null;
  const rel = extname(pathname) === "" ? "index.html" : pathname.replace(/^\/+/, "");
  const base = resolve(root);
  const full = resolve(base, normalize(rel));
  if (full !== base && !full.startsWith(base + sep)) return null;
  return full;
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
  ".map": "application/json",
};

export function contentType(path: string): string {
  return TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}

/**
 * True when `url` belongs to the app renderer at `rendererUrl` (app://psyche, or the Vite dev
 * server). Compares scheme and host: `URL.origin` is "null" for custom schemes, which would
 * make file:, data: and about: URLs look like the app.
 */
export function isSameApp(url: string | undefined, rendererUrl: string): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    const r = new URL(rendererUrl);
    return (
      u.protocol === r.protocol && u.host === r.host && u.host !== "" && !u.username && !u.password
    );
  } catch {
    return false;
  }
}
