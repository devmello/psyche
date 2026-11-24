import type { SecurityAlert, SecurityRecovery } from "@psyche/protocol";
import { type ReactElement, useCallback, useContext, useState } from "react";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../../components/ui/alert-dialog.tsx";
import { Button } from "../../components/ui/button.tsx";
import { useCall, useGatewayQuery } from "../../data/hooks.ts";
import { t } from "../../i18n/core.ts";
import { useI18n } from "../../i18n/index.ts";
import {
  approvalIdOf,
  EmptyNotice,
  ErrorNotice,
  Group,
  LoadGate,
  messageOf,
  SettingsApprovalContext,
  StatusChip,
} from "./shared.tsx";

/**
 * Settings → Permissions → Security records (docs/design/security-state-integrity-2026.md §7.3).
 * Shows whether the Gateway's security records are sealed, the alerts nobody has reviewed and the
 * security changes asked for with `psyched` on this machine that apply after a delay unless they
 * are cancelled. The owner can mark an alert reviewed, apply a waiting request now or cancel it.
 *
 * Authorization is the Gateway's, not this screen's: acknowledging and approving answer
 * `approval_required` once presence is set up, and the retry goes through the same approval card
 * as a security setting (`SettingsApprovalContext`); cancelling only narrows and needs no card.
 * The list follows `security.state.changed` (the store invalidates the query) and reloads after
 * every action.
 */

const deviceText = (d: {
  deviceName?: string | undefined;
  deviceFingerprint?: string | undefined;
}): string => {
  const name = d.deviceName ?? t("web.security.device");
  if (d.deviceFingerprint === undefined) return name;
  const fingerprint = d.deviceFingerprint.replace(/^sha256:/, "").slice(0, 16);
  return t("web.security.deviceKey", { name, fingerprint });
};

const opText = (d: {
  op?: string | undefined;
  deviceName?: string | undefined;
  deviceFingerprint?: string | undefined;
}): string => {
  const name = deviceText(d);
  switch (d.op) {
    case "devices.approve":
      return t("web.security.op.devicesApprove", { name });
    case "devices.grant":
      return t("web.security.op.devicesGrant", { name });
    case "presence.reset":
      return t("web.security.op.presenceReset");
    default:
      return t("web.security.op.sealReset");
  }
};

function alertText(a: SecurityAlert, when: (iso: string | undefined) => string): string {
  const d = a.details;
  switch (a.kind) {
    case "state_changed_outside":
      return t("web.security.alert.changed", { count: (d.changes?.length ?? 0) + (d.more ?? 0) });
    case "state_untrusted":
      return t("web.security.alert.untrusted");
    case "state_first_seal":
      return t("web.security.alert.firstSeal", { devices: d.devices ?? 0 });
    case "state_resealed":
      return d.restored === true
        ? t("web.security.alert.restored")
        : t("web.security.alert.resealed");
    case "local_first_admin":
      return t("web.security.alert.firstAdmin", { name: deviceText(d) });
    case "recovery_requested":
      return t("web.security.alert.requested", { action: opText(d), when: when(d.notBefore) });
    case "recovery_applied":
      return t("web.security.alert.applied", { action: opText(d) });
    case "recovery_cancelled":
      return t("web.security.alert.cancelled", { action: opText(d) });
    case "recovery_failed":
      return t("web.security.alert.failed", { action: opText(d) });
  }
}

type SecurityAction =
  | "security.alerts.acknowledge"
  | "security.recoveries.approve"
  | "security.recoveries.cancel";

type Confirm = { kind: "approve" | "cancel"; recovery: SecurityRecovery } | null;

