/**
 * Settings → Browser "agent browsing": which sign-ins the agent's browser uses, the sites it may
 * use them on, and the loopback dev-preview ports it may open. Shared by the Gateway (validation
 * before a value is stored) and the desktop UI (client-side hints), so both refuse the same things.
 */

export const BROWSER_PARTITION_KEY = "browser.partition";
export const BROWSER_SIGNED_IN_ORIGINS_KEY = "browser.signedInOrigins";
export const BROWSER_DEV_PREVIEW_PORTS_KEY = "browser.devPreviewPorts";

/** The environment variables that override the settings (development). */
export const BROWSER_PARTITION_ENV = "PSYCHE_BROWSER_PARTITION";
export const BROWSER_SIGNED_IN_ORIGINS_ENV = "PSYCHE_BROWSER_SIGNED_IN_ORIGINS";
export const BROWSER_DEV_PREVIEW_PORTS_ENV = "PSYCHE_DEV_PREVIEW_PORTS";

/**
 * `clean`: every tab logged out. `auto` (the default): logged out, except the sites listed as
 * signed in. `profile`: every tab uses the agent profile's sign-ins.
 */
export const BROWSER_PARTITIONS = ["clean", "auto", "profile"] as const;
export type BrowserPartitionMode = (typeof BROWSER_PARTITIONS)[number];
export const DEFAULT_BROWSER_PARTITION: BrowserPartitionMode = "auto";

/** Why an origin was refused; the UI names the reason in its own words. */
export type OriginRefusal =
  | "empty"
  | "not_text"
  | "wildcard"
  | "not_url"
  | "credentials"
  | "path"
  | "scheme"
  | "port";

export type OriginResult = { ok: true; origin: string } | { ok: false; reason: OriginRefusal };

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Normalises an origin to `scheme://host[:port]`. https only; http only for loopback. A
 * wildcard, a path (a trailing `/` is fine), a query, a fragment, userinfo, or a port outside
 * 1 to 65535 is refused.
 */
export function normalizeBrowserOrigin(raw: unknown): OriginResult {
  if (typeof raw !== "string") return { ok: false, reason: "not_text" };
  const text = raw.trim();
  if (text === "") return { ok: false, reason: "empty" };
  if (text.includes("*")) return { ok: false, reason: "wildcard" };
  const anyScheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(text);
  if (anyScheme !== null && !/^https?$/i.test(anyScheme[1] ?? "")) {
    return { ok: false, reason: "scheme" };
  }
  const match = /^(https?):\/\/([^/?#]*)(.*)$/i.exec(text);
  if (match === null) return { ok: false, reason: "not_url" };
  const [, scheme = "", authority = "", rest = ""] = match;
  if (authority.includes("@")) return { ok: false, reason: "credentials" };
  if (rest !== "" && rest !== "/") return { ok: false, reason: "path" };
  const portMatch = /:(\d*)$/.exec(authority);
  if (portMatch !== null && portMatch[1] !== undefined && portMatch[1] !== "") {
    const port = Number(portMatch[1]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, reason: "port" };
  }
  let url: URL;
  try {
    url = new URL(`${scheme.toLowerCase()}://${authority}`);
  } catch {
    return { ok: false, reason: "not_url" };
  }
  if (url.hostname === "") return { ok: false, reason: "not_url" };
  const protocol = url.protocol;
  if (protocol === "http:") {
    if (!LOOPBACK_HOSTS.has(url.hostname)) return { ok: false, reason: "scheme" };
  } else if (protocol !== "https:") {
    return { ok: false, reason: "scheme" };
  }
  return { ok: true, origin: `${protocol}//${url.host}` };
}

export type PortResult = { ok: true; port: number } | { ok: false };

/** A dev-preview port: an integer from 1 to 65535. */
export function normalizeDevPreviewPort(raw: unknown): PortResult {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > 65535) {
    return { ok: false };
  }
  return { ok: true, port: raw };
}

/** A partition mode from text, or undefined when it is not one of the three. */
export function parseBrowserPartition(raw: unknown): BrowserPartitionMode | undefined {
  return typeof raw === "string" && (BROWSER_PARTITIONS as readonly string[]).includes(raw)
    ? (raw as BrowserPartitionMode)
    : undefined;
}

/** How much sign-in reach a mode grants: a higher number is wider. */
export const BROWSER_PARTITION_WIDTH: Record<BrowserPartitionMode, number> = {
  clean: 0,
  auto: 1,
  profile: 2,
};
