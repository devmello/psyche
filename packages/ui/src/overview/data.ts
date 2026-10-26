/**
 * The seam later Overview PRs plug into (agent-overview-2026 §6, §7). O1's `useInsights(window)`
 * will fill this from `insights.summary`; until it lands the shell reads the stub below, and a
 * story or test passes `data` straight to `OverviewScreen`.
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

/** Stub for O1's `useInsights`: nothing is known yet, so the regular page renders. */
export function useOverviewData(): OverviewData {
  return { firstActivityAt: undefined };
}
