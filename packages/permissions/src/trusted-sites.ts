import { venueOfHost } from "@psyche/protocol/financial-block";
import { getPublicSuffix, parse } from "tldts";
import { canonicalUrl, isLoopbackName } from "./targets.ts";

/**
 * Trusted sites (security §3.2): origins the owner said "Always for this site" to on a first-read
 * card. A trusted origin's READS (navigate, snapshot, read page text, GET fetch) run without a
 * card in Balanced mode, in any task. Everything else about the site follows the usual rules.
 *
 * An entry is a standing grant with its own grant key (`grantKeyHash("trusted_site", ...)`), so no
 * ordinary call can ever match it: only `PolicyEngine`'s read path asks the broker about it.
 */

/** The tools whose READS a trusted site covers. A write, submit or download is never in this set. */
export const TRUSTED_SITE_READ_TOOLS =
  /^(browser\.(navigate|open|open_tab|new_tab|goto|snapshot|read_text|screenshot)|web[._]fetch)$/;

/** What a trusted entry covers. */
export interface TrustedSite {
  /** Canonical `scheme://host[:port]` the owner trusted. */
  origin: string;
  /** Also every subdomain on the same scheme and port ("this site and its subdomains"). */
  subdomains: boolean;
}

export type TrustedSiteRefusal =
  | "not_web"
  | "ip_literal"
  | "loopback"
  | "public_suffix"
  | "single_label";

export class TrustedSiteError extends Error {
  readonly reason: TrustedSiteRefusal;
  constructor(reason: TrustedSiteRefusal, message: string) {
    super(message);
    this.name = "TrustedSiteError";
    this.reason = reason;
  }
}

/** Multi-tenant platforms the list does not carry as suffixes (checked on top of it). */
const EXTRA_SUFFIXES = new Set([
  "run.app",
  "deno.dev",
  "up.railway.app",
  "replit.app",
  "gitbook.io",
  "translate.goog",
  "dweb.link",
]);

/**
 * True for a host that is itself a public suffix, in the ICANN or the private section of the list
 * (`co.uk`, `github.io`, `s3.amazonaws.com`, `run.app`, `kyoto.jp`), or whose suffix cannot be
 * determined. Fails closed: a lookup that throws or returns nothing counts as a suffix.
 */
export function isPublicSuffixLike(host: string): boolean {
  if (!host.includes(".")) return true;
  try {
    const suffix = getPublicSuffix(host, { allowPrivateDomains: true });
    return suffix === null || suffix === undefined || suffix === host || EXTRA_SUFFIXES.has(host);
  } catch {
    return true;
  }
}

/** Hosts whose tenants share one origin and differ by path: exact hosts only. */
const SHARED_PATH_HOSTS = new Set([
  "storage.googleapis.com",
  "raw.githubusercontent.com",
  "gist.githubusercontent.com",
]);

/**
 * Hosts that serve many parties' (or the owner's private) content, with everything under them:
 * Google Docs, Drive, Sites and Apps Script web apps, user-content hosts.
 */
const SHARED_TENANT_TREES = [
  "docs.google.com",
  "drive.google.com",
  "sites.google.com",
  "script.google.com",
  "pay.google.com",
  "wallet.google.com",
  "script.googleusercontent.com",
  "googleusercontent.com",
];

/** Path-style S3 endpoints (`s3.amazonaws.com`, `s3.us-east-1.amazonaws.com`, `s3-eu-west-1...`). */
const S3_PATH_STYLE = /^s3[.-]([a-z0-9-]+\.)*amazonaws\.com(\.cn)?$/;

const underOrEqual = (host: string, base: string) => host === base || host.endsWith(`.${base}`);

/** No trust offer at all on these: trust there would cover every tenant. */
export function isSharedTenantHost(host: string): boolean {
  return (
    SHARED_PATH_HOSTS.has(host) ||
    S3_PATH_STYLE.test(host) ||
    SHARED_TENANT_TREES.some((b) => underOrEqual(host, b))
  );
}

/** Request catchers, tunnels and paste or gateway hosts: a quiet read there is an exfil channel. */
const COLLECTORS = [
  "webhook.site",
  "requestbin.com",
  "pipedream.net",
  "ngrok.io",
  "ngrok.app",
  "ngrok.dev",
  "ngrok-free.app",
  "ngrok-free.dev",
  "pastebin.com",
  "ipfs.io",
  "interact.sh",
  "oast.pro",
  "oast.live",
  "oast.site",
  "oast.online",
  "oast.fun",
  "oast.me",
  "burpcollaborator.net",
  "canarytokens.com",
  "requestcatcher.com",
  "beeceptor.com",
  "requestrepo.com",
  "postb.in",
  "transfer.sh",
  "paste.ee",
  "hastebin.com",
];

/**
 * Multi-tenant apexes the Public Suffix List misses: the exact origin may be trusted, but never
 * "and its subdomains", because every subdomain is a different party's site.
 */
