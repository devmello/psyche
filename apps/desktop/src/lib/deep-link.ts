/**
 * `psyche://` deep links (docs/06 §2.7). A link only navigates to an app route; it can never
 * carry a Gateway address, a token or an approval answer (security §10, CVE-2026-25253: any web
 * page can open a deep link). Unknown routes and any query parameter other than `q` on
 * `/search` are rejected.
 */

const ID = "[A-Za-z0-9_-]{1,64}";
const ROUTES: readonly RegExp[] = [
  /^\/chat$/,
  new RegExp(`^/chat/${ID}$`),
  new RegExp(`^/chat/${ID}/pane/${ID}$`),
  /^\/search$/,
  /^\/feed$/,
  /^\/feed\/instructions$/,
  /^\/ideas$/,
  /^\/goals$/,
  /^\/scheduled$/,
  new RegExp(`^/goals/${ID}$`),
  /^\/library\/(documents|images|artifacts|downloads|system)$/,
  /^\/agent\/(activity|approvals|upcoming|soul)$/,
  new RegExp(`^/agent/activity/${ID}$`),
  /^\/settings\/[a-z-]{1,32}$/,
  /^\/inbox$/,
  /^\/quick$/,
];

export function isAppRoute(path: string): boolean {
  return ROUTES.some((r) => r.test(path));
}

/** Returns the app route for a deep link, or null when the link is not acceptable. */
export function parseDeepLink(raw: string): string | null {
  if (raw.length > 2048) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "psyche:" || url.username || url.password || url.port || url.hash)
    return null;
  // psyche://chat/abc parses as host "chat", pathname "/abc".
  const path = `/${url.hostname}${url.pathname === "/" ? "" : url.pathname}`.replace(/\/+$/, "");
  if (!isAppRoute(path)) return null;
  const keys = [...url.searchParams.keys()];
  if (keys.length === 0) return path;
  if (path === "/search" && keys.length === 1 && keys[0] === "q") {
    const q = url.searchParams.get("q") ?? "";
    if (q.length > 500) return null;
    return `/search?q=${encodeURIComponent(q)}`;
  }
  return null;
}

/** macOS passes the URL to `open-url`; other platforms put it in argv of the second instance. */
export function deepLinkFromArgv(argv: readonly string[]): string | null {
  const arg = argv.find((a) => a.startsWith("psyche://"));
  return arg ? parseDeepLink(arg) : null;
}
