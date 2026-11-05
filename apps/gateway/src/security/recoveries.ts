import {
  getDevice,
  getPairingRequest,
  listPairingRequests,
  type PsycheDb,
  updateDevice,
} from "@psyche/db";
import {
  type AuditLog,
  type Device,
  DeviceScope,
  PsycheError,
  type SecurityRecovery,
  type SecurityRecoveryOp,
} from "@psyche/protocol";
import { keyFingerprint } from "../auth.ts";
import { activeAdminCount } from "../compose/bootstrap-admin.ts";
import { approvePairing } from "../handlers/devices.ts";
import type { Logger } from "../log.ts";
import { type PresenceState, resetPresenceEnrollment } from "../presence-gate.ts";
import type { StateSeal } from "./state-seal.ts";

/**
 * Local security requests and recoveries (docs/design/security-state-integrity-2026.md §7.2).
 *
 * `psyched devices approve|grant`, `presence reset`, `security reseal` and `recovery cancel` no
 * longer write the database: they queue a row in `security_requests` (which anything on the Mac
 * can write, so nothing in it is trusted) and wait for the running Gateway. The Gateway applies a
 * first-admin approval at once (same reach as `devices.bootstrapAdmin`); anything else that widens
 * access becomes a sealed recovery that applies `delayMs` (24 h) after the Gateway first saw it,
 * unless an admin cancels it or approves it now with fresh presence. Every step is an alert on
 * every device and an audit entry.
 */

export const RECOVERY_DELAY_MS = 24 * 60 * 60 * 1000;
/** A queued request the Gateway did not pick up within this is refused, not applied later. */
export const REQUEST_TTL_MS = 10 * 60 * 1000;
/** Old inbox rows are dropped after this. */
const INBOX_KEEP_MS = 7 * 24 * 60 * 60 * 1000;

const SCOPES = new Set<string>((DeviceScope as unknown as { enum: string[] }).enum);
/** The default for `psyched devices approve <code>`: the owner's first device. */
export const DEFAULT_APPROVE_SCOPES = [
  "operator.read",
  "operator.write",
  "operator.approvals",
  "operator.admin",
] as const;

interface RequestRow {
  id: string;
  op: string;
  params: string;
  created_at: string;
}

interface RecoveryRow {
  id: string;
  op: string;
  params: string;
  status: SecurityRecovery["status"];
  seen_at: string;
  not_before: string;
  decided_at: string | null;
  outcome: string | null;
}

interface RecoveryParams {
  deviceId?: string;
  deviceName?: string;
  scopes?: string[];
  pairingRequestId?: string;
  fingerprint?: string | null;
  code?: string;
}

type Intake =
  | { status: "applied"; outcome: string }
  | { status: "refused"; outcome: string }
  | { status: "waiting"; outcome: string; recoveryId: string; notBefore: string };

export interface RecoveryDeps {
  db: PsycheDb;
  seal: StateSeal;
  now: () => Date;
  delayMs?: number;
  audit?: Pick<AuditLog, "append">;
  log?: Logger;
  presence: { state(): PresenceState; forget(): void };
  /** A device was approved or got new scopes (publish it; close its pending connection). */
  onDeviceChanged?(device: Device): void;
}

function parseScopes(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : [...DEFAULT_APPROVE_SCOPES];
  const scopes = [...new Set(list.map((s) => String(s).trim()).filter(Boolean))];
  if (scopes.length === 0) throw new PsycheError("invalid_params", "no scopes given");
  for (const s of scopes) {
    if (!SCOPES.has(s)) throw new PsycheError("invalid_params", `unknown scope ${s}`);
  }
  return scopes;
}

function parseJson(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw) as unknown;
    return v !== null && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

const isOp = (op: string): op is SecurityRecoveryOp =>
  op === "devices.approve" ||
  op === "devices.grant" ||
  op === "presence.reset" ||
  op === "seal.reset";