const NO_SUBDOMAIN_APEXES = new Set([
  "wordpress.com",
  "tumblr.com",
  "substack.com",
  "medium.com",
  "sharepoint.com",
  "zendesk.com",
  "atlassian.net",
  "itch.io",
  "blogger.com",
  "notion.site",
  "webflow.io",
  "wixsite.com",
  "squarespace.com",
  "myshopify.com",
  "glitch.me",
  "replit.app",
  "repl.co",
]);

/** A host no quiet read may cover, however the entry was made (checked on every match). */
function hostRefused(host: string): boolean {
  return (
    isPublicSuffixLike(host) ||
    isSharedTenantHost(host) ||
    isCollectorHost(host) ||
    isUnknownSuffix(host) ||
    venueOfHost(host) !== undefined
  );
}

export function isCollectorHost(host: string): boolean {
  return COLLECTORS.some((b) => underOrEqual(host, b));
}

/** A name under no ICANN or private suffix (`router.local`, `.lan`, `.internal`, `home.arpa`). */
function isUnknownSuffix(host: string): boolean {
  // `arpa` is an ICANN suffix, but `home.arpa` and reverse-DNS names are local, never a site.
  if (/(^|\.)arpa$/.test(host)) return true;
  try {
    const r = parse(host, { allowPrivateDomains: true });
    return r.isIcann !== true && r.isPrivate !== true;
  } catch {
    return true;
  }
}

function isIpLiteral(host: string): boolean {
  if (host.startsWith("[") || host.includes(":")) return true;
  // WHATWG URL parsing already turns 0x7f.1 / 2130706433 into dotted decimal.
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

/**
 * The canonical trusted entry for what the owner picked. Origins are exact (scheme, host, port),
 * lowercased, IDN folded to punycode with the trailing dot removed (`canonicalUrl`). Refuses IP
 * literals, `localhost` and other loopback names, bare host names and shared suffixes. With the
 * subdomain choice the same rules apply, so a public suffix is never wildcarded. Throws
 * `TrustedSiteError`.
 */
export function normalizeTrustedSite(input: string, subdomains = false): TrustedSite {
  let u: ReturnType<typeof canonicalUrl>;
  try {
    u = canonicalUrl(input);
  } catch {
    throw new TrustedSiteError("not_web", "only http and https sites can be trusted");
  }
  if (isIpLiteral(u.host)) throw new TrustedSiteError("ip_literal", "an IP address is not a site");
  if (isLoopbackName(u.host)) {
    throw new TrustedSiteError("loopback", "this computer's own addresses are not trusted sites");
  }
  if (!u.host.includes("."))
    throw new TrustedSiteError("single_label", "a bare host name is not a site");
  if (isUnknownSuffix(u.host)) {
    throw new TrustedSiteError("public_suffix", "this name is not on the public internet");
  }
  if (subdomains && NO_SUBDOMAIN_APEXES.has(u.host)) {
    throw new TrustedSiteError("public_suffix", "every subdomain here belongs to someone else");
  }
  if (isCollectorHost(u.host) || isSharedTenantHost(u.host) || venueOfHost(u.host) !== undefined) {
    throw new TrustedSiteError("public_suffix", "this host serves many parties' content");
  }
  if (isPublicSuffixLike(u.host)) {
    throw new TrustedSiteError("public_suffix", "a shared suffix cannot be trusted");
  }
  return { origin: u.origin, subdomains };
}

/**
 * Whether the trusted entry covers `origin`. Exact origin match; with `subdomains`, a strictly
 * deeper host under the entry's host with the same scheme and port. Never a suffix string match
 * (`evilexample.com` is not under `example.com`), never across ports or schemes.
 */
export function trustedSiteCovers(site: TrustedSite, origin: string): boolean {
  let o: ReturnType<typeof canonicalUrl>;
  let t: ReturnType<typeof canonicalUrl>;
  try {
    o = canonicalUrl(origin);
    t = canonicalUrl(site.origin);
  } catch {
    return false;
  }
  if (isIpLiteral(o.host) || isLoopbackName(o.host)) return false;
  // Entries made before a list update stop working: the same refusals apply to an exact match.
  if (hostRefused(o.host)) return false;
  if (o.origin === t.origin) return true;
  if (!site.subdomains || NO_SUBDOMAIN_APEXES.has(t.host)) return false;
  if (o.scheme !== t.scheme || o.port !== t.port || !o.host.endsWith(`.${t.host}`)) return false;
  // The host being read is checked too, not only the trusted one: a subdomain that is a different
  // party's (a private suffix such as `s3.amazonaws.com`), a shared-tenant or collector host or a
  // venue is never covered by a parent's subdomain trust.
  return (
    getPublicSuffix(o.host, { allowPrivateDomains: true }) ===
      getPublicSuffix(t.host, { allowPrivateDomains: true }) && !hostRefused(o.host)
  );
}
