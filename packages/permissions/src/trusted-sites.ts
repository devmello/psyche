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

/** Generic second levels under which unrelated parties register names (`co.uk`, `com.au`). */
const SECOND_LEVEL = new Set([
  "co",
  "com",
  "org",
  "net",
  "gov",
  "edu",
  "ac",
  "or",
  "ne",
  "go",
  "mil",
]);

/** Hosting and platform suffixes where each subdomain belongs to a different party. */
const PRIVATE_SUFFIXES = new Set([
  "github.io",
  "githubusercontent.com",
  "gitlab.io",
  "herokuapp.com",
  "vercel.app",
  "netlify.app",
  "pages.dev",
  "workers.dev",
  "web.app",
  "firebaseapp.com",
  "appspot.com",
  "blogspot.com",
  "wordpress.com",
  "tumblr.com",
  "substack.com",
  "notion.site",
  "amazonaws.com",
  "cloudfront.net",
  "azurewebsites.net",
  "onrender.com",
  "fly.dev",
  "ngrok.io",
  "ngrok-free.app",
  "repl.co",
  "glitch.me",
  "myshopify.com",
  "wixsite.com",
  "weebly.com",
  "webflow.io",
  "surge.sh",
  "duckdns.org",
  "no-ip.org",
  "dyndns.org",
]);

/** True for a host that is a suffix many parties register under (a conservative built-in list). */
export function isPublicSuffixLike(host: string): boolean {
  const labels = host.split(".");
  if (labels.length === 1) return true;
  if (PRIVATE_SUFFIXES.has(host)) return true;
  const last = labels[labels.length - 1] ?? "";
  const prev = labels[labels.length - 2] ?? "";
  // `co.uk`, `com.au`, `gov.uk`: a two-letter country code under a generic second level.
  return labels.length === 2 && last.length === 2 && SECOND_LEVEL.has(prev);
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
  if (o.origin === t.origin) return true;
  if (!site.subdomains) return false;
  return o.scheme === t.scheme && o.port === t.port && o.host.endsWith(`.${t.host}`);
}
