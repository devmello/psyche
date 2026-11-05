import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { PsycheDb } from "@psyche/db";
import { RevocationLedger } from "@psyche/permissions";
import { type AuditLog, PsycheError, type SecurityAlert } from "@psyche/protocol";
import type { Logger } from "../log.ts";
import { AlertBook, type AlertDetails } from "./alerts.ts";
import {
  isSealedSettingKey,
  pkExpr,
  rowJson,
  SEAL_FORMAT,
  SEALED_SETTING_FN,
  SEALED_TABLES,
  type SealedTable,
  whereExpr,
} from "./seal-spec.ts";

/**
 * The security-state seal (docs/design/security-state-integrity-2026.md §7.1).
 *
 * `security_ledger` keeps, for every sealed row, its canonical JSON and `HMAC(K, tbl‖pk‖row)`;
 * `security_seal.agg` is the XOR of `HMAC(K, "agg"‖mac)` over the ledger. Only the Gateway's own
 * connection maintains them: TEMP triggers (which exist on this connection alone) call functions
 * registered here with the key. A write from any other connection fires nothing and is found by
 * `ensure()`, which the Gateway calls before every authorizing read; it costs one
 * `PRAGMA data_version` unless another connection committed.
 *
 * What it is: tamper evidence plus a fail-closed repair against programs that write the database
 * without Psyche's key. What it is not: protection against a program that reads
 * `security/state-seal-key.json` or runs code as `psyched` (design §4, decisions D1/D3).
 */

export const SEAL_KEY_FILE = join("security", "state-seal-key.json");
/** The audit kind of a seal being made; its presence later means a missing seal is a reset. */
export const SEALED_AUDIT_KIND = "security.state.sealed";
const ZERO = "0".repeat(64);
const MAX_LISTED_CHANGES = 20;

const MAC_FN = "psyche_seal_mac";
const FOLD_FN = "psyche_seal_fold";

export type UntrustedReason =
  | "seal_missing"
  | "seal_reset"
  | "key_changed"
  | "ledger_mismatch"
  | "format_unknown"
  | "repair_failed";

interface KeyFile {
  v: 1;
  key: string;
  createdAt: string;
}

function readKey(path: string): Buffer | undefined {
  if (!existsSync(path)) return undefined;
  const file = JSON.parse(readFileSync(path, "utf8")) as KeyFile;
  const key = Buffer.from(String(file.key ?? ""), "base64");
  if (file.v !== 1 || key.length !== 32) {
    throw new PsycheError("internal", `${SEAL_KEY_FILE} is not a Psyche seal key`);
  }
  return key;
}

