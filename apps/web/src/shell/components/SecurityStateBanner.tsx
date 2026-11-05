import type { SecurityAlert, SecurityRecovery, SecurityStateStatus } from "@psyche/protocol";
import { describeError, t, useI18n } from "@psyche/ui";
import { type ReactElement, useCallback, useEffect, useId, useState } from "react";
import type { ShellPlatform } from "../platform.ts";

/**
 * The security-records banner (docs/design/security-state-integrity-2026.md §7.3). Shown on every
 * screen while the Gateway has an alert nobody reviewed or a request from `psyched` on the Mac is
 * waiting: a change to devices, keys, grants or security settings made outside Psyche (undone),
 * a seal that failed its check, or a security change asked for on the Mac that applies later
 * unless cancelled. "Review" opens the list; reviewing and approving now need Touch ID or a
 * passkey once one is set up (the Gateway answers `approval_required`, the card is approved, the
 * button is pressed again).
 */

type Busy = { key: string } | null;

const codeOf = (err: unknown): unknown =>
  typeof err === "object" && err !== null ? (err as { code?: unknown }).code : undefined;

const approvalIdOf = (err: unknown): string | null => {
  if (codeOf(err) !== "approval_required") return null;
  const id = (err as { details?: { approvalId?: unknown } }).details?.approvalId;
  return typeof id === "string" && id !== "" ? id : null;
};

function opText(d: { op?: string | undefined; deviceName?: string | undefined }): string {
  const name = d.deviceName ?? t("web.security.device");
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
}

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
      return t("web.security.alert.firstAdmin", { name: d.deviceName ?? t("web.security.device") });
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

export function SecurityStateBanner({
  platform,
}: {
  platform: ShellPlatform;
}): ReactElement | null {
  const i18n = useI18n();
  const panelId = useId();
  const [state, setState] = useState<SecurityStateStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<Busy>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // The approval each action was answered with; the next press retries with it.
  const [approvals, setApprovals] = useState<Record<string, string>>({});
  const gateway = platform.gateway;

  const load = useCallback(() => {
    void gateway.call("security.state.get", {}).then(
      (r) => {
        const s = r as Partial<SecurityStateStatus> | null;
        setState(
          s !== null && Array.isArray(s.alerts) && Array.isArray(s.recoveries)
            ? (s as SecurityStateStatus)
            : null,
        );
      },
      // An older Gateway, or a device without operator.read: nothing to show.
      () => setState(null),
    );
  }, [gateway]);

  useEffect(() => {
    load();
    const offEvent = gateway.onEvent((e) => {
      if (e.event === "security.state.changed") load();
    });
    const offStatus = gateway.onStatus((s) => {
      if (s.phase === "paired") load();
    });
    const offResync = gateway.onResync(load);
    return () => {
      offEvent();
      offStatus();
      offResync();
    };
  }, [gateway, load]);

  if (state === null) return null;
  const openAlerts = state.alerts.filter((a) => a.acknowledgedAt === null);
  const waiting = state.recoveries.filter((r) => r.status === "waiting");
  const untrusted = state.status === "untrusted";
  if (!untrusted && openAlerts.length === 0 && waiting.length === 0) return null;

  const when = (iso: string | undefined) => (iso === undefined ? "" : i18n.dateTime(iso));
  const headline = untrusted
    ? t("web.security.banner.untrusted")
    : openAlerts.some((a) => a.kind === "state_changed_outside")
      ? t("web.security.banner.changed")
      : waiting.length > 0
        ? t("web.security.banner.recovery", {
            count: waiting.length,
            when: when(waiting.map((r) => r.notBefore).sort()[0]),
          })
        : t("web.security.banner.notice", { count: openAlerts.length });

  const run = async (key: string, method: string, params: Record<string, unknown>) => {
    setBusy({ key });
    setNotice(null);
    try {
      const approvalId = approvals[key];
      await gateway.call(method, approvalId === undefined ? params : { ...params, approvalId });
      setApprovals(({ [key]: _done, ...rest }) => rest);
      load();
    } catch (err) {
      const id = approvalIdOf(err);
      if (id !== null) {
        setApprovals((a) => ({ ...a, [key]: id }));
        setNotice(t("web.security.needsApproval"));
      } else {
        setNotice(t("web.security.failed", { message: describeError(err) }));
      }
    } finally {
      setBusy(null);
    }
  };

  const acknowledge = (a: SecurityAlert) =>
    void run(`ack:${a.id}`, "security.alerts.acknowledge", { id: a.id });
  const cancel = (r: SecurityRecovery) =>
    void run(`cancel:${r.id}`, "security.recoveries.cancel", { id: r.id });
  const approve = (r: SecurityRecovery) =>
    void run(`approve:${r.id}`, "security.recoveries.approve", { id: r.id });

  return (
    <div className="banner security-banner" role="alert" data-testid="security-banner">
      <div className="security-banner-row">
        <span>{headline}</span>
        <button
          type="button"
          className="banner-action"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((o) => !o)}
        >
          {open ? t("web.security.hide") : t("web.security.review")}
        </button>
      </div>
      {open ? (
        <section id={panelId} aria-label={t("web.security.panel.label")} className="security-panel">
          <ul className="security-list">
            {waiting.map((r) => (
              <li key={r.id} data-testid="security-recovery">
                <p>
                  {t("web.security.alert.requested", {
                    action: opText(r),
                    when: when(r.notBefore),
                  })}
                </p>
                <div className="security-actions">
                  {r.op === "seal.reset" || untrusted ? null : (
                    <button
                      type="button"
                      className="banner-action"
                      disabled={busy !== null}
                      onClick={() => approve(r)}
                    >
                      {t("web.security.approveNow")}
                    </button>
                  )}
                  <button
                    type="button"
                    className="banner-action"
                    disabled={busy !== null}
                    onClick={() => cancel(r)}
                  >
                    {t("web.security.cancel")}
                  </button>
                </div>
              </li>
            ))}
            {openAlerts
              .filter((a) => a.kind !== "recovery_requested")
              .map((a) => (
                <li key={a.id} data-testid="security-alert">
                  <p>{alertText(a, when)}</p>
                  {a.details.changes && a.details.changes.length > 0 ? (
                    <ul className="security-changes">
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
                    <div className="security-actions">
                      <button
                        type="button"
                        className="banner-action"
                        disabled={busy !== null}
                        onClick={() => acknowledge(a)}
                      >
                        {t("web.security.ack")}
                      </button>
                    </div>
                  )}
                </li>
              ))}
          </ul>
          {notice === null ? null : (
            <p role="status" className="security-notice">
              {notice}
            </p>
          )}
        </section>
      ) : null}
    </div>
  );
}
