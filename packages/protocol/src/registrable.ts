/**
 * Registrable domain (eTLD+1) of a host, without a public-suffix list: `canvas.ucsc.edu` and
 * `login.ucsc.edu` are both `ucsc.edu`. Country-code second-level suffixes (`co.uk`, `com.au`)
 * are covered by a short table; an unknown suffix falls back to the last two labels, which is
 * right for the common cases and errs toward treating hosts as the same site only when they share
 * their last two labels. IP addresses and single-label hosts are returned as they are.
 */

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
  "gob",
  "mil",
]);

const TWO_PART_SUFFIX_TLDS = new Set([
  "uk",
  "au",
  "nz",
  "jp",
  "kr",
  "br",
  "cn",
  "hk",
  "in",
  "il",
  "mx",
  "ar",
  "tr",
  "za",
  "sg",
  "tw",
  "ru",
  "ua",
  "pl",
]);

export function registrableDomain(host: string): string {
  const h = host.trim().toLowerCase().replace(/^\./, "").replace(/\.$/, "");
  if (h === "" || /^[\d.]+$/.test(h) || h.includes(":")) return h;
  const labels = h.split(".");
  if (labels.length <= 2) return h;
  const tld = labels[labels.length - 1] as string;
  const sld = labels[labels.length - 2] as string;
  const keep = TWO_PART_SUFFIX_TLDS.has(tld) && SECOND_LEVEL.has(sld) ? 3 : 2;
  return labels.slice(-keep).join(".");
}

/** True when both hosts belong to the same registrable domain. */
export function sameSite(a: string, b: string): boolean {
  return registrableDomain(a) === registrableDomain(b);
}