function writeKey(path: string, key: Buffer, now: Date): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  const tmp = `${path}.${process.pid}.tmp`;
  const file: KeyFile = { v: 1, key: key.toString("base64"), createdAt: now.toISOString() };
  writeFileSync(tmp, `${JSON.stringify(file)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

export function sealKeyId(key: Buffer): string {
  return createHash("sha256")
    .update("psyche-state-seal-key-id\0")
    .update(key)
    .digest("hex")
    .slice(0, 32);
}

function macOf(key: Buffer, tbl: string, pk: string, row: string): string {
  return createHmac("sha256", key).update(`row\0${tbl}\0${pk}\0${row}`).digest("hex");
}

function foldOf(key: Buffer, agg: string, mac: string): string {
  const contrib = createHmac("sha256", key).update(`agg\0${mac}`).digest();
  const out = Buffer.from(agg, "hex");
  for (let i = 0; i < out.length; i++) out[i] = (out[i] as number) ^ (contrib[i] as number);
  return out.toString("hex");
}

function sameHex(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

/** One row whose current state differs from its sealed state. */
export interface SealChange {
  spec: SealedTable;
  pk: string;
  change: "added" | "modified" | "removed";
  /** The sealed canonical JSON (modified, removed). */
  sealed?: string;
  /** The current canonical JSON (added, modified). */
  current?: string;
}

interface CheckResult {
  sealPresent: boolean;
  keyMatches: boolean;
  ledgerOk: boolean;
  changes: SealChange[];
}

interface SealRow {
  format: number;
  key_id: string;
  agg: string;
  state: string;
}

export interface StateSealOptions {
  home: string;
  now?: () => Date;
  log?: Logger;
  /** Earlier seals are recorded here; `list` tells a first seal from a reset. */
  audit?: Pick<AuditLog, "append" | "list">;
  /** A restored backup is starting (`security/restored.json`): seal it as it is. */
  restored?: boolean;
}

export interface SealStatus {
  status: "sealed" | "untrusted";
  reason: UntrustedReason | null;
}

const SEALS = new WeakMap<PsycheDb["sqlite"], StateSeal>();

/**
 * The seal attached to this connection, if any. Callers outside the Gateway core (compose parts,
 * stores) call `ensureSecurityState(db)` before an authorizing read.
 */
export function stateSealFor(db: PsycheDb): StateSeal | undefined {
  return SEALS.get(db.sqlite);
}

/** `ensure()` on the connection's seal; a no-op for a connection without one. */
export function ensureSecurityState(db: PsycheDb): void {
  SEALS.get(db.sqlite)?.ensure();
}

export class StateSeal {
  readonly alerts: AlertBook;
  readonly #db: PsycheDb;
  readonly #o: StateSealOptions;
  readonly #now: () => Date;
  readonly #ledger: RevocationLedger;
  #key: Buffer;
  #dv = -1;
  #triggerCount = 0;
  #untrusted: UntrustedReason | null = null;
  readonly #revokedListeners = new Set<(deviceIds: string[]) => void>();
  readonly #changeListeners = new Set<() => void>();

  private constructor(db: PsycheDb, key: Buffer, o: StateSealOptions) {
    this.#db = db;
    this.#o = o;
    this.#now = o.now ?? (() => new Date());
    this.#key = key;
    this.#ledger = new RevocationLedger(o.home, () => this.#now().toISOString());
    this.alerts = new AlertBook(db, this.#now);
    this.alerts.onAlert(() => this.#changed());
  }

  /**
   * Installs the seal on the connection and checks it: a first seal, a re-seal after a restore,
   * or a verification that repairs what changed while the Gateway was not running.
   */
  static async open(db: PsycheDb, o: StateSealOptions): Promise<StateSeal> {
    const now = o.now ?? (() => new Date());
    const keyPath = join(o.home, SEAL_KEY_FILE);
    const existing = readKey(keyPath);
    const key = existing ?? randomBytes(32);
    if (existing === undefined) writeKey(keyPath, key, now());
    const seal = new StateSeal(db, key, o);
    seal.#install();
    SEALS.set(db.sqlite, seal);
    await seal.#boot(existing !== undefined);
    seal.#dv = seal.#dataVersion();
    return seal;
  }

  /** The reason the state is untrusted, or `null` while it is sealed. */
  untrusted(): UntrustedReason | null {
    return this.#untrusted;
  }

  status(): SealStatus {
    return this.#untrusted === null
      ? { status: "sealed", reason: null }
      : { status: "untrusted", reason: this.#untrusted };
  }

  /** Devices revoked because they appeared outside Psyche (the Gateway closes their connections). */
  onDevicesRevoked(listener: (deviceIds: string[]) => void): () => void {
    this.#revokedListeners.add(listener);
    return () => this.#revokedListeners.delete(listener);
  }

  /** Anything clients should refresh: an alert, a recovery, the seal's state. */
  onChange(listener: () => void): () => void {
    this.#changeListeners.add(listener);
    return () => this.#changeListeners.delete(listener);
  }

  /** Tell listeners (the Gateway publishes `security.state.changed`). */
  changed(): void {
    this.#changed();
  }

  /**
   * Before an authorizing read: if another connection committed since the last check, verify the
   * seal and restore what changed. Inside an open transaction it cannot repair; it refuses the
   * call when something changed, and the next check outside the transaction repairs.
   */
  ensure(): void {
    this.#guardTriggers();
    const dv = this.#dataVersion();
    if (dv === this.#dv) return;
    if (this.#db.sqlite.inTransaction) {
      const r = this.#check();
      if (r.sealPresent && r.keyMatches && r.ledgerOk && r.changes.length === 0) return;
      throw new PsycheError(
        "unavailable",
        "Psyche's security records changed outside the app; try again in a moment",
        { retryable: true, details: { reason: "security_state_changed" } },
      );
    }
    this.#dv = dv;
    this.#verify("runtime");
  }

  /**
   * Seals the current state as it is (a restored backup, an owner's re-seal recovery). Clears an
   * untrusted state. The key file is kept unless it is unreadable.
   */
  reseal(reason: "restored" | "recovery"): void {
    const at = this.#now().toISOString();
    this.#db.sqlite.transaction(() => {
      this.#db.sqlite.prepare("DELETE FROM security_ledger").run();
      this.#db.sqlite
        .prepare(
          `INSERT INTO security_seal (id, format, key_id, agg, state, sealed_at, updated_at)
           VALUES (1, ?, ?, ?, 'sealed', ?, ?)
           ON CONFLICT (id) DO UPDATE SET format = excluded.format, key_id = excluded.key_id,
             agg = excluded.agg, state = 'sealed', sealed_at = excluded.sealed_at,
             updated_at = excluded.updated_at`,
        )
        .run(SEAL_FORMAT, sealKeyId(this.#key), ZERO, at, at);
      this.#populate();
    })();
    this.#untrusted = null;
    this.#dv = this.#dataVersion();
    this.#audit(SEALED_AUDIT_KIND, { first: false, reason, keyId: sealKeyId(this.#key) });
    this.#changed();
  }

  /** Counts for the first-seal notice. */
  counts(): { devices: number; admins: number } {
    const rows = this.#db.sqlite
      .prepare("SELECT scopes FROM devices WHERE paired_at IS NOT NULL AND revoked_at IS NULL")
      .all() as { scopes: string }[];
    return {
      devices: rows.length,
      admins: rows.filter((r) => r.scopes.includes('"operator.admin"')).length,
    };
  }

  // -- internals ------------------------------------------------------------------------------

  #changed(): void {
    for (const l of this.#changeListeners) {
      try {
        l();
      } catch {
        // listeners never break the seal
      }
    }
  }

  #dataVersion(): number {
    return this.#db.sqlite.pragma("data_version", { simple: true }) as number;
  }

  /**
   * The TEMP triggers die with the connection's temp schema (a `temp_store` change drops it).
   * `#install` fixes `temp_store` first so the usual `temp_store = MEMORY` elsewhere is a no-op;
   * if they are gone anyway, put them back at once: writes made without them look foreign and
   * are undone at the next full check (fail closed, and the owner sees them listed).
   */
  #guardTriggers(): void {
    const n = (
      this.#db.sqlite
        .prepare(
          "SELECT count(*) AS n FROM sqlite_temp_master WHERE type = 'trigger' AND name GLOB 'psyche_seal_*'",
        )
        .get() as { n: number }
    ).n;
    if (n === this.#triggerCount) return;
    this.#o.log?.log("error", "security seal triggers were missing; reinstalled", { found: n });
    this.#install();
    this.#dv = -1;
  }

  #install(): void {
    const sqlite = this.#db.sqlite;
    // Changing temp_store drops every TEMP object; the search index sets MEMORY on this
    // connection too, which is then a no-op.
    if (sqlite.pragma("temp_store", { simple: true }) !== 2) sqlite.pragma("temp_store = MEMORY");
    sqlite.function(MAC_FN, { deterministic: true }, (tbl, pk, row) =>
      macOf(this.#key, String(tbl), String(pk), String(row)),
    );
    sqlite.function(FOLD_FN, { deterministic: true }, (agg, mac) =>
      agg === null || mac === null ? agg : foldOf(this.#key, String(agg), String(mac)),
    );
    sqlite.function(SEALED_SETTING_FN, { deterministic: true }, (key) =>
      isSealedSettingKey(String(key)) ? 1 : 0,
    );
    const ddl: string[] = [
      `CREATE TEMP TRIGGER IF NOT EXISTS psyche_seal_ledger_ai AFTER INSERT ON security_ledger
       BEGIN UPDATE security_seal SET agg = ${FOLD_FN}(agg, NEW.mac) WHERE id = 1; END`,
      `CREATE TEMP TRIGGER IF NOT EXISTS psyche_seal_ledger_ad AFTER DELETE ON security_ledger
       BEGIN UPDATE security_seal SET agg = ${FOLD_FN}(agg, OLD.mac) WHERE id = 1; END`,
      `CREATE TEMP TRIGGER IF NOT EXISTS psyche_seal_ledger_au AFTER UPDATE ON security_ledger
       BEGIN UPDATE security_seal SET agg = ${FOLD_FN}(${FOLD_FN}(agg, OLD.mac), NEW.mac) WHERE id = 1; END`,
    ];
    for (const spec of SEALED_TABLES) {
      const t = spec.table;
      const upsert = (p: string) =>
        `INSERT INTO security_ledger (tbl, pk, row, mac)
         VALUES ('${t}', ${pkExpr(spec, p)}, ${rowJson(spec, p)}, ${MAC_FN}('${t}', ${pkExpr(spec, p)}, ${rowJson(spec, p)}))
         ON CONFLICT (tbl, pk) DO UPDATE SET row = excluded.row, mac = excluded.mac;`;
      const drop = (p: string) =>
        `DELETE FROM security_ledger WHERE tbl = '${t}' AND pk = ${pkExpr(spec, p)};`;
      const cols = spec.columns.join(", ");
      ddl.push(
        `CREATE TEMP TRIGGER IF NOT EXISTS psyche_seal_${t}_ai AFTER INSERT ON ${t}
         WHEN ${whereExpr(spec, "NEW.")} BEGIN ${upsert("NEW.")} END`,
        `CREATE TEMP TRIGGER IF NOT EXISTS psyche_seal_${t}_au_old AFTER UPDATE OF ${cols} ON ${t}
         WHEN (${whereExpr(spec, "OLD.")}) AND (NOT (${whereExpr(spec, "NEW.")}) OR ${pkExpr(spec, "OLD.")} IS NOT ${pkExpr(spec, "NEW.")})
         BEGIN ${drop("OLD.")} END`,
        `CREATE TEMP TRIGGER IF NOT EXISTS psyche_seal_${t}_au_new AFTER UPDATE OF ${cols} ON ${t}
         WHEN ${whereExpr(spec, "NEW.")} BEGIN ${upsert("NEW.")} END`,
        `CREATE TEMP TRIGGER IF NOT EXISTS psyche_seal_${t}_ad AFTER DELETE ON ${t}
         WHEN ${whereExpr(spec, "OLD.")} BEGIN ${drop("OLD.")} END`,
      );
    }
    for (const sql of ddl) sqlite.exec(sql);
    this.#triggerCount = ddl.length;
  }

  /** Fills the ledger from the current rows (the triggers fold each entry into `agg`). */
  #populate(): void {
    for (const spec of SEALED_TABLES) {
      this.#db.sqlite
        .prepare(
          `INSERT INTO security_ledger (tbl, pk, row, mac)
           SELECT '${spec.table}', pk, row, ${MAC_FN}('${spec.table}', pk, row) FROM (
             SELECT ${pkExpr(spec, "t.")} AS pk, ${rowJson(spec, "t.")} AS row
             FROM main.${spec.table} AS t WHERE ${whereExpr(spec, "t.")})`,
        )
        .run();
    }
  }

  #sealRow(): SealRow | undefined {
    return this.#db.sqlite
      .prepare("SELECT format, key_id, agg, state FROM security_seal WHERE id = 1")
      .get() as SealRow | undefined;
  }

  async #boot(keyExisted: boolean): Promise<void> {
    const row = this.#sealRow();
    if (this.#o.restored === true) {
      this.reseal("restored");
      this.alerts.add("state_resealed", { restored: true });
      return;
    }
    if (row === undefined) {
      let sealedBefore = keyExisted;
      if (!sealedBefore && this.#o.audit !== undefined) {
        try {
          sealedBefore =
            (await this.#o.audit.list({ kind: SEALED_AUDIT_KIND, limit: 1 })).length > 0;
        } catch {
          sealedBefore = false;
        }
      }
      if (sealedBefore) {
        // The key (or the audit log) says this Gateway sealed before: a missing seal is a reset.
        const at = this.#now().toISOString();
        this.#db.sqlite
          .prepare(
            "INSERT INTO security_seal (id, format, key_id, agg, state, sealed_at, updated_at) VALUES (1, ?, ?, ?, ?, ?, ?)",
          )
          .run(SEAL_FORMAT, sealKeyId(this.#key), ZERO, "untrusted:seal_missing", at, at);
        this.#markUntrusted(keyExisted ? "seal_missing" : "seal_reset", []);
        return;
      }
      this.#firstSeal();
      return;
    }
    if (row.key_id !== sealKeyId(this.#key)) {
      this.#markUntrusted("key_changed", []);
      return;
    }
    if (row.format !== SEAL_FORMAT) {
      this.#markUntrusted("format_unknown", []);
      return;
    }
    if (row.state.startsWith("untrusted:")) {
      const reason = row.state.slice("untrusted:".length) as UntrustedReason;
      this.#untrusted = reason;
      // The alert stays until a re-seal; put one back if it is gone.
      if (!this.alerts.open().some((a) => a.kind === "state_untrusted")) {
        this.alerts.add("state_untrusted", { reason });
      }
      return;
    }
    this.#verify("boot");
  }

  #firstSeal(): void {
    const at = this.#now().toISOString();
    this.#db.sqlite.transaction(() => {
      this.#db.sqlite
        .prepare(
          "INSERT INTO security_seal (id, format, key_id, agg, state, sealed_at, updated_at) VALUES (1, ?, ?, ?, 'sealed', ?, ?)",
        )
        .run(SEAL_FORMAT, sealKeyId(this.#key), ZERO, at, at);
      this.#db.sqlite.prepare("DELETE FROM security_ledger").run();
      this.#db.sqlite.prepare("UPDATE security_seal SET agg = ? WHERE id = 1").run(ZERO);
      this.#populate();
    })();
    this.#audit(SEALED_AUDIT_KIND, { first: true, keyId: sealKeyId(this.#key) });
    const counts = this.counts();
    // A fresh install has nothing to review; an upgrade with paired devices gets one notice.
    if (counts.devices > 0) this.alerts.add("state_first_seal", counts);
  }

  #check(): CheckResult {
    const row = this.#sealRow();
    if (row === undefined)
      return { sealPresent: false, keyMatches: false, ledgerOk: false, changes: [] };
    if (row.key_id !== sealKeyId(this.#key)) {
      return { sealPresent: true, keyMatches: false, ledgerOk: false, changes: [] };
    }
    const entries = this.#db.sqlite
      .prepare("SELECT tbl, pk, row, mac FROM security_ledger")
      .all() as { tbl: string; pk: string; row: string; mac: string }[];
    let agg = ZERO;
    let forged = false;
    const authentic = new Map<string, string>();
    for (const e of entries) {
      agg = foldOf(this.#key, agg, e.mac);
      if (sameHex(macOf(this.#key, e.tbl, e.pk, e.row), e.mac)) {
        authentic.set(`${e.tbl}\0${e.pk}`, e.row);
      } else {
        forged = true;
      }
    }
    const ledgerOk = !forged && sameHex(agg, row.agg);
    const changes: SealChange[] = [];
    for (const spec of SEALED_TABLES) {
      const rows = this.#db.sqlite
        .prepare(
          `SELECT ${pkExpr(spec, "t.")} AS pk, ${rowJson(spec, "t.")} AS row
           FROM main.${spec.table} AS t WHERE ${whereExpr(spec, "t.")}`,
        )
        .all() as { pk: string; row: string }[];
      const seen = new Set<string>();
      for (const r of rows) {
        const k = `${spec.table}\0${r.pk}`;
        seen.add(k);
        const sealed = authentic.get(k);
        if (sealed === undefined) changes.push({ spec, pk: r.pk, change: "added", current: r.row });
        else if (sealed !== r.row) {
          changes.push({ spec, pk: r.pk, change: "modified", sealed, current: r.row });
        }
      }
      for (const [k, sealed] of authentic) {
        const [tbl, pk] = k.split("\0") as [string, string];
        if (tbl === spec.table && !seen.has(k)) {
          changes.push({ spec, pk, change: "removed", sealed });
        }
      }
    }
    return { sealPresent: true, keyMatches: true, ledgerOk, changes };
  }

  #verify(when: "boot" | "runtime"): void {
    if (this.#untrusted === "key_changed") return;
    const r = this.#check();
    if (!r.sealPresent) {
      this.#markUntrusted("seal_missing", []);
      return;
    }
    if (!r.keyMatches) {
      this.#markUntrusted("key_changed", []);
      return;
    }
    if (r.changes.length > 0) {
      try {
        this.#repair(r.changes);
      } catch (err) {
        this.#o.log?.log("error", "security state repair failed", {
          message: err instanceof Error ? err.message : String(err),
        });
        this.#markUntrusted("repair_failed", r.changes);
        return;
      }
    }
    if (!r.ledgerOk) {
      this.#markUntrusted("ledger_mismatch", r.changes);
      return;
    }
    if (r.changes.length > 0) {
      const details = changeDetails(r.changes);
      this.#audit("security.state.repaired", { when, ...details });
      this.#o.log?.log("warn", "security state changed outside the Gateway; restored", {
        when,
        changes: r.changes.length,
      });
      this.alerts.add("state_changed_outside", details);
    }
  }

  #markUntrusted(reason: UntrustedReason, changes: SealChange[]): void {
    const first = this.#untrusted === null;
    this.#untrusted = reason;
    this.#db.sqlite
      .prepare("UPDATE security_seal SET state = ?, updated_at = ? WHERE id = 1")
      .run(`untrusted:${reason}`, this.#now().toISOString());
    if (!first) return;
    const details: AlertDetails = { reason, ...(changes.length > 0 ? changeDetails(changes) : {}) };
    this.#audit("security.state.untrusted", details);
    this.#o.log?.log("error", "security state untrusted", { reason });
    this.alerts.add("state_untrusted", details);
  }

  /** Puts the sealed state back, in one transaction (triggers keep the ledger in step). */
  #repair(changes: SealChange[]): void {
    const at = this.#now().toISOString();
    const sqlite = this.#db.sqlite;
    const revokedDevices: string[] = [];
    sqlite.transaction(() => {
      // Additions first (they may hold a unique value a restored row needs), then the rest in
      // dependency order (SEALED_TABLES is ordered parents first).
      for (const c of changes.filter((x) => x.change === "added")) {
        const { spec, pk } = c;
        switch (spec.added) {
          case "revoke_device":
            sqlite
              .prepare(
                "UPDATE devices SET revoked_at = COALESCE(revoked_at, ?), token_hash = NULL, scopes = '[]', updated_at = ? WHERE id = ?",
              )
              .run(at, at, pk);
            revokedDevices.push(pk);
            break;
          case "revoke_grant":
            sqlite
              .prepare(
                "UPDATE grants SET revoked_at = COALESCE(revoked_at, ?), revoked_reason = COALESCE(revoked_reason, 'state_tampered'), updated_at = ? WHERE id = ?",
              )
              .run(at, at, pk);
            break;
          case "revoke_setup_token":
            sqlite
              .prepare("UPDATE setup_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?")
              .run(at, pk);
            break;
          case "invalidate_approval":
            sqlite
              .prepare(
                "UPDATE approvals SET status = 'invalidated', invalidated_reason = 'state_tampered', updated_at = ? WHERE id = ?",
              )
              .run(at, pk);
            break;
          case "delete":
            sqlite.prepare(`DELETE FROM main.${spec.table} WHERE ${spec.pk} = ?`).run(pk);
            break;
        }
      }
      for (const c of changes.filter((x) => x.change !== "added")) {
        const values = decodeRow(c.spec, c.sealed as string);
        const cols = c.spec.columns;
        if (c.change === "modified") {
          sqlite
            .prepare(
              `UPDATE main.${c.spec.table} SET ${cols.map((col) => `${col} = ?`).join(", ")} WHERE ${c.spec.pk} = ?`,
            )
            .run(...cols.map((col) => values[col]), c.pk);
        } else {
          sqlite
            .prepare(
              `INSERT INTO main.${c.spec.table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
            )
            .run(...cols.map((col) => values[col]));
        }
      }
    })();
    // A device that appeared outside Psyche is revoked for good, like any revocation (design-26).
    for (const id of revokedDevices) {
      try {
        this.#ledger.recordDevice(id);
      } catch {
        // the database revocation stands; the ledger is a backstop for restores
      }
    }
    if (revokedDevices.length > 0) {
      for (const l of this.#revokedListeners) {
        try {
          l(revokedDevices);
        } catch {
          // closing connections is best effort; the device row is revoked
        }
      }
    }
  }

  #audit(kind: string, data: Record<string, unknown>): void {
    void this.#o.audit
      ?.append({ kind, actor: { type: "system" }, data: data as never })
      .catch(() => undefined);
  }
}

/** Sealed JSON back to bindable values (blobs from hex). */
function decodeRow(spec: SealedTable, json: string): Record<string, unknown> {
  const obj = JSON.parse(json) as Record<string, unknown>;
  for (const b of spec.blobs ?? []) {
    const v = obj[b];
    obj[b] = typeof v === "string" ? Buffer.from(v, "hex") : null;
  }
  return obj;
}

function labelOf(c: SealChange): string | undefined {
  const json = c.current ?? c.sealed;
  if (json === undefined) return undefined;
  try {
    const v = (JSON.parse(json) as Record<string, unknown>)[c.spec.label];
    return v === null || v === undefined ? undefined : String(v).slice(0, 120);
  } catch {
    return undefined;
  }
}

function changeDetails(changes: SealChange[]): AlertDetails {
  const listed = changes.slice(0, MAX_LISTED_CHANGES).map((c) => {
    const name = labelOf(c);
    return { table: c.spec.table, change: c.change, ...(name === undefined ? {} : { name }) };
  });
  const more = changes.length - listed.length;
  return { changes: listed, ...(more > 0 ? { more } : {}) };
}

export type { SecurityAlert };
