import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { openDb, type PsycheDb, setReadGuard } from "@psyche/db";
import { RevocationLedger } from "@psyche/permissions";
import { type AuditLog, type Device, PsycheError, type SecurityAlert } from "@psyche/protocol";
import type { Logger } from "../log.ts";
import { AlertBook, type AlertDetails } from "./alerts.ts";
import {
  isSealedSettingKey,
  pkExpr,
  rowJson,
  SCHEMA_GUARDED_TABLES,
  SEAL_FORMAT,
  SEALED_SETTING_FN,
  SEALED_TABLES,
  type SealedTable,
  whereExpr,
} from "./seal-spec.ts";

/**
 * The security-state seal (docs/design/security-state-integrity-2026.md §7.1).
 *
 * Two copies of the truth, and the database file only half of it:
 * - **On disk**, `security_ledger` keeps every sealed row's canonical JSON with
 *   `HMAC(K, tbl‖pk‖row)`. `security_seal` keeps `agg` (a keyed start value XOR a keyed value per
 *   entry), `gen` (bumped by every ledger change) and its own `mac` over all of that, so neither
 *   the row nor the ledger can be edited, emptied or replayed without `K`. TEMP triggers on the
 *   Gateway's connection maintain both, through functions registered here as direct-only: a
 *   trigger planted in the main schema cannot call them.
 * - **In memory**, `#shadow` is what the Gateway itself last committed (built at a trusted check,
 *   kept current from its own writes). Nothing outside the process can touch it. During a run it
 *   is the authority: repairs come from it, untrusted-state authorization reads it, and BEFORE
 *   triggers refuse a Gateway write whose old row is not the one in it (so the Gateway never
 *   seals a change somebody else made).
 *
 * `ensure()` runs before every authorizing read (connect, dispatch, settings and device reads,
 * the broker's store, presence, channels): three cached pragmas, plus a full check after another
 * connection committed, after a schema change, and at least every 30 seconds.
 *
 * What it is not: protection against a program that reads `security/state-seal-key.json` or runs
 * code as `psyched` (design §4, decisions D1/D3).
 */

export const SEAL_KEY_FILE = join("security", "state-seal-key.json");
/** The audit kind of a seal being made; its presence later means a missing seal is a reset. */
export const SEALED_AUDIT_KIND = "security.state.sealed";
/** Full check at least this often, even with no commit seen (raw file edits, page caches). */
export const FULL_CHECK_MS = 30_000;
const MAX_LISTED_CHANGES = 20;

const MAC_FN = "psyche_seal_mac";
const FOLD_FN = "psyche_seal_fold";
const SEALMAC_FN = "psyche_seal_rowmac";
const NOTE_FN = "psyche_seal_note";
const GUARD_FN = "psyche_seal_guard";
const TRIGGER_PREFIX = "psyche_seal_";

export type UntrustedReason =
  | "seal_missing"
  | "seal_reset"
  | "seal_forged"
  | "key_changed"
  | "key_corrupt"
  | "ledger_mismatch"
  | "rollback"
  | "schema_tampered"
  | "restore_unverified"
  | "format_unknown"
  | "repair_failed";

// -- the key file ---------------------------------------------------------------------------

interface KeyFile {
  v: 1;
  key: string;
  createdAt: string;
  /** Presence (a Touch ID key or a passkey) could verify once: no first-admin shortcut since. */
  presenceEnrolledAt?: string;
  /** The seal's `gen` at the last clean stop: a database that starts lower was rolled back. */
  generation?: number;
}

function writeKeyFile(path: string, file: KeyFile): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(file)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

/** Reads the key file; one that does not parse is moved aside (never deleted) and replaced. */
function loadKeyFile(
  path: string,
  now: Date,
): { file: KeyFile; existed: boolean; corrupt: boolean } {
  if (existsSync(path)) {
    try {
      const file = JSON.parse(readFileSync(path, "utf8")) as KeyFile;
      const key = Buffer.from(String(file.key ?? ""), "base64");
      if (file.v === 1 && key.length === 32) return { file, existed: true, corrupt: false };
    } catch {
      // falls through: corrupt
    }
    renameSync(path, `${path}.corrupt-${now.getTime()}`);
    const file: KeyFile = {
      v: 1,
      key: randomBytes(32).toString("base64"),
      createdAt: now.toISOString(),
    };
    writeKeyFile(path, file);
    return { file, existed: true, corrupt: true };
  }
  const file: KeyFile = {
    v: 1,
    key: randomBytes(32).toString("base64"),
    createdAt: now.toISOString(),
  };
  writeKeyFile(path, file);
  return { file, existed: false, corrupt: false };
}

export function sealKeyId(key: Buffer): string {
  return createHash("sha256")
    .update("psyche-state-seal-key-id\0")
    .update(key)
    .digest("hex")
    .slice(0, 32);
}

function hmac(key: Buffer, text: string): string {
  return createHmac("sha256", key).update(text).digest("hex");
}

function macOf(key: Buffer, tbl: string, pk: string, row: string): string {
  return hmac(key, `row\0${tbl}\0${pk}\0${row}`);
}

function foldOf(key: Buffer, agg: string, mac: string): string {
  const contrib = createHmac("sha256", key).update(`agg\0${mac}`).digest();
  const out = Buffer.from(agg, "hex");
  for (let i = 0; i < out.length; i++) out[i] = (out[i] as number) ^ (contrib[i] as number);
  return out.toString("hex");
}

