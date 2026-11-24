import { useInsights } from "../data/insights.ts";

/**
 * The seam the Overview reads its first-activity time through (agent-overview-2026 §6, §7): it is
 * filled from `insights.summary` by `useInsights`. A story or test passes `data` straight to
 * `OverviewScreen`.
 */
export interface OverviewData {
  /**
   * When the agent first did anything for the owner (`insights.summary.firstActivityAt`):
   * an ISO timestamp, `null` when it never has, `undefined` while unknown (not loaded or not
   * wired yet). Unknown renders the regular page; only `null` or a recent date is "new".
   */
  firstActivityAt: string | null | undefined;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** The new-user threshold: 7 days of activity before tiles and charts appear (§5.5, decision 7). */
export const NEW_USER_DAYS = 7;

/** True for the "getting to know you" state: no activity yet, or the first was under 7 days ago. */
export function isNewUser(firstActivityAt: string | null | undefined, now: number): boolean {
  if (firstActivityAt === undefined) return false;
  if (firstActivityAt === null) return true;
  const first = Date.parse(firstActivityAt);
  if (Number.isNaN(first)) return false;
  return now - first < NEW_USER_DAYS * DAY_MS;
}

/**
 * The Overview's first-activity time from `insights.summary`. The window does not change it, so
 * the cheapest one (`7d`) is asked. Until the answer arrives, or against a Gateway without the
 * method, it stays `undefined` and the regular page renders.
 */
export function useOverviewData(): OverviewData {
  const { data } = useInsights("7d");
  return { firstActivityAt: data === undefined ? undefined : data.firstActivityAt };
}
