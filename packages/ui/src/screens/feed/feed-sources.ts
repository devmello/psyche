/**
 * The Feed's sources as the Gateway stores them in the `feed.sources` setting:
 * `{ rss?: string[], hackerNews?: boolean, arxiv?: boolean }` (compose/proactive.ts). Hacker News
 * and arXiv are read unless the setting turns them off; only http(s) addresses in `rss` are read.
 * The sheet edits these three fields and keeps any other key the owner set from the CLI.
 */
export const FEED_SOURCES_KEY = "feed.sources";

export interface FeedSources {
  /** RSS or Atom addresses, in the order the owner added them. */
  rss: string[];
  hackerNews: boolean;
  arxiv: boolean;
}

/** Reads the setting the way the Gateway does: Hacker News and arXiv default to on. */
export function readFeedSources(value: unknown): FeedSources {
  const v =
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const rss = Array.isArray(v.rss) ? v.rss.filter((u): u is string => typeof u === "string") : [];
  return { rss, hackerNews: v.hackerNews !== false, arxiv: v.arxiv !== false };
}

/** The setting value to write: the sheet's three fields over whatever else is stored. */
export function writeFeedSources(current: unknown, next: FeedSources): Record<string, unknown> {
  const base =
    current !== null && typeof current === "object" && !Array.isArray(current)
      ? (current as Record<string, unknown>)
      : {};
  return { ...base, rss: next.rss, hackerNews: next.hackerNews, arxiv: next.arxiv };
}

/** The Gateway reads only addresses that start with http:// or https://. */
export function isWebAddress(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

/** The host to show a person, e.g. `example.com`; the address itself when it does not parse. */
export function hostLabel(url: string): string {
  const host = URL.canParse(url) ? new URL(url).host : "";
  return host === "" ? url : host;
}

export type FeedAddressProblem = "empty" | "invalid" | "scheme" | "duplicate";

export type FeedAddressCheck =
  | { ok: true; url: string }
  | { ok: false; problem: FeedAddressProblem };

function sameAddress(a: string, b: string): boolean {
  const ha = URL.canParse(a) ? new URL(a).href : a;
  const hb = URL.canParse(b) ? new URL(b).href : b;
  return ha === hb;
}

/**
 * Checks an address typed for a feed, the way the Gateway will read it: trimmed, parseable, http
 * or https only, and not already in the list. `editing` is the index being changed, so an edit
 * that keeps its own address is not a duplicate.
 */
export function checkFeedAddress(
  input: string,
  rss: readonly string[],
  editing?: number,
): FeedAddressCheck {
  const url = input.trim();
  if (url === "") return { ok: false, problem: "empty" };
  if (!URL.canParse(url)) return { ok: false, problem: "invalid" };
  const protocol = new URL(url).protocol;
  if (protocol !== "http:" && protocol !== "https:") return { ok: false, problem: "scheme" };
  const clash = rss.some((stored, i) => i !== editing && sameAddress(stored, url));
  if (clash) return { ok: false, problem: "duplicate" };
  return { ok: true, url };
}
