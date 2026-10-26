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
 * Approvals, Soul & Memory and a task opened in Activity (`/agent/activity/<taskId>`) stay in the
 * sheet, so they have no redirect (null).
 */
export function overviewRedirect(route: AgentSheetRoute): string | null {
  if (route.tab === "activity") {
    if (route.runId !== undefined) {
      return overviewRunHref(route.runId, route.stepId ? { stepId: route.stepId } : {});
    }
    return route.taskId === undefined ? "/overview#now" : null;
  }
  if (route.tab === "upcoming") return "/overview#upcoming";
  if (route.tab === "growth") return "/overview#growth";
  return null;
}
