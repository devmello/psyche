/**
 * The app's navigable routes, as one allowlist: what `app_navigate` may open and what the
 * `psyche-app-guide` skill describes. The UI owns the screens; `packages/ui` has a test that
 * keeps this list equal to its Settings sections, and `packages/skills` has one that keeps the
 * guide mentioning every entry.
 */

/**
 * Settings routes (`/settings/<id>`), in the order of the Settings window: each page, then the
 * other panes on it. A pane id opens its page scrolled to that pane, so links written before the
 * 2026 regrouping still land (docs/design/settings-2026.md).
 */
export const APP_SETTINGS_SECTIONS = [
  "general",
  "appearance",
  "persona",
  "notifications",
  "voice",
  "model",
  "usage",
  "connectors",
  "search",
  "mail",
  "channels",
  "memory",
  "learning",
  "everything",
  "people",
  "daily",
  "skills",
  "specialists",
  "permissions",
  "computer-use",
  "browser",
  "files",
  "credentials",
  "vm",
  "data",
  "devices",
  "server",
  "about",
] as const;

export const APP_LIBRARY_SECTIONS = [
  "documents",
  "images",
  "artifacts",
  "downloads",
  "system",
] as const;

/** The agent sheet's tabs (`/agent/<tab>`). */
export const APP_AGENT_TABS = ["approvals", "activity", "upcoming", "soul"] as const;

/** First path segment of every top-level screen. */
export const APP_TOP_LEVEL_ROUTES = [
  "chat",
  "home",
  "people",
  "search",
  "feed",
  "ideas",
  "goals",
  "scheduled",
  "library",
  "overview",
  "inbox",
  "agent",
  "settings",
  "can-do",
  "onboarding",
] as const;

const SIMPLE = new Set<string>([
  "chat",
  "home",
  "people",
  "search",
  "feed",
  "ideas",
  "goals",
  "scheduled",
  "overview",
  "inbox",
  "can-do",
  "onboarding",
]);

/**
 * The canonical form of a route the app can open, or null. Only a screen, a Settings section,
 * a Library section or an agent-sheet tab: no ids, queries, hashes or anything else the model
 * could use to smuggle a value into the UI.
 */
export function resolveAppRoute(route: string): string | null {
  const parts = route.trim().split("/");
  if (parts[0] !== "" || parts.length < 2 || parts.length > 4) return null;
  const [, first = "", second, third] = parts;
  if (SIMPLE.has(first)) return second === undefined ? `/${first}` : null;
  if (first === "library") {
    if (third !== undefined) return null;
    if (second === undefined) return "/library/documents";
    return (APP_LIBRARY_SECTIONS as readonly string[]).includes(second)
      ? `/library/${second}`
      : null;
  }
  if (first === "agent") {
    if (third !== undefined || second === undefined) return null;
    return (APP_AGENT_TABS as readonly string[]).includes(second) ? `/agent/${second}` : null;
  }
  if (first === "settings") {
    if (second === undefined) return "/settings/model";
    if (!(APP_SETTINGS_SECTIONS as readonly string[]).includes(second)) return null;
    if (third === undefined) return `/settings/${second}`;
    return second === "connectors" && (third === "mcp" || third === "add-mcp")
      ? `/settings/connectors/${third}`
      : null;
  }
  return null;
}

/**
 * The durable links a notification carries in `Notification.route`, built in one place so the
 * inbox, the OS notification and the mac helper all open the same thing (nav-inbox 2026):
 *
 * - `/chat/<threadId>[?message=<id>|?approval=<id>]`: the chat that asked, scrolled to and
 *   highlighting the message or the approval card.
 * - `/overview/run/<runId>`: a run's Timeline.
 * - `/scheduled?tab=runs`: Scheduled → Runs.
 * - `/settings/memory`: Memory → Review.
 *
 * Ids are percent-encoded; a reader treats anything else as an old link (`/tasks/<id>`,
 * `/approvals/<id>`, `/upcoming/<id>`) and resolves it from the notification's own ids.
 */
export function chatLinkRoute(link: {
  threadId: string;
  messageId?: string | null;
  approvalId?: string | null;
}): string {
  const base = `/chat/${encodeURIComponent(link.threadId)}`;
  if (link.messageId) return `${base}?message=${encodeURIComponent(link.messageId)}`;
  if (link.approvalId) return `${base}?approval=${encodeURIComponent(link.approvalId)}`;
  return base;
}

export function runLinkRoute(runId: string): string {
  return `/overview/run/${encodeURIComponent(runId)}`;
}

export const SCHEDULED_RUNS_ROUTE = "/scheduled?tab=runs";
export const MEMORY_REVIEW_ROUTE = "/settings/memory";
