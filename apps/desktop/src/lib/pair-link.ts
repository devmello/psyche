import { parsePairingLinkAny } from "@psyche/protocol";

/**
 * `psyche-pair:` links handed to the app by the OS (remote-gateway design §3.2, §3.4). Pairing
 * links are pasted into the app's own field; opening one from outside is only a shortcut to that
 * field. The inbox:
 *
 * - accepts a link only if it parses as a strict `psyche-pair:v1` or `psyche-pair:v2` link (a malformed or oversized
 *   URL opens nothing);
 * - keeps it in memory, once, and asks for exactly two things: to show Settings → Server & remote
 *   access, and to tell an open Settings window that a link is waiting. It never adds a Gateway,
 *   never connects, and never reads a field of the link. The Settings window asks for the link
 *   (`take`), shows it in the Add a Gateway field, and adding still needs the owner to press Add,
 *   after which main names the normalized address in a native dialog (CVE-2026-25253: any web
 *   page can open a custom-scheme URL).
 */

export const PAIR_LINK_SCHEME = "psyche-pair";

export function isPairLinkUrl(raw: string): boolean {
  return raw.trim().toLowerCase().startsWith(`${PAIR_LINK_SCHEME}:`);
}

/** The link text when `raw` is a valid pairing link, else null. */
export function pairLinkFromUrl(raw: string): string | null {
  if (!isPairLinkUrl(raw)) return null;
  try {
    parsePairingLinkAny(raw);
  } catch {
    return null;
  }
  return raw.trim();
}

/** macOS passes the URL to `open-url`; Windows and Linux put it in argv (also of a second instance). */
export function pairLinkFromArgv(argv: readonly string[]): string | null {
  for (const arg of argv) {
    const link = pairLinkFromUrl(arg);
    if (link !== null) return link;
  }
  return null;
}

export interface PairLinkInboxDeps {
  /** Brings Settings → Server & remote access forward (a window that may not exist yet). */
  show: () => void;
  /** Tells open windows a link is waiting. */
  notify: () => void;
}

export interface PairLinkInbox {
  /** A URL from the OS. Returns whether it was a pairing link worth showing. */
  offer(url: string): boolean;
  offerArgv(argv: readonly string[]): boolean;
  /** Shows Settings for a link that arrived before the windows existed. */
  showPending(): void;
  /** The waiting link, once. */
  take(): string | null;
  /**
   * Whether the OS handed the app exactly this link (so main can tell the owner it came from
   * another app or a website, not from their own paste). Decided here, never by the window.
   */
  wasOffered(link: string): boolean;
}

export function createPairLinkInbox(deps: PairLinkInboxDeps): PairLinkInbox {
  let pending: string | null = null;
  const offered = new Set<string>();
  const accept = (link: string | null): boolean => {
    if (link === null) return false;
    pending = link;
    offered.add(link);
    deps.show();
    deps.notify();
    return true;
  };
  return {
    offer: (url) => accept(pairLinkFromUrl(url)),
    offerArgv: (argv) => accept(pairLinkFromArgv(argv)),
    showPending() {
      if (pending !== null) deps.show();
    },
    take() {
      const link = pending;
      pending = null;
      return link;
    },
    wasOffered: (link) => offered.has(link.trim()),
  };
}
