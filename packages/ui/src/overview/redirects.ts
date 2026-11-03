import type { AgentSheetRoute } from "../agent/AgentSheet.tsx";
import { overviewRunHref } from "./recent.ts";

/**
 * Where an old agent-sheet route now lives (agent-overview-2026 §3, §7 O5). The sheet's parser
 * still reads these routes; the shell sends them on:
 *
 * - `/agent/activity` → `/overview#now`, `/agent/upcoming` → `/home#coming-up` (Upcoming moved to
 *   Home, docs/design/consolidation-2026.md §3.1), `/agent/growth` → `/overview#growth`
 * - `/agent/activity/run/<id>[?step=]` → `/overview/run/<id>[?step=]`
 *
 * - `/agent/activity/<taskId>` → `/overview#now` (the task rows live there now)
 * Approvals and Soul stay in the sheet, so they have no redirect (null). `/agent/soul?entity=<id>`
 * opens Memory in place (`legacyRedirect`), so it never reaches the sheet.
 */
export function overviewRedirect(route: AgentSheetRoute): string | null {
  if (route.tab === "activity") {
    if (route.runId !== undefined) {
      return overviewRunHref(route.runId, route.stepId ? { stepId: route.stepId } : {});
    }
    return "/overview#now";
  }
  if (route.tab === "upcoming") return "/home#coming-up";
  if (route.tab === "growth") return "/overview#growth";
  return null;
}
