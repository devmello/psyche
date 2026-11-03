/**
 * Where an old page now lives (docs/design/consolidation-2026.md §3.4,
 * docs/design/memory-everything-2026.md §6.5). The Feed, Ideas and People became a Home section
 * and the Memory page; their routes stay valid (notifications, the Gateway and `app_navigate`
 * still write them) and the shell shows the new place for them, in place:
 *
 * - `/feed`, `/feed/<postId>` → `/home#today`
 * - `/feed/instructions` → `/home/instructions` (the brief's instructions sheet over Home)
 * - `/ideas` → `/home#suggestions`
 * - `/people` → `/memory?kind=people`, `/people?entity=<id>` → `/memory?entity=<id>`
 * - `/agent/soul?entity=<id>` → `/memory?entity=<id>` (the sheet no longer opens people)
 *
 * Anything else is not an old route (null).
 */
export function legacyRedirect(route: string): string | null {
  const [path = "", query = ""] = (route.split("#")[0] ?? "").split("?");
  const parts = path.split("/").filter(Boolean);
  if (parts[0] === "feed") {
    return parts[1] === "instructions" ? "/home/instructions" : "/home#today";
  }
  if (parts[0] === "ideas") return "/home#suggestions";
  const entity = new URLSearchParams(query).get("entity");
  const memoryEntity = entity ? `/memory?entity=${encodeURIComponent(entity)}` : null;
  if (parts[0] === "people") return memoryEntity ?? "/memory?kind=people";
  if (parts[0] === "agent" && parts[1] === "soul") return memoryEntity;
  return null;
}

/** The first path segments `legacyRedirect` sends on. */
export const LEGACY_ROUTES: readonly string[] = ["feed", "ideas", "people"];
