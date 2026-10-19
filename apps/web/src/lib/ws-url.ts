/**
 * The web UI connects only to the origin that served it (security §10, CVE-2026-25253 rules):
 * the builder takes `origin` alone, so `location.search` / `location.hash` can never supply a
 * Gateway address or token.
 */
export function gatewayWsUrl(loc: Pick<Location, "origin">): string {
  const url = new URL("/ws", loc.origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export function healthzUrl(loc: Pick<Location, "origin">): string {
  return new URL("/healthz", loc.origin).toString();
}
