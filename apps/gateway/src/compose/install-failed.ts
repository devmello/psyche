import type { PsycheNotifier } from "@psyche/notifications";
import type { ApprovalRequest, NoticeMessage, PermissionBroker } from "@psyche/protocol";
import { PsycheError } from "@psyche/protocol";

/**
 * Why an approved trust card did not install. The owner approved, so the Gateway must say so: a
 * receipt for the record and a notice for the owner.
 * `lost`: the Gateway restarted between proposing and approving, so the staged proposal is gone.
 * `expired`: the proposal ran out before the approval. `other`: any other refusal.
 */
export type ApprovedInstallReason = "lost" | "expired" | "other";

const RECEIPT_WHY: Record<ApprovedInstallReason, string> = {
  lost: "Psyche restarted before this was approved, so the proposal was lost. Propose it again.",
  expired: "The proposal had expired before this was approved. Propose it again.",
  other: "Psyche could not install it. Check the list and try again.",
};

export function approvedInstallReason(err: unknown): ApprovedInstallReason {
  const code = PsycheError.from(err).code;
  if (code === "not_found") return "lost";
  if (code === "approval_expired") return "expired";
  return "other";
}

/**
 * Tells the owner an approved install did not happen: a `failed` receipt on the approval (English,
 * like the other receipts) and a notice whose text is worded per reason in every language.
 */
export function reportApprovedInstallFailed(input: {
  broker: Pick<PermissionBroker, "recordReceipt">;
  notifier: Pick<PsycheNotifier, "notify">;
  approval: ApprovalRequest;
  kind: "connector" | "plugin";
  reason: ApprovedInstallReason;
}): void {
  const { approval, reason, kind } = input;
  const details = approval.details as { name?: unknown };
  const name = typeof details.name === "string" ? details.name.slice(0, 60) : "";
  const label = name === "" ? kind : `${kind} "${name}"`;
  const message: NoticeMessage = {
    titleKey: "notice.install.failed.title",
    bodyKey: "notice.install.failed.body",
    params: { reason },
  };
  void input.broker
    .recordReceipt({
      kind: kind === "connector" ? "connector_install" : "skill_install",
      outcome: "failed",
      summary: `Approved ${label} did not install. ${RECEIPT_WHY[reason]}`,
      approvalId: approval.id,
    })
    .catch(() => undefined);
  void input.notifier
    .notify({
      kind: "system",
      route: kind === "connector" ? "/settings/connectors" : "/settings",
      title: "An approved install didn't finish",
      body: RECEIPT_WHY[reason],
      message,
      dedupeKey: `install-failed:${approval.id}`,
    })
    .catch(() => undefined);
}
