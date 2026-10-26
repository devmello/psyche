/** How a clicked link opens (Settings → Browser → "Open links in"). */
export type LinkOpenMode = "ask" | "psyche" | "browser";

export const LINK_OPEN_SETTING = "ui.links.openIn";

export function linkOpenMode(value: unknown): LinkOpenMode {
  return value === "psyche" || value === "browser" ? value : "ask";
}

/** Schemes a click may send to the system browser; everything else is refused. */
const OPENABLE = new Set(["http:", "https:", "mailto:"]);

export interface OpenableLink {
  /** The normalised URL, safe to hand to `shell.openExternal`. */
  url: string;
  scheme: "http:" | "https:" | "mailto:";
  /** The real host (the mail domain for `mailto:`), as the URL parser reads it. */
  host: string;
  /** True when a host label is punycode, so a lookalike (Cyrillic "а") shows its real form. */
  punycode: boolean;
}

/**
 * The scheme allowlist: `http:`, `https:` and `mailto:` only. `file:`, `javascript:`, `data:`,
 * `psyche:` and every custom scheme return null, as do URLs with embedded credentials
 * (`https://bank.com@evil.test`), whose visible start hides the real host.
 */
export function classifyLink(raw: string): OpenableLink | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (!OPENABLE.has(u.protocol)) return null;
  if (u.username !== "" || u.password !== "") return null;
  let host = u.hostname;
  if (u.protocol === "mailto:") {
    const at = decodeURIComponent(u.pathname).split(",")[0]?.lastIndexOf("@") ?? -1;
    const first = decodeURIComponent(u.pathname).split(",")[0] ?? "";
    host = at >= 0 ? first.slice(at + 1).toLowerCase() : "";
    if (host === "") return null;
  } else if (host === "") {
    return null;
  }
  return {
    url: u.href,
    scheme: u.protocol as OpenableLink["scheme"],
    host,
    punycode: host.split(".").some((l) => l.startsWith("xn--")),
  };
}

export type LinkAction = "blocked" | "menu" | "browser" | "psyche";

/** What a click does: ⌘/Ctrl-click always goes to the default browser. */
export function resolveLinkAction(
  link: OpenableLink | null,
  mode: LinkOpenMode,
  modifier: boolean,
): LinkAction {
  if (!link) return "blocked";
  if (modifier) return "browser";
  // Psyche's own browser shows web pages; a mail link has no page to show.
  if (link.scheme === "mailto:") return "browser";
  return mode === "ask" ? "menu" : mode;
}
