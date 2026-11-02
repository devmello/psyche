import { chmodSync, closeSync, existsSync, openSync, readSync, rmSync } from "node:fs";
import { getSetting, openDb, type PsycheDb } from "@psyche/db";
import type { SearchIndexEncryption } from "@psyche/protocol";
import {
  isPlainSqlite,
  type KeyWrapper,
  loadOrCreateSubsystemKey,
  openEncryptedSqlite,
} from "@psyche/vault";
import type { VaultSlotChoice } from "./vault.ts";

/** `search.encrypt`: encrypt `state/search.sqlite` with its own key (off by default). */
export const SEARCH_ENCRYPT_SETTING = "search.encrypt";

/** Slots that ask the owner (Touch ID) on every unwrap cannot open an index at start-up. */
const INTERACTIVE_SLOTS: readonly VaultSlotChoice[] = ["keychain"];

export interface SearchKeyResult {
  key?: Buffer;
  status: SearchIndexEncryption;
}

/**
 * The index key for this start, or why there is none. The key is a 32-byte DEK wrapped by the
 * vault's own slot (`<home>/state/search.key.json`). Only a slot that opens without asking is
 * used: on the macOS keychain slot (Touch ID on every unwrap, helper not yet connected at boot)
 * the switch reports `unavailable` and the index stays as it is.
 */
export async function resolveSearchKey(o: {
  db: PsycheDb;
  keyFile: string;
  wrapper: KeyWrapper;
  slot: VaultSlotChoice;
}): Promise<SearchKeyResult> {
  if (getSetting(o.db, SEARCH_ENCRYPT_SETTING)?.value !== true) return { status: { state: "off" } };
  if (INTERACTIVE_SLOTS.includes(o.slot))
    return {
      status: {
        state: "unavailable",
        reason:
          "The key would be kept in the macOS keychain, which asks for Touch ID every time and is not ready when Psyche starts. Use a key file or the desktop's secure storage.",
      },
    };
  try {
    const { key } = await loadOrCreateSubsystemKey(o.keyFile, o.wrapper, "Open the search index");
    return { key, status: { state: "on" } };
  } catch (err) {
    return {
      status: { state: "unavailable", reason: err instanceof Error ? err.message : String(err) },
    };
  }
}

function header(path: string): Buffer | undefined {
  if (!existsSync(path)) return undefined;
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(16);
    const n = readSync(fd, buf, 0, 16, 0);
    return buf.subarray(0, n);
  } finally {
    closeSync(fd);
  }
}

function removeFiles(path: string): void {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
}

/**
 * Opens the search index plain or encrypted. The index is derived data, so when its state does
 * not match the setting (plain file but encryption on, encrypted file but off, a key that no
 * longer opens it) the file is removed and the Gateway's usual backfill refills it.
 */
export function openSearchDatabase(
  path: string,
  key: Buffer | undefined,
  log?: (msg: string) => void,
): { sqlite: PsycheDb["sqlite"]; rebuilt: boolean } {
  const head = header(path);
  const plain = head === undefined ? undefined : isPlainSqlite(head);
  let rebuilt = false;
  if (head !== undefined && head.length > 0 && key !== undefined && plain === true) {
    log?.("search: encrypting the index; it will be rebuilt");
    removeFiles(path);
    rebuilt = true;
  }
  if (head !== undefined && head.length > 0 && key === undefined && plain === false) {
    log?.("search: encryption is off; the encrypted index will be rebuilt as plain");
    removeFiles(path);
    rebuilt = true;
  }
  if (key === undefined) return { sqlite: openDb(path, { migrate: false }).sqlite, rebuilt };
  let sqlite: PsycheDb["sqlite"];
  try {
    sqlite = openEncryptedSqlite(path, key);
  } catch {
    log?.("search: the index key no longer opens the index; it will be rebuilt");
    removeFiles(path);
    rebuilt = true;
    sqlite = openEncryptedSqlite(path, key);
  }
  chmodSync(path, 0o600);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("synchronous = NORMAL");
  sqlite.pragma("busy_timeout = 5000");
  sqlite.pragma("secure_delete = ON");
  return { sqlite, rebuilt };
}
