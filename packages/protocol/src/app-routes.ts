/**
 * The app's navigable routes, as one allowlist: what `app_navigate` may open and what the
 * `psyche-app-guide` skill describes. The UI owns the screens; `packages/ui` has a test that
 * keeps this list equal to its Settings sections, and `packages/skills` has one that keeps the
 * guide mentioning every entry.
 */

/** Settings sections (`/settings/<id>`), in the order of the Settings window. */
export const APP_SETTINGS_SECTIONS = [
  "model",
  "persona",
  "connectors",
  "skills",
  "specialists",
  "permissions",
  "computer-use",
  "browser",
  "files",
  "vm",
  "devices",
  "channels",
  "credentials",
  "appearance",
  "notifications",
  "voice",
  "mail",
  "daily",
  "data",
  "people",
  "server",
  "usage",
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
  "search",
  "feed",
  "ideas",
  "goals",
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
  "search",
  "feed",
  "ideas",
  "goals",
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
