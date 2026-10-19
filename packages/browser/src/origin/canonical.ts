import { PsycheError } from "@psyche/protocol";

/**
 * Canonical hosts and origins (security §6 "Allowlists"). Every origin comparison in the browser
 * subsystem goes through `canonicalizeUrl`: lowercased, IDNA (punycode) normalized, trailing dot
 * removed, default ports stripped, userinfo rejected (the browser-use bypass, CVE-2025-47241),
 * numeric IPv4 forms (`0x7f.1`, `2130706433`) folded by the WHATWG parser, and only http(s).
 */

export type HostKind = "domain" | "ipv4" | "ipv6";

export interface CanonicalUrl {
  /** `scheme://host[:port]`, no trailing slash, default ports stripped. */
  origin: string;
  scheme: "http" | "https";
  /** Lowercase ASCII host without a trailing dot; IPv6 without brackets. */
  host: string;
  /** Explicit port, or the scheme's default. */
  port: number;
  hostKind: HostKind;
  /** Full URL with the canonical host (fragment kept). */
  href: string;
  pathname: string;
}

/** Schemes the agent may never navigate to (architecture §8; security §6). */
export const BLOCKED_SCHEMES = [
  "about:",
  "chrome:",
  "chrome-extension:",
  "chrome-untrusted:",
  "devtools:",
  "file:",
  "javascript:",
  "data:",
  "blob:",
  "view-source:",
  "filesystem:",
  "ws:",
  "wss:",
  "ftp:",
] as const;

const DEFAULT_PORT = { http: 80, https: 443 } as const;

function invalid(message: string, details?: Record<string, unknown>): never {
  throw new PsycheError("policy_denied", message, details === undefined ? {} : { details });
}

/** The scheme of a raw URL string, lowercased with its colon, or undefined if it has none. */
export function schemeOf(raw: string): string | undefined {
  const m = /^\s*([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(raw);
  return m?.[1] === undefined ? undefined : `${m[1].toLowerCase()}:`;
}

/**
 * Parse and canonicalize an absolute http(s) URL. Throws `PsycheError("policy_denied")` with
 * `details.reason` for blocked schemes, userinfo, unparsable input and empty hosts.
 */
export function canonicalizeUrl(raw: string): CanonicalUrl {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 8192) {
    invalid("URL is empty or too long", { reason: "invalid_url" });
  }
  // Control characters and whitespace inside a URL are a smuggling vector; the WHATWG parser
  // strips some of them silently, so refuse them before it sees the string.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
  if (/[\u0000-\u001f\u007f\s]/.test(raw.trim()) || raw !== raw.trim()) {
    invalid("URL contains whitespace or control characters", { reason: "invalid_url" });
  }
  const scheme = schemeOf(raw);
  if (scheme === undefined) invalid("URL must be absolute", { reason: "invalid_url" });
  if ((BLOCKED_SCHEMES as readonly string[]).includes(scheme)) {
    invalid(`scheme ${scheme} is blocked`, { reason: "blocked_scheme", scheme });
  }
  if (scheme !== "http:" && scheme !== "https:") {
    invalid(`scheme ${scheme} is not allowed`, { reason: "blocked_scheme", scheme });
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return invalid("URL does not parse", { reason: "invalid_url" });
  }
  if (url.username !== "" || url.password !== "") {
    invalid("URLs with userinfo are rejected", { reason: "userinfo" });
  }
  let host = url.hostname;
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (host === "" || host.includes("..")) invalid("URL has no host", { reason: "invalid_url" });
  let hostKind: HostKind = "domain";
  if (host.startsWith("[") && host.endsWith("]")) {
    host = host.slice(1, -1);
    hostKind = "ipv6";
  } else if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    hostKind = "ipv4";
  }
  const s = scheme === "https:" ? "https" : "http";
  const port = url.port === "" ? DEFAULT_PORT[s] : Number(url.port);
  const hostPart = hostKind === "ipv6" ? `[${host}]` : host;
  const origin = port === DEFAULT_PORT[s] ? `${s}://${hostPart}` : `${s}://${hostPart}:${port}`;
  url.hostname = hostPart;
  return {
    origin,
    scheme: s,
    host,
    port,
    hostKind,
    href: url.href,
    pathname: url.pathname,
  };
}

/** `canonicalizeUrl(raw).origin`, or undefined for anything that is not a canonical http(s) URL. */
export function tryOrigin(raw: string): string | undefined {
  try {
    return canonicalizeUrl(raw).origin;
  } catch {
    return undefined;
  }
}