function sealRowMac(
  key: Buffer,
  r: { format: number; key_id: string; agg: string; gen: number; state: string },
): string {
  return hmac(key, `seal\0${r.format}\0${r.key_id}\0${r.agg}\0${r.gen}\0${r.state}`);
}

function sameHex(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

const keyOf = (tbl: string, pk: string) => `${tbl}\0${pk}`;

/** The parts of a better-sqlite3 statement the seal uses (cached per SQL text). */
interface Stmt {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  pluck(): Stmt;
}

// -- the reference schema --------------------------------------------------------------------

type ColumnInfo = { name: string; type: string; notnull: number; dflt_value: unknown; pk: number };
let referenceColumns: Map<string, string> | undefined;

/** Sealed tables' column definitions as this build's migrations make them (built once). */
function referenceSchema(): Map<string, string> {
  if (referenceColumns !== undefined) return referenceColumns;
  const ref = openDb(":memory:");
  try {
    referenceColumns = new Map(
      SCHEMA_GUARDED_TABLES.map((t) => [t, columnsOf(ref.sqlite, t)] as const),
    );
  } finally {
    ref.close();
  }
  return referenceColumns;
}

function columnsOf(sqlite: PsycheDb["sqlite"], table: string): string {
  const info = sqlite.pragma(`table_xinfo(${table})`) as (ColumnInfo & { hidden: number })[];
  return JSON.stringify(
    info.map((c) => [c.name, c.type.toUpperCase(), c.notnull, c.dflt_value, c.pk, c.hidden]),
  );
}

/** A trigger or view another program could have planted: it names security state. */
const SECURITY_NAMES = new RegExp(
  `\\b(${[...SCHEMA_GUARDED_TABLES, "nodes", "_migrations"].join("|")}|security_\\w+|sqlite_\\w+)\\b`,
  "i",
);

// -- the seal --------------------------------------------------------------------------------

/** One row whose current state differs from the authoritative one. */
export interface SealChange {
  spec: SealedTable;
  pk: string;
  change: "added" | "modified" | "removed";
  /** The authoritative canonical JSON (modified, removed). */
  sealed?: string;
  /** The current canonical JSON (added, modified). */
  current?: string;
}

interface SealRow {
  format: number;
  key_id: string;
  agg: string;
  state: string;
  gen: number;
  mac: string;
}

interface LedgerCheck {
  row: SealRow | undefined;
  rowMacOk: boolean;
  keyMatches: boolean;
  /** The ledger verifies: seal row MAC, every entry, the aggregate, no rollback. */
  ok: boolean;
  /** Authentic entries by key. */
  entries: Map<string, string>;
}

export interface StateSealOptions {
  home: string;
  now?: () => Date;
  log?: Logger;
  /** Earlier seals are recorded here; `list` tells a first seal from a reset. */
  audit?: Pick<AuditLog, "append" | "list">;
  /** A restored backup is starting (`security/restored.json`). */
  restored?: boolean;
}

export interface SealStatus {
  status: "sealed" | "untrusted";
  reason: UntrustedReason | null;
}

/** What a device may do now. */
export type DeviceAuthorization = { ok: true; scopes: Device["scopes"] } | { ok: false };

const SEALS = new WeakMap<PsycheDb["sqlite"], StateSeal>();

/** The seal attached to this connection, if any. */
export function stateSealFor(db: PsycheDb): StateSeal | undefined {
  return SEALS.get(db.sqlite);
}

/** `ensure()` on the connection's seal; a no-op for a connection without one. */
export function ensureSecurityState(db: PsycheDb): void {
  SEALS.get(db.sqlite)?.ensure();
}

const READ_CAP = new Set<string>(["operator.read", "node"]);

export class StateSeal {
  readonly alerts: AlertBook;
  readonly #db: PsycheDb;
  readonly #o: StateSealOptions;
  readonly #now: () => Date;
  readonly #ledger: RevocationLedger;
  readonly #keyPath: string;
  #keyFile: KeyFile;
  #key: Buffer;
  #keyId: string;
  #untrusted: UntrustedReason | null = null;
  /** The authoritative rows of this run (see the class comment). */
  #shadow = new Map<string, string>();
  /** The shadow covers every sealed row (false while untrusted since boot). */
  #shadowComplete = false;
  /**
   * Untrusted since boot: the rows that were there then. A Gateway write to one of them (a device
   * family pinned at connect) does not make it genuine.
   */
  #bootKeys: Set<string> | null = null;
  /** Keys the Gateway wrote since the shadow was last brought up to date. */
  readonly #dirty = new Set<string>();
  /** The highest committed `gen` this run has seen. */
  #highGen = 0;
  #dv = -1;
  #msv = -1;
  #tsv = -1;
  #lastFull = 0;
  #triggerCount = 0;
  #busy = false;
  #repairing = false;
  readonly #stmts = new Map<string, Stmt>();
  readonly #revokedListeners = new Set<(deviceIds: string[]) => void>();
  readonly #changeListeners = new Set<() => void>();

  private constructor(db: PsycheDb, keyFile: KeyFile, keyPath: string, o: StateSealOptions) {
    this.#db = db;
    this.#o = o;
    this.#now = o.now ?? (() => new Date());
    this.#keyFile = keyFile;
    this.#keyPath = keyPath;
    this.#key = Buffer.from(keyFile.key, "base64");
    this.#keyId = sealKeyId(this.#key);
    this.#ledger = new RevocationLedger(o.home, () => this.#now().toISOString());
    // An alert that cannot be read back right after it was written: something deletes them.
    this.alerts = new AlertBook(db, this.#now, () => {
      this.#dv = -1;
    });
    this.alerts.onAlert(() => this.#changed());
  }

  /**
   * Installs the seal on the connection and checks it: a first seal, a verified restore, or a
   * verification that repairs what changed while the Gateway was not running.
   */
  static async open(db: PsycheDb, o: StateSealOptions): Promise<StateSeal> {
    const now = o.now ?? (() => new Date());
    const keyPath = join(o.home, SEAL_KEY_FILE);
    const { file, existed, corrupt } = loadKeyFile(keyPath, now());
    const seal = new StateSeal(db, file, keyPath, o);
    seal.#install();
    SEALS.set(db.sqlite, seal);
    setReadGuard(db, {
      check: () => seal.ensure(),
      setting: (key, stored) => seal.#settingValue(key, stored),
    });
    seal.#busy = true;
    try {
      await seal.#boot(existed, corrupt);
      if (!seal.#shadowComplete) seal.#bootKeys = new Set(seal.#rows().keys());
    } finally {
      seal.#busy = false;
    }
    seal.#dv = seal.#pluck("PRAGMA data_version");
    seal.#msv = seal.#pluck("PRAGMA main.schema_version");
    seal.#tsv = seal.#pluck("PRAGMA temp.schema_version");
    seal.#lastFull = seal.#now().getTime();
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

  /** A Touch ID key or a passkey could verify once (kept outside the database, D8). */
  presenceEverEnrolled(): boolean {
    return this.#keyFile.presenceEnrolledAt !== undefined;
  }

  notePresenceEnrolled(): void {
    if (this.#keyFile.presenceEnrolledAt !== undefined) return;
    this.#keyFile = { ...this.#keyFile, presenceEnrolledAt: this.#now().toISOString() };
    try {
      writeKeyFile(this.#keyPath, this.#keyFile);
    } catch (err) {
      this.#o.log?.log("warn", "could not record presence enrollment", {
        message: err instanceof Error ? err.message : String(err),
      });
    }
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

  changed(): void {
    this.#changed();
  }

  /**
   * Before an authorizing read. Cheap unless another connection committed, the schema changed, or
   * 30 seconds passed: then a full check, which repairs from the shadow. Inside an open transaction
   * it cannot repair; it refuses the call when something changed.
   */
  ensure(): void {
    if (this.#busy) return;
    const sqlite = this.#db.sqlite;
    const tsv = this.#pluck("PRAGMA temp.schema_version");
    if (tsv !== this.#tsv) {
      this.#tsv = tsv;
      this.#guardTriggers();
    }
    const dv = this.#pluck("PRAGMA data_version");
    const msv = this.#pluck("PRAGMA main.schema_version");
    const foreign = dv !== this.#dv;
    if (sqlite.inTransaction) {
      if (!foreign && msv === this.#msv) return;
      if ((foreign && msv !== this.#msv) || this.#readOnlyProblem()) {
        throw new PsycheError(
          "unavailable",
          "Psyche's security records changed outside the app; try again in a moment",
          { retryable: true, details: { reason: "security_state_changed" } },
        );
      }
      return;
    }
    this.#busy = true;
    try {
      if (msv !== this.#msv) {
        this.#schemaCheck();
        this.#msv = this.#pluck("PRAGMA main.schema_version");
      }
      if (foreign) {
        this.#dv = dv;
        this.#verify("runtime");
      } else {
        if (this.#dirty.size > 0) this.#resolve();
        if (this.#now().getTime() - this.#lastFull >= FULL_CHECK_MS) this.#verify("periodic");
      }
    } finally {
      this.#busy = false;
    }
  }

  /**
   * Seals the current state as it is (the owner's re-seal recovery, after 24 hours). Clears an
   * untrusted state. The key file is kept.
   */
  reseal(reason: "recovery"): void {
    const at = this.#now().toISOString();
    this.#repairing = true;
    try {
      this.#db.sqlite.transaction(() => {
        this.#db.sqlite.prepare("DELETE FROM security_ledger").run();
        this.#writeSeal({ agg: this.#aggInit(), gen: 0, state: "sealed", sealedAt: at });
        this.#populate();
      })();
    } finally {
      this.#repairing = false;
    }
    this.#untrusted = null;
    this.#snapshot();
    this.#audit(SEALED_AUDIT_KIND, { first: false, reason, keyId: this.#keyId });
    this.#changed();
  }

  /** Records the seal's generation in the key file at a clean stop (rollback detection, H5). */
  close(): void {
    if (this.#untrusted !== null) return;
    try {
      this.#resolve();
      const gen = this.#sealRow()?.gen;
      if (gen !== undefined && gen !== this.#keyFile.generation) {
        this.#keyFile = { ...this.#keyFile, generation: gen };
        writeKeyFile(this.#keyPath, this.#keyFile);
      }
    } catch {
      // best effort: a missing record only weakens rollback detection
    }
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

  // -- authorization while untrusted ------------------------------------------------------

  /**
   * What a paired device may do. Sealed: its own scopes. Untrusted with a shadow from this run:
   * only what the shadow says (a device added or widened since is refused or narrowed). Untrusted
   * since boot (nothing is known to be genuine): read-only at most, which gives a same-user
   * program nothing it could not read from the files anyway.
   */
  authorizeDevice(device: Pick<Device, "id" | "publicKey" | "scopes">): DeviceAuthorization {
    if (this.#untrusted === null) return { ok: true, scopes: device.scopes };
    const s = this.#shadow.get(keyOf("devices", device.id));
    if (s === undefined) {
      if (this.#shadowComplete) return { ok: false };
      return { ok: true, scopes: device.scopes.filter((x) => READ_CAP.has(x)) };
    }
    const sealed = JSON.parse(s) as { public_key: string; scopes: string; revoked_at: unknown };
    const key = Buffer.from(device.publicKey, "base64url").toString("hex").toUpperCase();
    if (sealed.revoked_at !== null || sealed.public_key !== key) return { ok: false };
    const allowed = new Set(JSON.parse(sealed.scopes) as string[]);
    return { ok: true, scopes: device.scopes.filter((x) => allowed.has(x)) };
  }

  /** The row as it is now is genuine (always true while sealed). */
  rowTrusted(table: string, pk: string): boolean {
    if (this.#untrusted === null) return true;
    const k = keyOf(table, pk);
    const s = this.#shadow.get(k);
    if (s === undefined) return false;
    const spec = SEALED_TABLES.find((t) => t.table === table);
    if (spec === undefined) return true;
    return this.#currentRow(spec, pk) === s;
  }

  /**
   * Like `rowTrusted`, but rows the seal cannot judge (untrusted since boot: nothing is known to
   * be genuine) are taken as stored. For state that must keep working then (channels).
   */
  rowAcceptable(table: string, pk: string): boolean {
    if (this.#untrusted === null) return true;
    const k = keyOf(table, pk);
    if (!this.#shadowComplete && !this.#shadow.has(k)) return true;
    return this.rowTrusted(table, pk);
  }

  #settingValue(key: string, stored: string | undefined): string | undefined {
    if (this.#untrusted === null || !isSealedSettingKey(key)) return stored;
    const s = this.#shadow.get(keyOf("settings", key));
    if (s === undefined) return this.#shadowComplete ? undefined : stored;
    return (JSON.parse(s) as { value: string }).value;
  }

  // -- internals --------------------------------------------------------------------------

  #changed(): void {
    for (const l of this.#changeListeners) {
      try {
        l();
      } catch {
        // listeners never break the seal
      }
    }
  }

  #stmt(sql: string): Stmt {
    let s = this.#stmts.get(sql);
    if (s === undefined) {
      s = this.#db.sqlite.prepare(sql) as unknown as Stmt;
      this.#stmts.set(sql, s);
    }
    return s;
  }

  #pluck(sql: string): number {
    return this.#stmt(sql).pluck().get() as number;
  }

  #aggInit(): string {
    return hmac(this.#key, `agg-init\0${this.#keyId}`);
  }

  #install(): void {
    const sqlite = this.#db.sqlite;
    // Changing temp_store drops every TEMP object; the search index sets MEMORY on this
    // connection too, which is then a no-op. Untrusted schema objects run no unsafe function.
    if (sqlite.pragma("temp_store", { simple: true }) !== 2) sqlite.pragma("temp_store = MEMORY");
    sqlite.pragma("trusted_schema = OFF");
    const direct = { deterministic: true, directOnly: true } as const;
    sqlite.function(MAC_FN, direct, (tbl, pk, row) =>
      macOf(this.#key, String(tbl), String(pk), String(row)),
    );
    sqlite.function(FOLD_FN, direct, (agg, mac) =>
      agg === null || mac === null ? agg : foldOf(this.#key, String(agg), String(mac)),
    );
    sqlite.function(SEALMAC_FN, direct, (format, keyId, agg, gen, state) =>
      sealRowMac(this.#key, {
        format: Number(format),
        key_id: String(keyId),
        agg: String(agg),
        gen: Number(gen),
        state: String(state),
      }),
    );
    sqlite.function(SEALED_SETTING_FN, direct, (key) => (isSealedSettingKey(String(key)) ? 1 : 0));
    sqlite.function(NOTE_FN, { directOnly: true }, (tbl, pk) => {
      this.#dirty.add(keyOf(String(tbl), String(pk)));
      return 0;
    });
    // 1: the Gateway may write this row; 0: its old state is not the genuine one (abort). An
    // insert asks only when no row has that key (an upsert of an existing row is an update).
    sqlite.function(GUARD_FN, { directOnly: true }, (tbl, pk, old) => {
      if (this.#repairing || !this.#shadowComplete) return 1;
      const k = keyOf(String(tbl), String(pk));
      if (this.#dirty.has(k)) return 1;
      const s = this.#shadow.get(k);
      if (old === null) return s === undefined ? 1 : 0;
      return s === String(old) ? 1 : 0;
    });
    const fold = (agg: string, mac: string) => `${FOLD_FN}(${agg}, ${mac})`;
    const sealUpdate = (aggExpr: string) =>
      `UPDATE security_seal SET agg = ${aggExpr}, gen = gen + 1,
         mac = ${SEALMAC_FN}(format, key_id, ${aggExpr}, gen + 1, state) WHERE id = 1;`;
    const ddl: string[] = [
      `CREATE TEMP TRIGGER IF NOT EXISTS ${TRIGGER_PREFIX}ledger_ai AFTER INSERT ON security_ledger
       BEGIN ${sealUpdate(fold("agg", "NEW.mac"))} END`,
      `CREATE TEMP TRIGGER IF NOT EXISTS ${TRIGGER_PREFIX}ledger_ad AFTER DELETE ON security_ledger
       BEGIN ${sealUpdate(fold("agg", "OLD.mac"))} END`,
      `CREATE TEMP TRIGGER IF NOT EXISTS ${TRIGGER_PREFIX}ledger_au AFTER UPDATE ON security_ledger
       BEGIN ${sealUpdate(fold(fold("agg", "OLD.mac"), "NEW.mac"))} END`,
    ];
    const abort = `SELECT RAISE(ABORT, 'psyche seal: this security record was changed outside Psyche');`;
    for (const spec of SEALED_TABLES) {
      const t = spec.table;
      const pk = (p: string) => pkExpr(spec, p);
      const upsert = (p: string) =>
        `INSERT INTO security_ledger (tbl, pk, row, mac)
         VALUES ('${t}', ${pk(p)}, ${rowJson(spec, p)}, ${MAC_FN}('${t}', ${pk(p)}, ${rowJson(spec, p)}))
         ON CONFLICT (tbl, pk) DO UPDATE SET row = excluded.row, mac = excluded.mac;
         SELECT ${NOTE_FN}('${t}', ${pk(p)});`;
      const drop = (p: string) =>
        `DELETE FROM security_ledger WHERE tbl = '${t}' AND pk = ${pk(p)};
         SELECT ${NOTE_FN}('${t}', ${pk(p)});`;
      const cols = spec.columns.join(", ");
      ddl.push(
        `CREATE TEMP TRIGGER IF NOT EXISTS ${TRIGGER_PREFIX}${t}_bi BEFORE INSERT ON ${t}
         WHEN (${whereExpr(spec, "NEW.")})
           AND NOT EXISTS (SELECT 1 FROM ${t} WHERE ${spec.pk} = NEW.${spec.pk})
           AND ${GUARD_FN}('${t}', ${pk("NEW.")}, NULL) = 0
         BEGIN ${abort} END`,
        `CREATE TEMP TRIGGER IF NOT EXISTS ${TRIGGER_PREFIX}${t}_bu BEFORE UPDATE OF ${cols} ON ${t}
         WHEN (${whereExpr(spec, "OLD.")}) AND ${GUARD_FN}('${t}', ${pk("OLD.")}, ${rowJson(spec, "OLD.")}) = 0
         BEGIN ${abort} END`,
        `CREATE TEMP TRIGGER IF NOT EXISTS ${TRIGGER_PREFIX}${t}_bd BEFORE DELETE ON ${t}
         WHEN (${whereExpr(spec, "OLD.")}) AND ${GUARD_FN}('${t}', ${pk("OLD.")}, ${rowJson(spec, "OLD.")}) = 0
         BEGIN ${abort} END`,
        `CREATE TEMP TRIGGER IF NOT EXISTS ${TRIGGER_PREFIX}${t}_ai AFTER INSERT ON ${t}
         WHEN ${whereExpr(spec, "NEW.")} BEGIN ${upsert("NEW.")} END`,
        `CREATE TEMP TRIGGER IF NOT EXISTS ${TRIGGER_PREFIX}${t}_au_old AFTER UPDATE OF ${cols} ON ${t}
         WHEN (${whereExpr(spec, "OLD.")}) AND (NOT (${whereExpr(spec, "NEW.")}) OR ${pk("OLD.")} IS NOT ${pk("NEW.")})
         BEGIN ${drop("OLD.")} END`,
        `CREATE TEMP TRIGGER IF NOT EXISTS ${TRIGGER_PREFIX}${t}_au_new AFTER UPDATE OF ${cols} ON ${t}
         WHEN ${whereExpr(spec, "NEW.")} BEGIN ${upsert("NEW.")} END`,
        `CREATE TEMP TRIGGER IF NOT EXISTS ${TRIGGER_PREFIX}${t}_ad AFTER DELETE ON ${t}
         WHEN ${whereExpr(spec, "OLD.")} BEGIN ${drop("OLD.")} END`,
      );
    }
    for (const sql of ddl) sqlite.exec(sql);
    this.#triggerCount = ddl.length;
  }

  /**
   * The TEMP triggers die with the connection's temp schema. If they are gone, put them back and
   * treat the gap as foreign: the next full check repairs from the shadow.
   */
  #guardTriggers(): void {
    const n = this.#stmt(
      `SELECT count(*) FROM sqlite_temp_master WHERE type = 'trigger' AND name GLOB '${TRIGGER_PREFIX}*'`,
    )
      .pluck()
      .get() as number;
    if (n === this.#triggerCount) return;
    this.#o.log?.log("error", "security seal triggers were missing; reinstalled", { found: n });
    this.#install();
    this.#tsv = this.#pluck("PRAGMA temp.schema_version");
    this.#dv = -1;
  }

  /**
   * H1: a trigger or view in the main schema that names security state runs on the Gateway's own
   * connection and would be sealed with its writes. Drop it and stop trusting the state. Sealed
   * tables must have exactly this build's columns, defaults and keys.
   */
  #schemaCheck(): boolean {
    const sqlite = this.#db.sqlite;
    const objects = sqlite
      .prepare(
        "SELECT type, name, tbl_name, sql FROM main.sqlite_master WHERE type IN ('trigger', 'view')",
      )
      .all() as { type: string; name: string; tbl_name: string; sql: string | null }[];
    const planted = objects.filter((o) => SECURITY_NAMES.test(`${o.tbl_name} ${o.sql ?? ""}`));
    for (const o of planted) {
      try {
        sqlite.exec(
          `DROP ${o.type === "view" ? "VIEW" : "TRIGGER"} IF EXISTS main."${o.name.replace(/"/g, '""')}"`,
        );
      } catch (err) {
        this.#o.log?.log("error", "could not drop a planted schema object", {
          name: o.name,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
    const ref = referenceSchema();
    const altered = SCHEMA_GUARDED_TABLES.filter((t) => columnsOf(sqlite, t) !== ref.get(t));
    if (planted.length === 0 && altered.length === 0) return false;
    this.#o.log?.log("error", "security schema tampered", {
      planted: planted.map((o) => o.name).join(","),
      altered: altered.join(","),
    });
    this.#markUntrusted("schema_tampered", [], {
      changes: [
        ...planted.map((o) => ({
          table: o.tbl_name,
          change: "added" as const,
          name: `${o.type} ${o.name}`,
        })),
        ...altered.map((t) => ({ table: t, change: "modified" as const, name: "schema" })),
      ],
    });
    return true;
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
    return this.#stmt(
      "SELECT format, key_id, agg, state, gen, mac FROM security_seal WHERE id = 1",
    ).get() as SealRow | undefined;
  }

  /** Writes the seal row with its MAC (state changes, first seal, re-seal). */
  #writeSeal(f: { agg: string; gen: number; state: string; sealedAt?: string }): void {
    const at = this.#now().toISOString();
    const r = { format: SEAL_FORMAT, key_id: this.#keyId, agg: f.agg, gen: f.gen, state: f.state };
    this.#db.sqlite
      .prepare(
        `INSERT INTO security_seal (id, format, key_id, agg, state, gen, sealed_at, updated_at, mac)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET format = excluded.format, key_id = excluded.key_id,
           agg = excluded.agg, state = excluded.state, gen = excluded.gen,
           sealed_at = COALESCE(?, security_seal.sealed_at), updated_at = excluded.updated_at,
           mac = excluded.mac`,
      )
      .run(
        r.format,
        r.key_id,
        r.agg,
        r.state,
        r.gen,
        f.sealedAt ?? at,
        at,
        sealRowMac(this.#key, r),
        f.sealedAt ?? null,
      );
  }

  /** Every sealed row as it is now. */
  #rows(): Map<string, string> {
    const out = new Map<string, string>();
    for (const spec of SEALED_TABLES) {
      const rows = this.#stmt(
        `SELECT ${pkExpr(spec, "t.")} AS pk, ${rowJson(spec, "t.")} AS row
         FROM main.${spec.table} AS t WHERE ${whereExpr(spec, "t.")}`,
      ).all() as { pk: string; row: string }[];
      for (const r of rows) out.set(keyOf(spec.table, r.pk), r.row);
    }
    return out;
  }

  #currentRow(spec: SealedTable, pk: string): string | undefined {
    const r = this.#stmt(
      `SELECT ${rowJson(spec, "t.")} AS row FROM main.${spec.table} AS t
       WHERE ${spec.pk} = ? AND ${whereExpr(spec, "t.")}`,
    ).get(pk) as { row: string } | undefined;
    return r?.row;
  }

  #ledgerCheck(): LedgerCheck {
    const row = this.#sealRow();
    const entries = new Map<string, string>();
    if (row === undefined) return { row, rowMacOk: false, keyMatches: false, ok: false, entries };
    const keyMatches = row.key_id === this.#keyId;
    const rowMacOk = keyMatches && sameHex(sealRowMac(this.#key, row), row.mac);
    if (!rowMacOk) return { row, rowMacOk, keyMatches, ok: false, entries };
    let agg = this.#aggInit();
    let forged = false;
    const all = this.#stmt("SELECT tbl, pk, row, mac FROM security_ledger").all() as {
      tbl: string;
      pk: string;
      row: string;
      mac: string;
    }[];
    for (const e of all) {
      agg = foldOf(this.#key, agg, e.mac);
      if (sameHex(macOf(this.#key, e.tbl, e.pk, e.row), e.mac))
        entries.set(keyOf(e.tbl, e.pk), e.row);
      else forged = true;
    }
    const ok =
      !forged && sameHex(agg, row.agg) && row.format === SEAL_FORMAT && row.gen >= this.#highGen;
    return { row, rowMacOk, keyMatches, ok, entries };
  }

  /** Brings the shadow up to the Gateway's own committed writes (no foreign commit since). */
  #resolve(): void {
    for (const k of [...this.#dirty]) {
      const [tbl, pk] = k.split("\0") as [string, string];
      const spec = SEALED_TABLES.find((t) => t.table === tbl);
      const row = spec === undefined ? undefined : this.#currentRow(spec, pk);
      this.#dirty.delete(k);
      if (this.#bootKeys?.has(k) === true) continue;
      if (row === undefined) this.#shadow.delete(k);
      else this.#shadow.set(k, row);
    }
    const gen = this.#sealRow()?.gen;
    if (gen !== undefined && gen > this.#highGen) this.#highGen = gen;
  }

  /** After a trusted check: the shadow is exactly the rows. */
  #snapshot(): void {
    this.#shadow = this.#rows();
    this.#shadowComplete = true;
    this.#bootKeys = null;
    this.#dirty.clear();
    this.#highGen = this.#sealRow()?.gen ?? 0;
  }

  async #boot(keyExisted: boolean, keyCorrupt: boolean): Promise<void> {
    if (this.#schemaCheck()) return;
    const row = this.#sealRow();
    if (keyCorrupt) {
      this.#ensureSealRowUntrusted(row);
      this.#markUntrusted("key_corrupt", []);
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
      if (sealedBefore || this.#o.restored === true) {
        this.#ensureSealRowUntrusted(undefined);
        this.#markUntrusted(
          this.#o.restored === true
            ? "restore_unverified"
            : keyExisted
              ? "seal_missing"
              : "seal_reset",
          [],
        );
        return;
      }
      this.#firstSeal();
      return;
    }
    const check = this.#ledgerCheck();
    if (!check.keyMatches) {
      this.#markUntrusted(this.#o.restored === true ? "restore_unverified" : "key_changed", []);
      return;
    }
    if (!check.rowMacOk) {
      this.#markUntrusted("seal_forged", []);
      return;
    }
    if (row.format !== SEAL_FORMAT) {
      this.#markUntrusted("format_unknown", []);
      return;
    }
    if (row.state.startsWith("untrusted:")) {
      // Sticky (the state is under the row MAC): a restore marker never clears it.
      const reason = row.state.slice("untrusted:".length) as UntrustedReason;
      this.#untrusted = reason;
      if (!this.alerts.open().some((a) => a.kind === "state_untrusted")) {
        this.alerts.add("state_untrusted", { reason });
      }
      return;
    }
    // A restore is a deliberate rollback; otherwise the database must not be behind the last stop.
    const recorded = this.#keyFile.generation ?? 0;
    if (this.#o.restored !== true && row.gen < recorded) {
      this.#markUntrusted("rollback", []);
      return;
    }
    if (!check.ok) {
      // Never repair from a ledger that does not verify (H2, H3): nothing is destroyed.
      this.#markUntrusted(this.#o.restored === true ? "restore_unverified" : "ledger_mismatch", []);
      return;
    }
    const changes = diff(this.#rows(), check.entries);
    if (changes.length > 0) this.#repairOrFail(changes, "boot", true);
    if (this.#untrusted === null) this.#snapshot();
    if (this.#o.restored === true && this.#untrusted === null) {
      this.alerts.add("state_resealed", { restored: true }, { severity: "info" });
    }
  }

  /** A seal row exists (with a valid MAC) so the untrusted state can be recorded under it. */
  #ensureSealRowUntrusted(row: SealRow | undefined): void {
    if (row !== undefined && row.key_id === this.#keyId) return;
    this.#writeSeal({ agg: this.#aggInit(), gen: 0, state: "untrusted:seal_missing" });
  }

  #firstSeal(): void {
    const at = this.#now().toISOString();
    this.#repairing = true;
    try {
      this.#db.sqlite.transaction(() => {
        this.#db.sqlite.prepare("DELETE FROM security_ledger").run();
        this.#writeSeal({ agg: this.#aggInit(), gen: 0, state: "sealed", sealedAt: at });
        this.#populate();
      })();
    } finally {
      this.#repairing = false;
    }
    this.#snapshot();
    this.#audit(SEALED_AUDIT_KIND, { first: true, keyId: this.#keyId });
    const counts = this.counts();
    // A fresh install has nothing to review; an upgrade with paired devices gets one notice.
    if (counts.devices > 0) this.alerts.add("state_first_seal", counts);
  }

  /** Something differs from the shadow while a transaction is open (read only). */
  #readOnlyProblem(): boolean {
    if (!this.#shadowComplete) return false;
    const rows = this.#rows();
    return diff(rows, this.#shadow, this.#dirty).length > 0;
  }

  /**
   * A full check during a run. The shadow is the authority: rows that differ from it are put back
   * (from memory, never from a ledger that failed). While the ledger verifies, rows that appeared
   * outside Psyche are revoked or removed; when it does not, nothing is destroyed and the state
   * becomes untrusted (they are then simply not trusted for anything).
   */
  #verify(when: "runtime" | "periodic"): void {
    this.#lastFull = this.#now().getTime();
    const check = this.#ledgerCheck();
    if (!this.#shadowComplete) {
      // Untrusted since boot: nothing to compare against. Rows that were there at boot stay
      // untrusted; rows this run wrote whose last write is not yet confirmed are dropped from
      // what it trusts (another program may have changed them since); revocations still hold.
      for (const k of this.#dirty) this.#shadow.delete(k);
      this.#dirty.clear();
      this.#replayRevocations();
      return;
    }
    // Keys the Gateway wrote since the last resolve: the ledger knows them if it verifies.
    // (Writes the repair below makes are its own, and are resolved after it.)
    const before = new Set(this.#dirty);
    this.#dirty.clear();
    const authority = new Map(this.#shadow);
    const unknown = new Set<string>();
    for (const k of before) {
      const e = check.ok ? check.entries.get(k) : undefined;
      if (e !== undefined) authority.set(k, e);
      else if (check.ok) authority.delete(k);
      else unknown.add(k);
    }
    const changes = diff(this.#rows(), authority, unknown);
    const destructive = check.ok && this.#untrusted === null;
    if (changes.length > 0) this.#repairOrFail(changes, when, destructive);
    if (!check.ok && this.#untrusted === null) {
      this.#markUntrusted(
        !check.rowMacOk
          ? "seal_forged"
          : check.row !== undefined && check.row.gen < this.#highGen
            ? "rollback"
            : "ledger_mismatch",
        changes,
      );
    }
    // The shadow is the truth again (unknown keys are left out: not trusted until re-seal).
    for (const k of unknown) authority.delete(k);
    this.#shadow = authority;
    // What the repair, the alert and the state change just wrote.
    this.#resolve();
    if (this.#untrusted === null) this.#snapshot();
    this.#replayRevocations();
  }

  #repairOrFail(changes: SealChange[], when: string, destructive: boolean): void {
    try {
      this.#repair(changes, destructive);
    } catch (err) {
      this.#o.log?.log("error", "security state repair failed", {
        message: err instanceof Error ? err.message : String(err),
      });
      this.#markUntrusted("repair_failed", changes);
      return;
    }
    const details = changeDetails(changes);
    this.#audit("security.state.repaired", { when, destructive, ...details });
    this.#o.log?.log("warn", "security state changed outside the Gateway; restored", {
      when,
      changes: changes.length,
    });
    this.alerts.add("state_changed_outside", details);
  }

  #markUntrusted(reason: UntrustedReason, changes: SealChange[], extra: AlertDetails = {}): void {
    const first = this.#untrusted === null;
    this.#untrusted = reason;
    const row = this.#sealRow();
    if (row === undefined) {
      this.#writeSeal({ agg: this.#aggInit(), gen: 0, state: `untrusted:${reason}` });
    } else if (row.key_id === this.#keyId) {
      this.#writeSeal({ agg: row.agg, gen: row.gen, state: `untrusted:${reason}` });
    }
    if (!first) return;
    const details: AlertDetails = {
      reason,
      ...(changes.length > 0 ? changeDetails(changes) : {}),
      ...extra,
    };
    this.#audit("security.state.untrusted", details);
    this.#o.log?.log("error", "security state untrusted", { reason });
    this.alerts.add("state_untrusted", details);
  }

  /**
   * Puts the authoritative state back in one transaction. Additions are revoked or removed only
   * when `destructive` (the authority is the shadow and the ledger verifies).
   */
  #repair(changes: SealChange[], destructive: boolean): void {
    const at = this.#now().toISOString();
    const sqlite = this.#db.sqlite;
    const revokedDevices: string[] = [];
    this.#repairing = true;
    try {
      sqlite.transaction(() => {
        if (destructive) {
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
                  .prepare(
                    "UPDATE setup_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?",
                  )
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
    } finally {
      this.#repairing = false;
    }
    this.#notifyRevoked(revokedDevices, true);
  }

  #notifyRevoked(ids: string[], record: boolean): void {
    if (ids.length === 0) return;
    // A device that appeared outside Psyche is revoked for good, like any revocation (design-26).
    if (record) {
      for (const id of ids) {
        try {
          this.#ledger.recordDevice(id);
        } catch {
          // the database revocation stands; the ledger is a backstop for restores
        }
      }
    }
    for (const l of this.#revokedListeners) {
      try {
        l(ids);
      } catch {
        // closing connections is best effort; the device row is revoked
      }
    }
  }

  /** H5: `security/revocations.jsonl` holds while running too, not only at boot. */
  #replayRevocations(): void {
    let entries: ReturnType<RevocationLedger["entries"]>;
    try {
      entries = this.#ledger.entries();
    } catch {
      return;
    }
    const at = this.#now().toISOString();
    const devices: string[] = [];
    let grants = 0;
    this.#repairing = true;
    try {
      for (const e of entries) {
        if (e.type === "device") {
          const n = this.#db.sqlite
            .prepare(
              "UPDATE devices SET revoked_at = ?, token_hash = NULL, updated_at = ? WHERE id = ? AND revoked_at IS NULL",
            )
            .run(e.at, at, e.id).changes;
          if (n > 0) devices.push(e.id);
        } else if (e.type === "grant") {
          grants += this.#db.sqlite
            .prepare(
              "UPDATE grants SET revoked_at = ?, revoked_reason = ?, updated_at = ? WHERE id = ? AND revoked_at IS NULL",
            )
            .run(e.at, e.reason, at, e.id).changes;
        }
      }
    } finally {
      this.#repairing = false;
    }
    if (devices.length + grants === 0) return;
    this.#resolve();
    this.#notifyRevoked(devices, false);
    this.#audit("revocations.replayed", {
      devicesRevoked: devices.length,
      grantsRevoked: grants,
      when: "runtime",
    });
    this.alerts.add("state_changed_outside", {
      changes: devices.map((id) => ({ table: "devices", change: "modified" as const, name: id })),
      ...(grants > 0 ? { more: grants } : {}),
    });
  }

  #audit(kind: string, data: Record<string, unknown>): void {
    void this.#o.audit
      ?.append({ kind, actor: { type: "system" }, data: data as never })
      .catch(() => undefined);
  }
}

/** Rows that differ from the authority (keys in `skip` are left out). */
function diff(
  rows: Map<string, string>,
  authority: Map<string, string>,
  skip: ReadonlySet<string> = new Set(),
): SealChange[] {
  const out: SealChange[] = [];
  const specOf = (k: string) => {
    const [tbl, pk] = k.split("\0") as [string, string];
    return { spec: SEALED_TABLES.find((t) => t.table === tbl) as SealedTable, pk };
  };
  for (const [k, current] of rows) {
    if (skip.has(k)) continue;
    const sealed = authority.get(k);
    const { spec, pk } = specOf(k);
    if (sealed === undefined) out.push({ spec, pk, change: "added", current });
    else if (sealed !== current) out.push({ spec, pk, change: "modified", sealed, current });
  }
  for (const [k, sealed] of authority) {
    if (skip.has(k) || rows.has(k)) continue;
    const { spec, pk } = specOf(k);
    if (spec !== undefined) out.push({ spec, pk, change: "removed", sealed });
  }
  // Parents first (SEALED_TABLES order), so a restored passkey finds its device.
  const order = (c: SealChange) => SEALED_TABLES.indexOf(c.spec);
  return out.sort((a, b) => order(a) - order(b));
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
