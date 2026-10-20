import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { SqliteDb } from "./store.ts";

/**
 * Revocation ledger (S23 design-26): device and grant revocations recorded outside the backup
 * scope (`$PSYCHE_HOME/security/`, not in `@psyche/backup`'s entries), so restoring an older
 * backup cannot bring a revoked device or grant back. The Gateway replays the ledger against the
 * database at every boot. A restore leaves a marker; a restore into a home with no ledger (a new
 * machine, or a lost `security/`) cannot know what was revoked after the backup, so every device
 * must pair again and every standing grant is revoked.
 */

export const REVOCATIONS_FILE = join("security", "revocations.jsonl");
/** Written by `restoreBackup`; consumed at the next Gateway boot. */
export const RESTORE_MARKER = join("security", "restored.json");

export type RevocationEntry =
  | { type: "epoch"; at: string }
  | { type: "device"; id: string; at: string }
  | { type: "grant"; id: string; at: string; reason: string };

export class RevocationLedger {
  readonly path: string;
  readonly #now: () => string;

  constructor(home: string, now: () => string = () => new Date().toISOString()) {
    this.path = join(home, REVOCATIONS_FILE);
    this.#now = now;
  }

  get exists(): boolean {
    return existsSync(this.path);
  }

  /** Creates the ledger (0600 in a 0700 directory) with an epoch line when missing. */
  ensure(): void {
    if (this.exists) return;
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    chmodSync(dirname(this.path), 0o700);
    writeFileSync(this.path, `${JSON.stringify({ type: "epoch", at: this.#now() })}\n`, {
      mode: 0o600,
    });
  }

  #append(entry: RevocationEntry): void {
    this.ensure();
    appendFileSync(this.path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  }

  recordDevice(id: string): void {
    this.#append({ type: "device", id, at: this.#now() });
  }

  recordGrant(id: string, reason: string): void {
    this.#append({ type: "grant", id, at: this.#now(), reason });
  }

  entries(): RevocationEntry[] {
    if (!this.exists) return [];
    const out: RevocationEntry[] = [];
    for (const line of readFileSync(this.path, "utf8").split("\n")) {
      if (line.trim() === "") continue;
      try {
        const e = JSON.parse(line) as RevocationEntry;
        if (e.type === "device" || e.type === "grant" || e.type === "epoch") out.push(e);
      } catch {
        // A torn line proves nothing; the rest still applies.
      }
    }
    return out;
  }
}

export interface RevocationReplay {
  /** Devices revoked again because the ledger says so. */
  devicesRevoked: number;
  /** Grants revoked again because the ledger says so. */
  grantsRevoked: number;
  /** A restore into a home without a ledger: devices un-paired, standing grants revoked. */
  unknownEpoch: boolean;
  devicesUnpaired: number;
  grantsRevokedUnknownEpoch: number;
}

/**
 * Replays the ledger against `devices` and `grants` (idempotent), then handles a pending restore
 * marker. Call at Gateway boot, after migrations and before anything authenticates.
 */
export function replayRevocations(
  db: SqliteDb,
  home: string,
  now: () => string = () => new Date().toISOString(),
): RevocationReplay {
  const ledger = new RevocationLedger(home, now);
  const marker = join(home, RESTORE_MARKER);
  const restored = existsSync(marker);
  const out: RevocationReplay = {
    devicesRevoked: 0,
    grantsRevoked: 0,
    unknownEpoch: false,
    devicesUnpaired: 0,
    grantsRevokedUnknownEpoch: 0,
  };
  const at = now();
  const changes = (r: unknown) => (r as { changes?: number }).changes ?? 0;

  if (restored && !ledger.exists) {
    // No record of what was revoked after the backup was taken: fail closed.
    out.unknownEpoch = true;
    out.devicesUnpaired = changes(
      db
        .prepare(
          "UPDATE devices SET paired_at = NULL, token_hash = NULL, scopes = '[]', updated_at = ? WHERE revoked_at IS NULL AND paired_at IS NOT NULL",
        )
        .run(at),
    );
    out.grantsRevokedUnknownEpoch = changes(
      db
        .prepare(
          "UPDATE grants SET revoked_at = ?, revoked_reason = 'restore_unknown_epoch', updated_at = ? WHERE revoked_at IS NULL",
        )
        .run(at, at),
    );
  }
  const revokeDevice = db.prepare(
    "UPDATE devices SET revoked_at = ?, token_hash = NULL, updated_at = ? WHERE id = ? AND revoked_at IS NULL",
  );
  const revokeGrant = db.prepare(
    "UPDATE grants SET revoked_at = ?, revoked_reason = ?, updated_at = ? WHERE id = ? AND revoked_at IS NULL",
  );
  for (const e of ledger.entries()) {
    if (e.type === "device") out.devicesRevoked += changes(revokeDevice.run(e.at, at, e.id));
    if (e.type === "grant")
      out.grantsRevoked += changes(revokeGrant.run(e.at, `${e.reason}`, at, e.id));
  }
  ledger.ensure();
  if (restored) rmSync(marker, { force: true });
  return out;
}

/** `restoreBackup` leaves this marker so the next boot replays the ledger (or fails closed). */
export function writeRestoreMarker(
  home: string,
  info: { restoredAt: string; backupCreatedAt: string },
): void {
  const path = join(home, RESTORE_MARKER);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(info)}\n`, { mode: 0o600 });
}
