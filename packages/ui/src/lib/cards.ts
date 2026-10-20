import { punycodeHosts, sanitizeDisplay } from "@psyche/permissions/cards";
import type { ApprovalRequest } from "@psyche/protocol";

/**
 * Display-safe approval summary for list rows and pointers (design-12): the same value-slot
 * rules the card itself applies. The full card goes through `sanitizeApproval` /
 * `renderForSurface("desktop", …)` in `ApprovalCard`.
 */
export function displaySummary(approval: Pick<ApprovalRequest, "summary">): string {
  return punycodeHosts(sanitizeDisplay(approval.summary));
}
