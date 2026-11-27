import {
  decidePairingRequest,
  getDevice,
  getMachineByDevice,
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
import { applyPairingDecision, approvePairing } from "../handlers/devices.ts";
import type { Logger } from "../log.ts";
import { type PresenceState, resetPresenceEnrollment } from "../presence-gate.ts";
import { cleanLabel, cleanText } from "./alerts.ts";
import { assertPairingRequestBound, forgetPairingBinding } from "./pairing-bindings.ts";
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
/**
 * At most this many of one kind wait at once, so a flood of device requests cannot bury or block
 * a presence reset or a re-seal (each of those has one place, and a repeat joins it).
 */
const MAX_WAITING_PER_OP = 5;
/** Cancels from `psyched recovery cancel` per hour (each one is an alert). */
const MAX_MAC_CANCELS_PER_HOUR = 5;
/** Old inbox rows are dropped after this. */
const INBOX_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
/** `tick()` rescans the inbox and the due recoveries at least this often, whatever data_version says. */
const BACKSTOP_MS = 30_000;
/** How often `tick()` prunes old inbox rows. */
const STRICT_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const PRUNE_EVERY_MS = 60 * 60 * 1000;

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
  /** Recorded at intake from the request: `machine` pairs a machine and nothing else. */
  purpose?: "device" | "machine";
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

  #lastDv: number | null = null;
  #lastScan = 0;
  #lastPrune = 0;
  /** Earliest `not_before` of a waiting recovery, in ms; null when none waits. */
  #nextDue: number | null = null;

  /**
   * The 1 Hz poll's work. Reads only `PRAGMA data_version` (which moves when another connection
   * commits, such as the CLI's insert) unless it moved, 30 s passed, or a recovery is due. Its own
   * writes never move `data_version`, and it keeps its own copy, so `seal.ensure()` is unaffected.
   */
  tick(): void {
    const dv = this.#d.db.sqlite.prepare("PRAGMA data_version").pluck().get() as number;
    const nowMs = this.#d.now().getTime();
    // A clock that stepped back must not postpone the backstop.
    const stale = nowMs - this.#lastScan >= BACKSTOP_MS || nowMs < this.#lastScan;
    if (dv !== this.#lastDv || stale) {
      // Read before scanning, recorded only after it worked: a commit that lands meanwhile moves
      // it again, and a scan that threw (SQLITE_BUSY) is retried on the next tick.
      this.processInbox({ prune: false });
      if (nowMs - this.#lastPrune >= PRUNE_EVERY_MS || nowMs < this.#lastPrune) {
        this.#lastPrune = nowMs;
        this.prune();
      }
      this.applyDue();
      this.#refreshNextDue();
      this.#lastDv = dv;
      this.#lastScan = nowMs;
      return;
    }
    if (this.#nextDue !== null && nowMs >= this.#nextDue) {
      this.applyDue();
      this.#refreshNextDue();
    }
  }

  /**
   * The earliest time a waiting recovery may be due. Rows are read as the database has them,
   * sealed or not, and anything that is not a strict ISO time counts as due now: `applyDue` then
   * runs every tick and skips it, as it always did, so a planted row cannot postpone the real ones.
   */
  #refreshNextDue(): void {
    const rows = this.#d.db.sqlite
      .prepare("SELECT not_before AS t FROM security_recoveries WHERE status = 'waiting'")
      .all() as { t: unknown }[];
    let min: number | null = null;
    for (const { t } of rows) {
      const ms =
        typeof t === "string" && STRICT_ISO.test(t) ? Date.parse(t) : Number.NEGATIVE_INFINITY;
      const v = Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
      if (min === null || v < min) min = v;
    }
    this.#nextDue = min;
  }

  /** Drops inbox rows older than the retention window. */
  prune(): void {
    const cutoff = new Date(this.#d.now().getTime() - INBOX_KEEP_MS).toISOString();
    this.#d.db.sqlite.prepare("DELETE FROM security_requests WHERE created_at < ?").run(cutoff);
  }

  /** Takes every new inbox request. Never throws: a bad request is refused in its own row. */
  processInbox(opts: { prune?: boolean } = {}): number {
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
        res = { status: "refused", outcome: cleanText(PsycheError.from(err).message) };
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
    if (opts.prune !== false) this.prune();
    return rows.length;
  }

  /** Applies every waiting recovery whose delay is over. */
  applyDue(): number {
    const now = this.#iso();
    const due = this.#d.db.sqlite
      .prepare(
        "SELECT id FROM security_recoveries WHERE status = 'waiting' AND not_before <= ? ORDER BY not_before, id",
      )
      .pluck()
      .all(now) as string[];
    let n = 0;
    for (const id of due) {
      // Only the row exactly as the Gateway committed it, sealed or not: a row another program
      // wrote after the last seal check is not one (`#vouched`), and what applies is read from the
      // Gateway's own copy, so a change after the SELECT is never applied either. Never one
      // decided before (a rolled back database brings it back as waiting; the key file
      // remembers, M-A).
      const r = this.#vouched(id);
      if (r === undefined || r.status !== "waiting" || !(r.not_before <= now)) continue;
      if (this.#d.seal.recoveryDecided(r.id)) continue;
      this.#decide(r, "apply", null);
      n++;
    }
    return n;
  }

  list(limit = 20): SecurityRecovery[] {
    return (
      (
        this.#d.db.sqlite
          .prepare(
            "SELECT * FROM security_recoveries ORDER BY status = 'waiting' DESC, seen_at DESC, id DESC LIMIT ?",
          )
          .all(limit) as RecoveryRow[]
      )
        // Untrusted: a planted "waiting" recovery is not shown as if the Mac had asked for it.
        .filter((r) => this.#d.seal.genuine("security_recoveries", r.id))
        .map((r) => this.#view(r))
    );
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

  /** What `security.recoveries.approve` binds its presence card to, and what the card shows. */
  subject(id: string): {
    id: string;
    op: string;
    params: unknown;
    card: Record<string, string | string[]>;
  } {
    const r = this.#waiting(id);
    const p = parseJson(r.params) as RecoveryParams;
    return {
      id: r.id,
      op: r.op,
      params: p,
      card: {
        ...(typeof p.deviceName === "string" ? { deviceName: p.deviceName } : {}),
        ...(typeof p.fingerprint === "string" ? { deviceFingerprint: p.fingerprint } : {}),
        ...(Array.isArray(p.scopes) ? { scopes: p.scopes.map(String) } : {}),
      },
    };
  }

  /**
   * Cancels a waiting recovery. A re-seal is the owner's only way out of an untrusted state, so
   * it is cancelled only from a device the seal still trusts with admin (`trustedAdmin`), never
   * from the Mac, where any program could cancel it as fast as the owner asks.
   */
  cancel(
    id: string,
    byDeviceId: string | null,
    opts: { trustedAdmin?: boolean } = {},
  ): SecurityRecovery {
    const r = this.#waiting(id);
    if (r.op === "seal.reset" && opts.trustedAdmin !== true) {
      throw new PsycheError(
        "forbidden",
        "A re-seal can be cancelled only from an admin device Psyche still trusts",
      );
    }
    return this.#decide(r, "cancel", byDeviceId);
  }

  /**
   * Applies a waiting recovery now; the caller checked the approval for exactly `expected` (the
   * op and params it read from {@link subject}). A row that is no longer genuine or differs
   * (a foreign write between the check and now) is refused, so a tap never applies another op.
   */
  approveNow(
    id: string,
    byDeviceId: string,
    expected: { op: string; params: unknown },
  ): SecurityRecovery {
    // `#waiting` reads the row the Gateway itself committed: a planted or changed one is refused.
    const r = this.#waiting(id);
    if (
      r.op !== expected.op ||
      JSON.stringify(parseJson(r.params)) !== JSON.stringify(expected.params)
    ) {
      throw new PsycheError("conflict", `recovery ${id} changed since it was approved`);
    }
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

  /**
   * The recovery as the Gateway itself committed it, when the database still holds exactly that
   * (`StateSeal.vouchedRow`, which does not trust a row just because the state is sealed).
   */
  #vouched(id: string): RecoveryRow | undefined {
    const v = this.#d.seal.vouchedRow("security_recoveries", id);
    if (v === undefined || v.id !== id) return undefined;
    if (typeof v.op !== "string" || typeof v.params !== "string") return undefined;
    if (typeof v.status !== "string" || typeof v.not_before !== "string") return undefined;
    return v as unknown as RecoveryRow;
  }

  /** A waiting recovery the Gateway can vouch for (apply now, cancel, the approval card). */
  #waiting(id: string): RecoveryRow {
    if (this.#row(id) === undefined) throw new PsycheError("not_found", `no recovery ${id}`);
    const r = this.#vouched(id);
    if (r === undefined) {
      throw new PsycheError(
        "conflict",
        `recovery ${id} was changed outside Psyche; it cannot be applied or cancelled`,
      );
    }
    if (r.status !== "waiting" || this.#d.seal.recoveryDecided(r.id)) {
      throw new PsycheError("conflict", `recovery ${id} was already decided`);
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
      ...(typeof p.deviceName === "string" ? { deviceName: cleanLabel(p.deviceName) } : {}),
      ...(typeof p.fingerprint === "string" ? { deviceFingerprint: p.fingerprint } : {}),
      ...(Array.isArray(p.scopes) ? { scopes: p.scopes.map(String) } : {}),
      outcome: r.outcome,
    };
  }

  /**
   * First admin from the Mac: nobody holds admin, the records are trusted, and presence was never
   * enrolled (a fresh install). Once the owner had a Touch ID key or a passkey, an install with no
   * admin left is a recovery, not a first run: it waits like any other.
   */
  #firstAdmin(): boolean {
    return (
      this.#d.seal.untrusted() === null &&
      !this.#d.seal.presenceEverEnrolled() &&
      this.#d.presence.state() === "off" &&
      activeAdminCount(this.#d.db) === 0
    );
  }

  #intake(r: RequestRow): Intake {
    // No expiry from the row's own time (anything can write it): the CLI takes back a request
    // nobody answered, and the delay counts from when this Gateway first saw it.
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
        // Counted from the sealed alerts (each Mac cancel is one), so a restart does not reset it,
        // and from the key file, so deleting alerts while untrusted does not lower it (L4).
        const since = new Date(this.#d.now().getTime() - 3_600_000).toISOString();
        const fromAlerts = (
          this.#d.db.sqlite
            .prepare(
              "SELECT count(*) AS n FROM security_alerts WHERE kind = 'recovery_cancelled' AND json_extract(details, '$.via') = 'mac' AND created_at >= ?",
            )
            .get(since) as { n: number }
        ).n;
        const recent = Math.max(fromAlerts, this.#d.seal.macCancelsSince(since));
        if (recent >= MAX_MAC_CANCELS_PER_HOUR) {
          throw new PsycheError("rate_limited", "too many cancels from this Mac; try again later");
        }
        const done = this.cancel(String(params.id ?? ""), null);
        this.#d.seal.noteMacCancel();
        return { status: "applied", outcome: `recovery ${done.id} cancelled` };
      }
      default:
        return { status: "refused", outcome: `unknown request ${r.op}` };
    }
  }

  #intakeApprove(params: Record<string, unknown>): Intake {
    const { db } = this.#d;
    const code = String(params.code ?? "").toUpperCase();
    const requested = parseScopes(params.scopes);
    const candidates = listPairingRequests(db, { status: "pending" }).filter(
      (p) => p.kind === "device" && p.code === code,
    );
    // The row is not sealed: its device and key count only as this Gateway bound them when it
    // made the request. Any row with this code that differs (rewritten outside Psyche: alert) or
    // is not known (made before a restart) refuses the whole request; nothing is recorded.
    for (const p of candidates) assertPairingRequestBound(db, p);
    const request = candidates[0];
    if (request?.deviceId == null) {
      throw new PsycheError("not_found", `no pending pairing request with code ${code}`);
    }
    const device = getDevice(db, request.deviceId);
    if (device === undefined || device.revokedAt !== null) {
      throw new PsycheError("not_found", "the device of that request is gone");
    }
    // The key is the device's own (not what the request row says): they must agree.
    const fingerprint = keyFingerprint(device.publicKey);
    if (request.publicKeyFingerprint !== fingerprint) {
      throw new PsycheError(
        "conflict",
        "that pairing request does not name this device's key; ask the device to connect again",
      );
    }
    // A machine request is only ever a node with `["node"]`: whatever scopes were typed are
    // dropped here, and it never takes the first-admin shortcut.
    const machine = request.purpose === "machine";
    const scopes = machine ? ["node"] : requested;
    // M-E: only the request that makes the first admin applies at once; anything else waits.
    if (!machine && scopes.includes("operator.admin") && this.#firstAdmin()) {
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
        outcome: `approved ${cleanLabel(approved.name)} (${approved.id}) with ${approved.scopes.join(",")}`,
      };
    }
    return this.#queue("devices.approve", {
      pairingRequestId: request.id,
      deviceId: device.id,
      deviceName: cleanLabel(device.name),
      fingerprint,
      scopes,
      code,
      ...(machine ? { purpose: "machine" as const } : {}),
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
    // A machine is `["node"]` and nothing else: no grant, wider or narrower, applies to it.
    if (getMachineByDevice(db, device.id) !== undefined) {
      throw new PsycheError("conflict", `${deviceId} is a machine and takes no scopes`);
    }
    const widens = scopes.some((s) => !device.scopes.includes(s as DeviceScope));
    // Only the first admin applies at once. Narrowing waits too: taking admin away from the
    // owner's last admin device at once would make "no admin exists" true for a first-admin
    // approval right after it.
    if (widens && scopes.includes("operator.admin") && this.#firstAdmin()) {
      const updated = updateDevice(db, deviceId, { scopes: scopes as DeviceScope[] });
      if (updated === undefined) throw new PsycheError("not_found", `no paired device ${deviceId}`);
      this.#localFirstAdmin(updated, "devices.grant");
      return { status: "applied", outcome: `${deviceId} now has ${updated.scopes.join(",")}` };
    }
    return this.#queue("devices.grant", {
      deviceId,
      deviceName: cleanLabel(device.name),
      fingerprint: keyFingerprint(device.publicKey),
      scopes,
    });
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
        deviceFingerprint: keyFingerprint(device.publicKey),
        scopes: [...device.scopes],
        via: "mac",
      });
    }
  }

  #queue(op: SecurityRecoveryOp, params: RecoveryParams): Intake {
    const { db } = this.#d;
    // Only rows the Gateway committed, as it committed them: a planted row is never joined (the
    // owner's request would then wait on a row the seal removes) and never counts toward the cap.
    const waiting = (
      db.sqlite
        .prepare("SELECT id FROM security_recoveries WHERE status = 'waiting' AND op = ?")
        .pluck()
        .all(op) as string[]
    )
      .map((id) => this.#vouched(id))
      .filter((w): w is RecoveryRow => w?.status === "waiting" && w.op === op);
    // The same request again joins the one that waits (its time does not move).
    const same = waiting.find(
      (w) =>
        op === "presence.reset" ||
        op === "seal.reset" ||
        JSON.stringify(parseJson(w.params)) === JSON.stringify(params),
    );
    if (same !== undefined) {
      return {
        status: "waiting",
        recoveryId: same.id,
        notBefore: same.not_before,
        outcome: `waiting: the same request already waits and applies at ${same.not_before} unless it is cancelled (recovery ${same.id}).`,
      };
    }
    // A program flooding the inbox gets a few visible requests, not a wall of notifications.
    if (waiting.length >= MAX_WAITING_PER_OP) {
      throw new PsycheError(
        "rate_limited",
        `${MAX_WAITING_PER_OP} requests like this one are already waiting; cancel some first`,
      );
    }
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
      ...(typeof params.fingerprint === "string" ? { deviceFingerprint: params.fingerprint } : {}),
      ...(params.scopes === undefined ? {} : { scopes: params.scopes }),
      via: "mac",
    });
    return {
      status: "waiting",
      recoveryId: id,
      notBefore,
      outcome: `waiting: this applies at ${notBefore} unless it is cancelled; every device shows it until then. To apply it sooner, approve it with a tap on an admin device (a presence reset needs Touch ID or a passkey there) (recovery ${id}).`,
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
        outcome = cleanText(PsycheError.from(err).message);
      }
    }
    const at = this.#iso();
    db.sqlite
      .prepare(
        "UPDATE security_recoveries SET status = ?, decided_at = ?, decided_by_device_id = ?, outcome = ?, updated_at = ? WHERE id = ? AND status = 'waiting'",
      )
      .run(status, at, byDeviceId, outcome, at, r.id);
    this.#d.seal.noteRecoveryDecided(r.id);
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
        ...(typeof p.fingerprint === "string" ? { deviceFingerprint: p.fingerprint } : {}),
        ...(p.scopes === undefined ? {} : { scopes: p.scopes }),
        ...(status === "failed" ? { reason: outcome } : {}),
        // Cancelled with no device: from `psyched recovery cancel` on the Mac.
        ...(byDeviceId === null && status === "cancelled" ? { via: "mac" as const } : {}),
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
          typeof p.fingerprint !== "string" ||
          keyFingerprint(device.publicKey) !== p.fingerprint
        ) {
          throw new PsycheError("conflict", "the device key changed since the request");
        }
        const scopes = parseScopes(p.scopes) as DeviceScope[];
        // `pairing_requests` is not sealed: anything on the Mac can rewrite it. It never chooses
        // which device pairs. Only the device recorded (sealed) at intake pairs, the one every
        // device was shown. A stored request that now names another device or key is tampering:
        // refuse, so the owner sees it fail instead of pairing anything.
        const request =
          typeof p.pairingRequestId === "string"
            ? getPairingRequest(db, p.pairingRequestId)
            : undefined;
        if (
          request !== undefined &&
          (request.deviceId !== device.id || request.publicKeyFingerprint !== p.fingerprint)
        ) {
          throw new PsycheError(
            "conflict",
            "the pairing request changed since it was approved on the Mac; nothing was paired",
          );
        }
        // Machine if either the intake or the request itself (still stored when expired) says so.
        // The request can only narrow here: a machine is `["node"]` and nothing else.
        const machine = p.purpose === "machine" || request?.purpose === "machine";
        const approved = db.sqlite.transaction(
          () =>
            applyPairingDecision(db, {
              device,
              machine,
              scopes,
              pairedAt: device.pairedAt ?? this.#iso(),
              decidedByDeviceId: null,
            }).device,
        )();
        if (approved === undefined) throw new PsycheError("not_found", "the device is gone");
        // The card of a request still pending (same device and key, checked above) is answered.
        // Bookkeeping only. `decidePairingRequest` is always asked to approve: it does so while the
        // request is live, and one past its expiry it marks `expired` itself and throws.
        if (request?.status === "pending") {
          try {
            decidePairingRequest(db, request.id, { decision: "approved", decidedByDeviceId: null });
          } catch {
            // expired or decided meanwhile: the device is paired either way
          }
        }
        if (request !== undefined) forgetPairingBinding(db, request.id);
        this.#d.onDeviceChanged?.(approved);
        return `approved ${approved.name} with ${approved.scopes.join(",")}`;
      }
      case "devices.grant": {
        const scopes = parseScopes(p.scopes) as DeviceScope[];
        const device = getDevice(db, String(p.deviceId ?? ""));
        if (!device?.pairedAt || device.revokedAt) {
          throw new PsycheError("not_found", "the device is no longer paired");
        }
        if (getMachineByDevice(db, device.id) !== undefined) {
          throw new PsycheError("conflict", "the device is a machine and takes no scopes");
        }
        const updated = updateDevice(db, device.id, { scopes });
        if (updated === undefined) throw new PsycheError("not_found", "the device is gone");
        this.#d.onDeviceChanged?.(updated);
        return `${updated.name} now has ${updated.scopes.join(",")}`;
      }
      case "presence.reset": {
        const had = resetPresenceEnrollment(db);
        this.#d.seal.clearPresenceEnrolled();
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
