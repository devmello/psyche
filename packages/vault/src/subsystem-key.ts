import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import Database from "better-sqlite3-multiple-ciphers";
import { randomKey, zeroize } from "./crypto.ts";
import { fail } from "./errors.ts";
import type { KeyWrapper, WrappedKey } from "./slots/KeyWrapper.ts";

/**
 * A 32-byte data key for another database (the search index, later the memory store), wrapped by
 * the same `KeyWrapper` slot as the vault's own key and kept in a small JSON file (0600, never
 * the key in the clear). `loadOrCreate` makes it on first use. A wrapper that prompts (the
 * macOS keychain slot asks for Touch ID) is the caller's choice to avoid at boot.
 */

const FILE_VERSION = 1;

interface KeyFile {
  v: number;
  slot: string;
  wrapped: WrappedKey;
}

export async function loadOrCreateSubsystemKey(
  file: string,
  wrapper: KeyWrapper,
  reason: string,
): Promise<{ key: Buffer; created: boolean }> {
  let raw: string | undefined;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    raw = undefined;
  }
  if (raw !== undefined) {
    let parsed: KeyFile;
    try {
      parsed = JSON.parse(raw) as KeyFile;
    } catch {
      return fail("invalid_params", "key file is not valid JSON");
    }
    if (parsed.v !== FILE_VERSION || parsed.slot !== wrapper.slot)
      return fail("invalid_params", "key file was written for another key slot");
    const key = await wrapper.unwrap(parsed.wrapped, { reason });
    if (key.length !== 32) return fail("invalid_params", "key file holds a key of the wrong size");
    return { key, created: false };
  }
  const why = await wrapper.unavailableReason();
  if (why !== null) return fail("unavailable", why);
  const key = randomKey();
  try {
    const wrapped = await wrapper.wrap(key, { reason });
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(
      tmp,
      `${JSON.stringify({ v: FILE_VERSION, slot: wrapper.slot, wrapped } satisfies KeyFile)}\n`,
      {
        mode: 0o600,
      },
    );
    await chmod(tmp, 0o600);
    await rename(tmp, file);
  } catch (err) {
    zeroize(key);
    throw err;
  }
  return { key, created: true };
}

const PLAIN_HEADER = "SQLite format 3\0";

/** True when `header` (the first 16 bytes of a database file) is an unencrypted SQLite file. */
export function isPlainSqlite(header: Buffer): boolean {
  return header.length >= 16 && header.subarray(0, 16).toString("latin1") === PLAIN_HEADER;
}

/**
 * Opens (or creates) a SQLCipher database with a raw 32-byte key, as the vault does, with FTS5
 * and sqlite-vec available. Throws `unauthorized` when the key does not open an existing file.
 */
export function openEncryptedSqlite(path: string, key: Buffer): Database.Database {
  if (key.length !== 32) return fail("invalid_params", "database key must be 32 bytes");
  const db = new Database(path);
  try {
    db.pragma("cipher='sqlcipher'");
    db.pragma("legacy=4");
    db.pragma(`key="x'${key.toString("hex")}'"`);
    db.prepare("SELECT count(*) FROM sqlite_master").get();
  } catch {
    db.close();
    return fail("unauthorized", "the key does not open this database");
  }
  return db;
}