export class SecurityRecoveries {
  readonly #d: RecoveryDeps;

  constructor(deps: RecoveryDeps) {
    this.#d = deps;
  }

  get delayMs(): number {
    return this.#d.delayMs ?? RECOVERY_DELAY_MS;
  }

  /** Takes every new inbox request. Never throws: a bad request is refused in its own row. */
  processInbox(): number {
    const { db } = this.#d;
    const rows = db.sqlite
      .prepare(
        "SELECT id, op, params, created_at FROM security_requests WHERE status = 'new' ORDER BY created_at, id",
      )
      .all() as RequestRow[];
    for (const r of rows) {
      let res: Intake;
      try {
        res = this.#intake(r);
      } catch (err) {
        res = { status: "refused", outcome: PsycheError.from(err).message };
      }
      db.sqlite
        .prepare(
          "UPDATE security_requests SET status = ?, outcome = ?, recovery_id = ?, not_before = ?, updated_at = ? WHERE id = ? AND status = 'new'",
        )
        .run(
          res.status,
          res.outcome,
          res.status === "waiting" ? res.recoveryId : null,
          res.status === "waiting" ? res.notBefore : null,
          this.#iso(),
          r.id,
        );
    }
    const cutoff = new Date(this.#d.now().getTime() - INBOX_KEEP_MS).toISOString();
    db.sqlite.prepare("DELETE FROM security_requests WHERE created_at < ?").run(cutoff);
    return rows.length;
  }

  /** Applies every waiting recovery whose delay is over. */
  applyDue(): number {
    const due = this.#d.db.sqlite
      .prepare(
        "SELECT * FROM security_recoveries WHERE status = 'waiting' AND not_before <= ? ORDER BY not_before, id",
      )
      .all(this.#iso()) as RecoveryRow[];
    for (const r of due) this.#decide(r, "apply", null);
    return due.length;
  }

  list(limit = 20): SecurityRecovery[] {
    return (
      this.#d.db.sqlite
        .prepare(
          "SELECT * FROM security_recoveries ORDER BY status = 'waiting' DESC, seen_at DESC, id DESC LIMIT ?",
        )
        .all(limit) as RecoveryRow[]
    ).map((r) => this.#view(r));
  }

  waitingCount(): number {
    return (
      this.#d.db.sqlite
        .prepare("SELECT COUNT(*) AS n FROM security_recoveries WHERE status = 'waiting'")
        .get() as { n: number }
    ).n;
  }

  get(id: string): SecurityRecovery | undefined {
    const r = this.#row(id);
    return r === undefined ? undefined : this.#view(r);
  }

  /** What `security.recoveries.approve` binds its presence card to. */
  subject(id: string): { id: string; op: string; params: unknown } {
    const r = this.#waiting(id);
    return { id: r.id, op: r.op, params: parseJson(r.params) };
  }

  cancel(id: string, byDeviceId: string | null): SecurityRecovery {
    return this.#decide(this.#waiting(id), "cancel", byDeviceId);
  }

  /** Applies a waiting recovery now; the caller checked fresh presence. */
  approveNow(id: string, byDeviceId: string): SecurityRecovery {
    const r = this.#waiting(id);
    if (r.op === "seal.reset") {
      throw new PsycheError(
        "forbidden",
        "A re-seal always waits: no Touch ID key or passkey can be trusted while the records are untrusted",
      );
    }
    if (this.#d.seal.untrusted() !== null) {
      throw new PsycheError(
        "presence_required",
        "Psyche's security records are untrusted, so this waits until its time",
        { details: { reason: "state_untrusted" } },
      );
    }
    return this.#decide(r, "apply", byDeviceId);
  }

  // -- internals ------------------------------------------------------------------------------

  #iso(): string {
    return this.#d.now().toISOString();
  }

  #row(id: string): RecoveryRow | undefined {
    return this.#d.db.sqlite.prepare("SELECT * FROM security_recoveries WHERE id = ?").get(id) as
      | RecoveryRow
      | undefined;
  }

  #waiting(id: string): RecoveryRow {
    const r = this.#row(id);
    if (r === undefined) throw new PsycheError("not_found", `no recovery ${id}`);
    if (r.status !== "waiting") {
      throw new PsycheError("conflict", `recovery ${id} is ${r.status}, not waiting`);
    }
    return r;
  }

