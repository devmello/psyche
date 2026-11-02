/**
 * Where an old page now lives (docs/design/consolidation-2026.md §3.4). The Feed and Ideas
 * became Home sections; their routes stay valid (notifications, the Gateway and `app_navigate`
 * still write them) and the shell shows the new place for them, in place:
 *
 * - `/feed`, `/feed/<postId>` → `/home#today`
 * - `/feed/instructions` → `/home/instructions` (the brief's instructions sheet over Home)
 * - `/ideas` → `/home#suggestions`
 *
 * Anything else is not an old route (null).
 */
export function legacyRedirect(route: string): string | null {
  const path = route.split(/[?#]/)[0] ?? "";
  const parts = path.split("/").filter(Boolean);
  if (parts[0] === "feed") {
    return parts[1] === "instructions" ? "/home/instructions" : "/home#today";
  }
  if (parts[0] === "ideas") return "/home#suggestions";
  return null;
}

/** The first path segments `legacyRedirect` sends on. */
export const LEGACY_ROUTES: readonly string[] = ["feed", "ideas"];
