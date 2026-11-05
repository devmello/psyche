import type { PsycheDb } from "@psyche/db";
import type { SecurityAlert, SecurityAlertKind } from "@psyche/protocol";

/**
 * Security alerts (docs/design/security-state-integrity-2026.md §7.3): what the owner is shown,
 * on every device, after a security change that did not come through an authenticated Gateway
 * call. The table is sealed itself, so a row deleted to hide an alert is put back.
 */

export type AlertDetails = SecurityAlert["details"];

const WARNING: ReadonlySet<SecurityAlertKind> = new Set<SecurityAlertKind>([
  "state_changed_outside",
  "state_untrusted",
  "state_resealed",
  "local_first_admin",
  "recovery_requested",
  "recovery_failed",
]);

interface AlertRow {
  id: string;
  kind: string;
  severity: string;
  details: string;
  created_at: string;
  notified_at: string | null;
  acknowledged_at: string | null;
  acknowledged_by_device_id: string | null;
}

function fromRow(r: AlertRow): SecurityAlert {
  let details: AlertDetails = {};
  try {
    details = JSON.parse(r.details) as AlertDetails;
  } catch {
    details = {};
  }
  return {
    id: r.id,
    kind: r.kind as SecurityAlertKind,
    severity: r.severity === "info" ? "info" : "warning",
    details,
    createdAt: r.created_at,
    acknowledgedAt: r.acknowledged_at,
  };
}

export class AlertBook {
  readonly #db: PsycheDb;
  readonly #now: () => Date;
  readonly #listeners = new Set<(alert: SecurityAlert) => void>();

  constructor(db: PsycheDb, now: () => Date) {
    this.#db = db;
    this.#now = now;
  }

  /** Called for every new alert, after it is stored. */
  onAlert(listener: (alert: SecurityAlert) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  add(kind: SecurityAlertKind, details: AlertDetails = {}): SecurityAlert {
    const id = this.#db.newId();
    const at = this.#now().toISOString();
    this.#db.sqlite
      .prepare(
        "INSERT INTO security_alerts (id, kind, severity, details, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(id, kind, WARNING.has(kind) ? "warning" : "info", JSON.stringify(details), at);
    const alert = this.get(id) as SecurityAlert;
    for (const l of this.#listeners) {
      try {
        l(alert);
      } catch {
        // A listener (notification, event) never stops the alert itself.
      }
    }
    return alert;
  }

  get(id: string): SecurityAlert | undefined {
    const row = this.#db.sqlite.prepare("SELECT * FROM security_alerts WHERE id = ?").get(id) as
      | AlertRow
      | undefined;
    return row === undefined ? undefined : fromRow(row);
  }

  /** Open alerts first (newest first), then the last few acknowledged ones. */
  list(limit = 50): SecurityAlert[] {
    const rows = this.#db.sqlite
      .prepare(
        "SELECT * FROM security_alerts ORDER BY acknowledged_at IS NOT NULL, created_at DESC, id DESC LIMIT ?",
      )
      .all(limit) as AlertRow[];
    return rows.map(fromRow);
  }

  open(): SecurityAlert[] {
    return (
      this.#db.sqlite
        .prepare(
          "SELECT * FROM security_alerts WHERE acknowledged_at IS NULL ORDER BY created_at DESC, id DESC",
        )
        .all() as AlertRow[]
    ).map(fromRow);
  }

  acknowledge(id: string, deviceId: string | null): SecurityAlert | undefined {
    const at = this.#now().toISOString();
    this.#db.sqlite
      .prepare(
        "UPDATE security_alerts SET acknowledged_at = ?, acknowledged_by_device_id = ? WHERE id = ? AND acknowledged_at IS NULL",
      )
      .run(at, deviceId, id);
    return this.get(id);
  }

  /** Alerts not yet sent as a notification (boot-time alerts wait for the notifier). */
  unnotified(): SecurityAlert[] {
    return (
      this.#db.sqlite
        .prepare("SELECT * FROM security_alerts WHERE notified_at IS NULL ORDER BY created_at, id")
        .all() as AlertRow[]
    ).map(fromRow);
  }

  markNotified(id: string): void {
    this.#db.sqlite
      .prepare("UPDATE security_alerts SET notified_at = ? WHERE id = ? AND notified_at IS NULL")
      .run(this.#now().toISOString(), id);
  }
}

/** The English notification for an alert (the in-app banner uses the translated catalogue). */
export function alertNotice(alert: SecurityAlert): { title: string; body: string } {
  const d = alert.details;
  const when = d.notBefore === undefined ? "" : new Date(d.notBefore).toUTCString();
  switch (alert.kind) {
    case "state_changed_outside":
      return {
        title: "Psyche undid a security change made outside the app",
        body: `A program on this Mac changed ${d.changes?.length ?? 0} security ${(d.changes?.length ?? 0) === 1 ? "record" : "records"} (devices, keys, grants or settings) without going through Psyche. Psyche put them back. If you did not do this, check the Mac for unwanted software.`,
      };
    case "state_untrusted":
      return {
        title: "Psyche cannot trust its security records",
        body: "Psyche's check of its security records failed, so security changes, new devices and Touch ID approvals are blocked. Review your devices, then run `psyched security reseal` on the Mac (it applies after 24 hours).",
      };
    case "state_first_seal":
      return {
        title: "Psyche now checks its security records",
        body: `Psyche sealed ${d.devices ?? 0} paired ${(d.devices ?? 0) === 1 ? "device" : "devices"} and its security settings. From now on a change made outside Psyche is undone and shown here. Review your devices once.`,
      };
    case "state_resealed":
      return {
        title: d.restored
          ? "Security records sealed after a restore"
          : "Security records sealed again",
        body: d.restored
          ? "Psyche started from a restored backup and sealed its security records as they are. If you did not restore a backup, check your devices."
          : "Psyche sealed its security records again after the waiting period.",
      };
    case "local_first_admin":
      return {
        title: "A command on this Mac made the first admin device",
        body: `${d.deviceName ?? "A device"} became the first admin device through \`psyched\` on this Mac. If that was not you, revoke it in Settings → Devices.`,
      };
    case "recovery_requested":
      return {
        title: "A command on this Mac asked for a security change",
        body: `${recoveryText(d)} It applies ${when === "" ? "in 24 hours" : `on ${when}`} unless you cancel it in Psyche.`,
      };
    case "recovery_applied":
      return { title: "A security change from this Mac was applied", body: `${recoveryText(d)}` };
    case "recovery_cancelled":
      return { title: "A security change from this Mac was cancelled", body: `${recoveryText(d)}` };
    case "recovery_failed":
      return {
        title: "A security change from this Mac could not be applied",
        body: `${recoveryText(d)} ${d.reason ?? ""}`.trim(),
      };
  }
}

function recoveryText(d: AlertDetails): string {
  switch (d.op) {
    case "devices.approve":
      return `Approve the device ${d.deviceName ?? ""} with ${(d.scopes ?? []).join(", ")}.`;
    case "devices.grant":
      return `Give ${d.deviceName ?? "a device"} ${(d.scopes ?? []).join(", ")}.`;
    case "presence.reset":
      return "Turn off the Touch ID and passkey requirement for security changes until a new key is registered.";
    case "seal.reset":
      return "Accept the current security records as they are.";
    default:
      return "A security change.";
  }
}
