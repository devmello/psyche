import { sha256 } from "./text.ts";
import type { SourceAdapter, SourceItem, SourcePull } from "./types.ts";

/**
 * Pages the owner's (or the agent's) built-in browser read, as an opt-in search source
 * (docs/design/search-roadmap-2026.md §2 "Browser pages read"). The browser offers a page when
 * `browser.read_text` returns; the adapter keeps it only if the source is on and the page passes
 * `pageItem`, then hands it to the indexer on its next tick. Pages are `untrusted`, so anything
 * built from them stays tainted. Nothing is stored while the source is off.
 */

export interface BrowserPage {
  url: string;
  title?: string;
  text: string;
  /** Epoch ms of the read. */
  readAt: number;
  /** `clean` tabs (logged out) and incognito chats are never indexed. */
  partition: "profile" | "clean";
  incognito?: boolean;
}

/** Pages are kept this long (the roadmap's 90 days), then the sweep removes them. */
export const BROWSER_RETENTION_MS = 90 * 86_400_000;
const MAX_CHARS = 20_000;
const MIN_CHARS = 200;
const QUEUE_MAX = 50;
/** Paths where the page is about signing in, paying or an account's secrets. */
const SENSITIVE_PATH =
  /(?:^|[/_.-])(?:log-?in|sign-?in|sign-?up|log-?out|sign-?out|auth|oauth|sso|password|passwd|reset|checkout|payment|billing|wallet|2fa|mfa|verify|security|session)(?:[/_.-]|$)/i;
const PRIVATE_HOST =
  /^(?:localhost|.*\.local|.*\.localhost|.*\.internal|\[.*\]|\d+\.\d+\.\d+\.\d+)$/i;

/** URL without query and fragment (tokens and tracking ids live there). */
export function pageUrl(raw: string): URL | undefined {
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" && u.protocol !== "http:") return undefined;
    u.search = "";
    u.hash = "";
    u.username = "";
    u.password = "";
    return u;
  } catch {
    return undefined;
  }
}

/** The search item for a page, or undefined when it must not be indexed. */
export function pageItem(page: BrowserPage): SourceItem | undefined {
  if (page.partition === "clean" || page.incognito === true) return undefined;
  const url = pageUrl(page.url);
  if (url === undefined || PRIVATE_HOST.test(url.hostname)) return undefined;
  if (SENSITIVE_PATH.test(url.pathname)) return undefined;
  const text = page.text.replace(/\s+\n/g, "\n").trim().slice(0, MAX_CHARS);
  if (text.length < MIN_CHARS) return undefined;
  const clean = url.toString();
  return {
    nativeId: sha256(clean).slice(0, 24),
    title: (page.title ?? "").trim().slice(0, 200) || url.hostname,
    text: `${clean}\n${text}`,
    from: url.hostname.replace(/^www\./, ""),
    createdAt: page.readAt,
    provenance: "untrusted",
    tags: ["web"],
    mime: "text/html",
  };
}

export interface BrowserSourceDeps {
  /** The owner's switch, read on every offer so a page is dropped, not queued, while it is off. */
  enabled: () => boolean;
}

export function browserAdapter(
  deps: BrowserSourceDeps,
): SourceAdapter & { offer(page: BrowserPage): boolean; readonly queued: number } {
  const queue = new Map<string, SourceItem>();
  return {
    id: "browser",
    retentionMs: BROWSER_RETENTION_MS,
    unavailable: () => undefined,
    get queued() {
      return queue.size;
    },
    offer(page) {
      if (!deps.enabled()) return false;
      const item = pageItem(page);
      if (item === undefined) return false;
      // The same page read again replaces its earlier copy and moves to the back.
      queue.delete(item.nativeId);
      queue.set(item.nativeId, item);
      while (queue.size > QUEUE_MAX) {
        const oldest = queue.keys().next().value;
        if (oldest === undefined) break;
        queue.delete(oldest);
      }
      return true;
    },
    async pull(): Promise<SourcePull> {
      const items = [...queue.values()];
      queue.clear();
      return { items, cursor: null, hasMore: false };
    },
  };
}
