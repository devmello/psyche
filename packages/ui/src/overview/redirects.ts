import type { AgentSheetRoute } from "../agent/AgentSheet.tsx";
import { overviewRunHref } from "./recent.ts";

/**
 * Where an old agent-sheet route now lives (agent-overview-2026 §3, §7 O5). The sheet's parser
 * still reads these routes; the shell sends them on:
 *
 * - `/agent/activity` → `/overview#now`, `/agent/upcoming` → `/overview#upcoming`,
 *   `/agent/growth` → `/overview#growth`
 * - `/agent/activity/run/<id>[?step=]` → `/overview/run/<id>[?step=]`
 *
 * - `/agent/activity/<taskId>` → `/overview#now` (the task rows live there now)
 *
 * Approvals and Soul & Memory stay in the sheet, so they have no redirect (null).
 */
export function overviewRedirect(route: AgentSheetRoute): string | null {
  if (route.tab === "activity") {
    if (route.runId !== undefined) {
      return overviewRunHref(route.runId, route.stepId ? { stepId: route.stepId } : {});
    }
    return "/overview#now";
  }
  if (route.tab === "upcoming") return "/overview#upcoming";
  if (route.tab === "growth") return "/overview#growth";
  return null;
}