export function SecuritySection(): ReactElement {
  const i18n = useI18n();
  const call = useCall();
  const requestApproval = useContext(SettingsApprovalContext);
  const q = useGatewayQuery("security.state.get", {});
  const { reload } = q;
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Confirm>(null);

  const run = useCallback(
    async (key: string, method: SecurityAction, id: string) => {
      setBusy(true);
      setActionError(null);
      try {
        await call(method, { id });
        reload();
      } catch (err) {
        const approvalId = approvalIdOf(err);
        // Cancelling never asks for a card, so an answer that says it does is not one to retry.
        if (approvalId === null || method === "security.recoveries.cancel") {
          setActionError(t("web.security.failed", { message: messageOf(err) }));
        } else if (requestApproval) {
          // The same card as a security setting; once approved, the call goes again with it.
          requestApproval({
            key,
            label: t("settings.security.approvalLabel"),
            approvalId,
            retry: (retryId) =>
              call(method, { id, approvalId: retryId }).then((done) => {
                reload();
                return done;
              }),
          });
        } else {
          setActionError(
            t("settings.shared.needsPresence", { label: t("settings.security.approvalLabel") }),
          );
        }
      } finally {
        setBusy(false);
      }
    },
    [call, reload, requestApproval],
  );

  const state = q.data;
  const when = (iso: string | undefined) => (iso === undefined ? "" : i18n.dateTime(iso));
  const untrusted = state?.status === "untrusted";
  const openAlerts = (state?.alerts ?? []).filter((a) => a.acknowledgedAt === null);
  const waiting = (state?.recoveries ?? []).filter((r) => r.status === "waiting");
  // A request is listed on its own row; its "requested" alert would say the same thing twice.
  const alerts = openAlerts.filter((a) => a.kind !== "recovery_requested");

  return (
    <Group
      title={t("settings.security.title")}
      description={t("settings.security.description")}
      actions={
        state ? (
          <StatusChip tone={untrusted ? "danger" : "success"}>
            {untrusted
              ? t("settings.security.status.untrusted")
              : t("settings.security.status.sealed")}
          </StatusChip>
        ) : undefined
      }
    >
      <LoadGate
        label={t("settings.security.title")}
        loading={q.loading && state === undefined}
        error={q.error}
        onRetry={reload}
      >
        {state && waiting.length === 0 && alerts.length === 0 ? (
          <EmptyNotice text={t("settings.security.empty")} />
        ) : null}
        {waiting.map((r) => (
          <div key={r.id} data-testid="security-recovery" className="flex flex-col gap-2">
            <p className="text-body text-label-primary">
              {t("web.security.alert.requested", { action: opText(r), when: when(r.notBefore) })}
            </p>
            <div className="flex flex-wrap gap-2">
              {r.op === "seal.reset" || untrusted ? null : (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => setConfirm({ kind: "approve", recovery: r })}
                >
                  {t("web.security.approveNow")}
                </Button>
              )}
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => setConfirm({ kind: "cancel", recovery: r })}
              >
                {t("web.security.cancel")}
              </Button>
            </div>
          </div>
        ))}
        {alerts.map((a) => (
          <div key={a.id} data-testid="security-alert" className="flex flex-col gap-2">
            <p className="text-body text-label-primary">{alertText(a, when)}</p>
            {a.details.changes && a.details.changes.length > 0 ? (
              <ul className="list-disc ps-5 text-callout text-label-secondary">
                {a.details.changes.map((c) => (
                  <li key={`${c.table}:${c.change}:${c.name ?? ""}`}>
                    {t("web.security.change", {
                      change: c.change,
                      what: c.name === undefined ? c.table : `${c.table} · ${c.name}`,
                    })}
                  </li>
                ))}
                {a.details.more ? (
                  <li>{t("web.security.more", { count: a.details.more })}</li>
                ) : null}
              </ul>
            ) : null}
            {untrusted && a.kind === "state_untrusted" ? null : (
              <div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => void run(`ack:${a.id}`, "security.alerts.acknowledge", a.id)}
                >
                  {t("web.security.ack")}
                </Button>
              </div>
            )}
          </div>
        ))}
        {actionError === null ? null : <ErrorNotice what={actionError} did="" />}
      </LoadGate>
      <AlertDialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm?.kind === "approve"
                ? t("settings.security.approve.title")
                : t("settings.security.cancel.title")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm === null
                ? ""
                : t(
                    confirm.kind === "approve"
                      ? "settings.security.approve.body"
                      : "settings.security.cancel.body",
                    { action: opText(confirm.recovery), when: when(confirm.recovery.notBefore) },
                  )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("settings.security.keep")}</AlertDialogCancel>
            <Button
              type="button"
              variant={confirm?.kind === "cancel" ? "destructive" : "default"}
              onClick={() => {
                const c = confirm;
                setConfirm(null);
                if (c === null) return;
                void run(
                  `${c.kind}:${c.recovery.id}`,
                  c.kind === "approve"
                    ? "security.recoveries.approve"
                    : "security.recoveries.cancel",
                  c.recovery.id,
                );
              }}
            >
              {confirm?.kind === "approve"
                ? t("settings.security.approve.confirm")
                : t("web.security.cancel")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Group>
  );
}