  #view(r: RecoveryRow): SecurityRecovery {
    const p = parseJson(r.params) as RecoveryParams;
    return {
      id: r.id,
      op: (isOp(r.op) ? r.op : "seal.reset") as SecurityRecoveryOp,
      status: r.status,
      requestedAt: r.seen_at,
      notBefore: r.not_before,
      decidedAt: r.decided_at,
      ...(typeof p.deviceId === "string" ? { deviceId: p.deviceId } : {}),
      ...(typeof p.deviceName === "string" ? { deviceName: p.deviceName } : {}),
      ...(Array.isArray(p.scopes) ? { scopes: p.scopes.map(String) } : {}),
      outcome: r.outcome,
    };
  }

  /** First admin: nobody holds admin and the records are trusted (`devices.bootstrapAdmin`'s rule). */
  #firstAdmin(): boolean {
    return this.#d.seal.untrusted() === null && activeAdminCount(this.#d.db) === 0;
  }

  #intake(r: RequestRow): Intake {
    const age = this.#d.now().getTime() - Date.parse(r.created_at);
    if (!(age <= REQUEST_TTL_MS)) {
      return { status: "refused", outcome: "the request expired before psyched picked it up" };
    }
    const params = parseJson(r.params);
    switch (r.op) {
      case "devices.approve":
        return this.#intakeApprove(params);
      case "devices.grant":
        return this.#intakeGrant(params);
      case "presence.reset":
        if (this.#d.seal.untrusted() === null && this.#d.presence.state() === "off") {
          return { status: "applied", outcome: "presence was not enrolled; nothing to reset" };
        }
        return this.#queue("presence.reset", {});
      case "seal.reset":
        if (this.#d.seal.untrusted() === null) {
          return { status: "applied", outcome: "the security records are sealed; nothing to do" };
        }
        return this.#queue("seal.reset", {});
      case "recovery.cancel": {
        const id = String(params.id ?? "");
        const done = this.cancel(id, null);
        return { status: "applied", outcome: `recovery ${done.id} cancelled` };
      }
      default:
        return { status: "refused", outcome: `unknown request ${r.op}` };
    }
  }

  #intakeApprove(params: Record<string, unknown>): Intake {
    const { db } = this.#d;
    const code = String(params.code ?? "").toUpperCase();
    const scopes = parseScopes(params.scopes);
    const request = listPairingRequests(db, { status: "pending" }).find(
      (p) => p.kind === "device" && p.code === code,
    );
    if (request?.deviceId == null) {
      throw new PsycheError("not_found", `no pending pairing request with code ${code}`);
    }
    const device = getDevice(db, request.deviceId);
    if (device === undefined || device.revokedAt !== null) {
      throw new PsycheError("not_found", "the device of that request is gone");
    }
    if (this.#firstAdmin()) {
      const { device: approved } = db.sqlite.transaction(() =>
        approvePairing(db, {
          pairingRequestId: request.id,
          scopes: scopes as DeviceScope[],
          code,
          decidedByDeviceId: null,
        }),
      )();
      this.#localFirstAdmin(approved, "devices.approve");
      return {
        status: "applied",
        outcome: `approved ${approved.name} (${approved.id}) with ${approved.scopes.join(",")}`,
      };
    }
    return this.#queue("devices.approve", {
      pairingRequestId: request.id,
      deviceId: device.id,
      deviceName: device.name,
      fingerprint: request.publicKeyFingerprint ?? null,
      scopes,
      code,
    });
  }

  #intakeGrant(params: Record<string, unknown>): Intake {
    const { db } = this.#d;
    const deviceId = String(params.deviceId ?? "");
    const scopes = parseScopes(params.scopes);
    const device = getDevice(db, deviceId);
    if (!device?.pairedAt || device.revokedAt) {
      throw new PsycheError("not_found", `no paired device ${deviceId}`);
    }
    const widens = scopes.some((s) => !device.scopes.includes(s as DeviceScope));
    // Narrowing a device is what an admin may always do; from the Mac too, at once.
    if (!widens || this.#firstAdmin()) {
      const updated = updateDevice(db, deviceId, { scopes: scopes as DeviceScope[] });
      if (updated === undefined) throw new PsycheError("not_found", `no paired device ${deviceId}`);
      this.#d.onDeviceChanged?.(updated);
      if (widens) this.#localFirstAdmin(updated, "devices.grant");
      else this.#audit("security.local.narrowed", { deviceId, scopes });
      return { status: "applied", outcome: `${deviceId} now has ${updated.scopes.join(",")}` };
    }
    return this.#queue("devices.grant", { deviceId, deviceName: device.name, scopes });
  }

  #localFirstAdmin(device: Device, op: string): void {
    this.#d.onDeviceChanged?.(device);
    this.#audit("device.bootstrap_admin", {
      deviceId: device.id,
      name: device.name,
      via: `psyched ${op.replace(".", " ")}`,
    });
    if (device.scopes.includes("operator.admin")) {
      this.#d.seal.alerts.add("local_first_admin", {
        deviceName: device.name,
        scopes: [...device.scopes],
      });
    }
  }

  #queue(op: SecurityRecoveryOp, params: RecoveryParams): Intake {
    const { db } = this.#d;
    const id = db.newId();
    const now = this.#d.now();
    const at = now.toISOString();
    const notBefore = new Date(now.getTime() + this.delayMs).toISOString();
    db.sqlite
      .prepare(
        `INSERT INTO security_recoveries (id, op, params, status, seen_at, not_before, created_at, updated_at)
         VALUES (?, ?, ?, 'waiting', ?, ?, ?, ?)`,
      )
      .run(id, op, JSON.stringify(params), at, notBefore, at, at);
    this.#audit("security.recovery.requested", { recoveryId: id, op, notBefore });
    this.#d.seal.alerts.add("recovery_requested", {
      recoveryId: id,
      op,
      notBefore,
      ...(params.deviceName === undefined ? {} : { deviceName: params.deviceName }),
      ...(params.scopes === undefined ? {} : { scopes: params.scopes }),
    });
    return {
      status: "waiting",
      recoveryId: id,
      notBefore,
      outcome: `waiting: this applies at ${notBefore} unless it is cancelled; every device shows it until then. To apply it sooner, approve it with Touch ID or a passkey on an admin device (recovery ${id}).`,
    };
  }

  #decide(r: RecoveryRow, how: "apply" | "cancel", byDeviceId: string | null): SecurityRecovery {
    const { db } = this.#d;
    let status: SecurityRecovery["status"] = how === "cancel" ? "cancelled" : "applied";
    let outcome = how === "cancel" ? "cancelled" : "applied";
    if (how === "apply") {
      try {
        outcome = this.#apply(r);
      } catch (err) {
        status = "failed";
        outcome = PsycheError.from(err).message;
      }
    }
    const at = this.#iso();
    db.sqlite
      .prepare(
        "UPDATE security_recoveries SET status = ?, decided_at = ?, decided_by_device_id = ?, outcome = ?, updated_at = ? WHERE id = ? AND status = 'waiting'",
      )
      .run(status, at, byDeviceId, outcome, at, r.id);
    // The "waiting" alert is answered; the outcome is a new one.
    db.sqlite
      .prepare(
        "UPDATE security_alerts SET acknowledged_at = ?, acknowledged_by_device_id = ? WHERE kind = 'recovery_requested' AND json_extract(details, '$.recoveryId') = ? AND acknowledged_at IS NULL",
      )
      .run(at, byDeviceId, r.id);
    const p = parseJson(r.params) as RecoveryParams;
    const op = isOp(r.op) ? r.op : undefined;
    this.#audit(`security.recovery.${status}`, {
      recoveryId: r.id,
      op: r.op,
      ...(byDeviceId === null ? {} : { byDeviceId }),
      outcome,
    });
    this.#d.seal.alerts.add(
      status === "applied"
        ? "recovery_applied"
        : status === "cancelled"
          ? "recovery_cancelled"
          : "recovery_failed",
      {
        recoveryId: r.id,
        ...(op === undefined ? {} : { op }),
        ...(p.deviceName === undefined ? {} : { deviceName: p.deviceName }),
        ...(p.scopes === undefined ? {} : { scopes: p.scopes }),
        ...(status === "failed" ? { reason: outcome } : {}),
      },
    );
    return this.get(r.id) as SecurityRecovery;
  }

  #apply(r: RecoveryRow): string {
    const { db } = this.#d;
    const p = parseJson(r.params) as RecoveryParams;
    switch (r.op) {
      case "devices.approve": {
        const device = getDevice(db, String(p.deviceId ?? ""));
        if (device === undefined || device.revokedAt !== null) {
          throw new PsycheError("not_found", "the device is gone or revoked");
        }
        if (
          typeof p.fingerprint === "string" &&
          keyFingerprint(device.publicKey) !== p.fingerprint
        ) {
          throw new PsycheError("conflict", "the device key changed since the request");
        }
        const scopes = parseScopes(p.scopes) as DeviceScope[];
        const request =
          typeof p.pairingRequestId === "string"
            ? getPairingRequest(db, p.pairingRequestId)
            : undefined;
        // The request itself has usually expired by now (5 minutes): pair the device directly.
        const live =
          request?.status === "pending" && Date.parse(request.expiresAt) > this.#d.now().getTime();
        const approved =
          request !== undefined && live
            ? db.sqlite.transaction(
                () =>
                  approvePairing(db, {
                    pairingRequestId: request.id,
                    scopes,
                    decidedByDeviceId: null,
                  }).device,
              )()
            : updateDevice(db, device.id, { scopes, pairedAt: device.pairedAt ?? this.#iso() });
        if (approved === undefined) throw new PsycheError("not_found", "the device is gone");
        this.#d.onDeviceChanged?.(approved);
        return `approved ${approved.name} with ${approved.scopes.join(",")}`;
      }
      case "devices.grant": {
        const scopes = parseScopes(p.scopes) as DeviceScope[];
        const device = getDevice(db, String(p.deviceId ?? ""));
        if (!device?.pairedAt || device.revokedAt) {
          throw new PsycheError("not_found", "the device is no longer paired");
        }
        const updated = updateDevice(db, device.id, { scopes });
        if (updated === undefined) throw new PsycheError("not_found", "the device is gone");
        this.#d.onDeviceChanged?.(updated);
        return `${updated.name} now has ${updated.scopes.join(",")}`;
      }
      case "presence.reset": {
        const had = resetPresenceEnrollment(db);
        this.#d.presence.forget();
        return had
          ? "presence enrollment cleared: register a passkey or the helper's key again"
          : "presence was not enrolled";
      }
      case "seal.reset":
        this.#d.seal.reseal("recovery");
        this.#d.seal.alerts.add("state_resealed", { restored: false });
        return "the security records are sealed again";
      default:
        throw new PsycheError("invalid_params", `unknown recovery ${r.op}`);
    }
  }

  #audit(kind: string, data: Record<string, unknown>): void {
    void this.#d.audit
      ?.append({ kind, actor: { type: "system" }, data: data as never })
      .catch(() => undefined);
  }
}
