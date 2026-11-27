import type { SecurityAlert, SecurityStateStatus } from "@psyche/protocol";

/**
 * Alerts that are an ordinary first-run or routine event, not a problem: the first seal of the
 * security records (every fresh install has one) and a re-seal after the waiting period. The
 * Gateway still sends each as a notice to the inbox, so the owner sees it once there; they do
 * not raise a banner on every page. A restore re-seal, an undone outside change, an untrusted
 * seal, the first admin made from the Mac and every recovery request still do.
 */
export function isQuietSecurityAlert(a: SecurityAlert): boolean {
  if (a.kind === "state_first_seal") return true;
  return a.kind === "state_resealed" && a.details.restored !== true;
}

/** Whether the banner shows at all, and which unreviewed alerts count toward it. */
export function securityBannerView(state: SecurityStateStatus): {
  show: boolean;
  openAlerts: SecurityAlert[];
  waiting: SecurityStateStatus["recoveries"];
  untrusted: boolean;
} {
  const openAlerts = state.alerts.filter((a) => a.acknowledgedAt === null);
  const raising = openAlerts.filter((a) => !isQuietSecurityAlert(a));
  const waiting = state.recoveries.filter((r) => r.status === "waiting");
  const untrusted = state.status === "untrusted";
  return {
    show: untrusted || raising.length > 0 || waiting.length > 0,
    openAlerts,
    waiting,
    untrusted,
  };
}
