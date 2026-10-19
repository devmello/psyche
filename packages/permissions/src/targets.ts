import { posix } from "node:path";
import { domainToASCII } from "node:url";
import { PsycheError } from "@psyche/protocol";

/**
 * Canonical targets (security §3.5, §6). Origins and hosts are compared only in canonical form:
 * lowercased, IDNA → punycode, trailing dot removed, default port stripped, userinfo rejected
 * (CVE-2025-47241), opaque origins rejected (design-13: every non-special scheme has origin
 * `"null"`, so `android://x` would match `foo://y`). Strings that are executed (argv, paths) are
 * never Unicode-normalized.
 */

export class TargetError extends PsycheError {
  constructor(message: string, details?: unknown) {
    super("invalid_params", message, details === undefined ? {} : { details });
    this.name = "TargetError";
  }
}

const WEB_SCHEMES = new Set(["http:", "https:"]);

export interface CanonicalUrl {
  /** `scheme://host[:port]` */
  origin: string;
  scheme: "http" | "https";
  host: string;
  port: number | null;
  pathname: string;
  /** Full URL without fragment. */
  href: string;
}

/** Parse a web URL into canonical parts; throws `TargetError` for anything else. */
export function canonicalUrl(input: string): CanonicalUrl {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new TargetError(`not a URL: ${JSON.stringify(input)}`);
  }
  if (!WEB_SCHEMES.has(url.protocol)) {
    throw new TargetError(`scheme ${url.protocol} has an opaque origin`, { scheme: url.protocol });
  }
  if (url.username !== "" || url.password !== "") throw new TargetError("userinfo in URL");
  let host = url.hostname.toLowerCase();
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (host === "") throw new TargetError("empty host");
  if (!host.startsWith("[")) {
    const ascii = domainToASCII(host);
    if (ascii === "") throw new TargetError(`invalid host ${JSON.stringify(url.hostname)}`);
    host = ascii;
  }
  const scheme = url.protocol === "https:" ? "https" : "http";
  // URL already drops default ports; keep the explicit check for clarity.
  const port = url.port === "" ? null : Number(url.port);
  const portPart = port === null || (scheme === "https" ? port === 443 : port === 80) ? "" : `:${port}`;
  const origin = `${scheme}://${host}${portPart}`;
  const search = url.search;
  return {
    origin,
    scheme,
    host,
    port: portPart === "" ? null : port,
    pathname: url.pathname,
    href: `${origin}${url.pathname}${search}`,
  };
}

export function canonicalOrigin(input: string): string {
  return canonicalUrl(input).origin;
}

/** Canonical host for allowlists and glob rules. */
export function canonicalHost(input: string): string {
  if (input.includes("://")) return canonicalUrl(input).host;
  return canonicalUrl(`https://${input}`).host;
}

const LOOPBACK_NAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Names the localhost exception considers (security §3.10). A name, not proof of an address. */
export function isLoopbackName(host: string): boolean {
  return (
    LOOPBACK_NAMES.has(host) ||
    host.endsWith(".localhost") ||
    host.endsWith(".test") ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
  );
}

/** Literal loopback addresses (`127.0.0.0/8`, `::1`, IPv4-mapped loopback). */
export function isLoopbackAddress(address: string): boolean {
  const a = address.replace(/^\[|\]$/g, "").toLowerCase();
  if (a === "::1" || a === "0:0:0:0:0:0:0:1") return true;
  const v4 = a.startsWith("::ffff:") ? a.slice(7) : a;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4);
}

/**
 * Lowercase addr-spec with a punycode domain (design-11). Display names are discarded, so
 * `"alice@example.org" <attacker@evil.test>` canonicalizes to the attacker's address; a non-ASCII
 * local part (homograph risk) is refused.
 */
export interface CanonicalEmail {
  address: string;
  /** The domain was Unicode and is shown as punycode. */
  idn: boolean;
}

const LOCAL_ATOM = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;

export function canonicalEmail(input: string): CanonicalEmail {
  let raw = input.trim();
  const angle = /<([^<>]*)>\s*$/.exec(raw);
  if (angle?.[1] !== undefined) raw = angle[1].trim();
  if (/[\s<>(),;:"\\[\]]/.test(raw)) throw new TargetError(`not an addr-spec: ${JSON.stringify(input)}`);
  const at = raw.lastIndexOf("@");
  if (at <= 0 || at === raw.length - 1) throw new TargetError(`not an addr-spec: ${JSON.stringify(input)}`);
  const local = raw.slice(0, at);
  const domain = raw.slice(at + 1);
  if (!LOCAL_ATOM.test(local)) {
    throw new TargetError(`local part is not ASCII dot-atom: ${JSON.stringify(input)}`, {
      reason: "mixed_script",
    });
  }
  const ascii = domainToASCII(domain.toLowerCase());
  if (ascii === "" || !ascii.includes(".")) throw new TargetError(`invalid domain in ${JSON.stringify(input)}`);
  return {
    address: `${local.toLowerCase()}@${ascii}`,
    idn: ascii !== domain.toLowerCase(),
  };
}

/** Lexically normalized absolute POSIX path; the executor supplies the real path (realpath). */
export function canonicalPath(input: string): string {
  if (!input.startsWith("/")) throw new TargetError(`path is not absolute: ${JSON.stringify(input)}`);
  if (input.includes("\0")) throw new TargetError("NUL in path");
  const p = posix.normalize(input);
  return p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p;
}

/** `child` equals `root` or lies under it, by whole segments. */
export function isUnder(child: string, root: string): boolean {
  if (root === "/") return child.startsWith("/");
  return child === root || child.startsWith(`${root}/`);
}

export function isDangerousLookalike(host: string): boolean {
  return host.split(".").some((label) => label.startsWith("xn--"));
}