function ipv4Octets(host: string): number[] | undefined {
  const parts = host.split(".").map(Number);
  return parts.length === 4 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)
    ? parts
    : undefined;
}

function isPrivateIpv4(host: string): { loopback: boolean; private: boolean } {
  const o = ipv4Octets(host);
  if (o === undefined) return { loopback: false, private: false };
  const [a = 0, b = 0] = o;
  const loopback = a === 127;
  const priv =
    loopback ||
    a === 0 ||
    a === 10 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) || // link-local (cloud metadata lives here)
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    a >= 224; // multicast and reserved
  return { loopback, private: priv };
}

function isPrivateIpv6(host: string): { loopback: boolean; private: boolean } {
  const h = host.toLowerCase();
  if (h === "::1") return { loopback: true, private: true };
  if (h === "::") return { loopback: false, private: true };
  // IPv4-mapped (`::ffff:7f00:1`, as the WHATWG parser prints it).
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
  if (mapped !== null) {
    const hi = Number.parseInt(mapped[1] ?? "0", 16);
    const lo = Number.parseInt(mapped[2] ?? "0", 16);
    return isPrivateIpv4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  const first = Number.parseInt(h.split(":")[0] || "0", 16);
  const priv =
    (first & 0xfe00) === 0xfc00 || // fc00::/7 unique local
    (first & 0xffc0) === 0xfe80 || // fe80::/10 link-local
    (first & 0xff00) === 0xff00; // multicast
  return { loopback: false, private: priv };
}

const PRIVATE_SUFFIXES = [".local", ".internal", ".lan", ".home.arpa", ".intranet", ".corp"];

export interface NetworkClass {
  /** `localhost`, `*.localhost`, 127/8 or ::1. */
  loopback: boolean;
  /** Loopback, RFC 1918, link-local, CGNAT, ULA, single-label and private-use names. */
  private: boolean;
}

/**
 * Classify a canonical host. Hostnames are judged by name only; DNS answers pointing a public
 * name at a private address (rebinding) are the desktop's / proxy's job, not this function's.
 */
export function classifyHost(host: string, kind: HostKind): NetworkClass {
  if (kind === "ipv4") return isPrivateIpv4(host);
  if (kind === "ipv6") return isPrivateIpv6(host);
  if (host === "localhost" || host.endsWith(".localhost")) return { loopback: true, private: true };
  const singleLabel = !host.includes(".");
  const priv = singleLabel || PRIVATE_SUFFIXES.some((s) => host.endsWith(s));
  return { loopback: false, private: priv };
}

/**
 * An origin pattern from a task's origin set or a user rule: `https://example.com`,
 * `https://*.example.com` (subdomains only; never the bare domain), `example.com` (https only),
 * `http://localhost:5173`. Ports default to the scheme's default.
 */
export interface OriginPattern {
  scheme: "http" | "https";
  host: string;
  /** `*.` prefix: matches strict subdomains of `host`. */
  subdomains: boolean;
  port: number;
  /** Normalized source text, for display and dedup. */
  text: string;
}

export function parseOriginPattern(raw: string): OriginPattern {
  const trimmed = raw.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const wildcard = /^(https?:\/\/)\*\.(.+)$/i.exec(withScheme);
  const probe = wildcard === null ? withScheme : `${wildcard[1]}${wildcard[2]}`;
  const c = canonicalizeUrl(probe);
  if (c.pathname !== "/" && c.pathname !== "") {
    invalid(`origin pattern ${raw} must not have a path`, { reason: "invalid_pattern" });
  }
  if (wildcard !== null && c.hostKind !== "domain") {
    invalid(`wildcard pattern ${raw} needs a domain`, { reason: "invalid_pattern" });
  }
  const subdomains = wildcard !== null;
  const hostPart = c.hostKind === "ipv6" ? `[${c.host}]` : c.host;
  const portPart = c.port === DEFAULT_PORT[c.scheme] ? "" : `:${c.port}`;
  return {
    scheme: c.scheme,
    host: c.host,
    subdomains,
    port: c.port,
    text: `${c.scheme}://${subdomains ? "*." : ""}${hostPart}${portPart}`,
  };
}

export function matchesPattern(url: CanonicalUrl, pattern: OriginPattern): boolean {
  if (url.scheme !== pattern.scheme || url.port !== pattern.port) return false;
  if (!pattern.subdomains) return url.host === pattern.host;
  return url.hostKind === "domain" && url.host.endsWith(`.${pattern.host}`);
}
