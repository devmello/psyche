import { execFile } from "node:child_process";
import { createDecipheriv, createHash, pbkdf2Sync } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { PsycheError } from "@psyche/protocol";

/**
 * Reads another browser's cookie database (docs/design/cookie-import-2026.md). The file is
 * copied into a private temp folder first and only the copy is opened, so a running browser's
 * database is never locked or written. Decrypted values stay in the returned objects; nothing
 * here logs, and every error is a fixed string.
 */

export type SameSite = "unspecified" | "no_restriction" | "lax" | "strict";

export interface ImportCookie {
  /** As stored: a leading dot is a domain cookie, none is host-only. */
  host: string;
  name: string;
  value: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite: SameSite;
  /** Unix seconds; undefined for a session cookie. */
  expires?: number;
}

export interface ReadResult {
  cookies: ImportCookie[];
  /** Expired cookies left out. */
  expired: number;
  /** Cookies that could not be decrypted, or were partitioned (CHIPS, Firefox containers). */
  skipped: number;
}

type Row = Record<string, unknown>;

/** Runs one read query on a database copy Psyche owns. */
export type SqliteQuery = (dbPath: string, sql: string) => Promise<Row[]>;

/** `node:sqlite` where the runtime has it, else macOS's `/usr/bin/sqlite3 -json`. */
export const defaultSqlite: SqliteQuery = async (dbPath, sql) => {
  let mod: typeof import("node:sqlite") | undefined;
  try {
    mod = await import("node:sqlite");
  } catch {
    mod = undefined;
  }
  if (mod !== undefined) {
    const db = new mod.DatabaseSync(dbPath);
    try {
      return db.prepare(sql).all() as Row[];
    } finally {
      db.close();
    }
  }
  return new Promise((resolve, reject) => {
    execFile(
      "/usr/bin/sqlite3",
      ["-json", dbPath, sql],
      { maxBuffer: 256 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return reject(new PsycheError("unavailable", "the cookie file could not be read"));
        try {
          resolve(stdout.trim() === "" ? [] : (JSON.parse(stdout) as Row[]));
        } catch {
          reject(new PsycheError("unavailable", "the cookie file could not be read"));
        }
      },
    );
  });
};

/** Copies `file` and its journal into a fresh `0700` folder; the caller removes the folder. */
export function copyDatabase(file: string, tmpRoot: string): { dir: string; copy: string } {
  const dir = mkdtempSync(join(tmpRoot, "psyche-cookie-import-"));
  chmodSync(dir, 0o700);
  const copy = join(dir, "cookies.db");
  try {
    copyFileSync(file, copy);
    chmodSync(copy, 0o600);
    for (const suffix of ["-wal", "-journal"]) {
      if (existsSync(file + suffix)) {
        copyFileSync(file + suffix, copy + suffix);
        // copyfile keeps the source's mode, and Firefox's files are often 0644.
        chmodSync(copy + suffix, 0o600);
      }
    }
  } catch {
    rmSync(dir, { recursive: true, force: true });
    throw new PsycheError("unavailable", "the browser's cookie file could not be copied");
  }
  return { dir, copy };
}

/** Removes private copies a crash or kill left in `tmpRoot`; no read is running when this is called. */
export function sweepStaleCopies(tmpRoot: string): void {
  try {
    for (const name of readdirSync(tmpRoot)) {
      if (!name.startsWith("psyche-cookie-import-")) continue;
      rmSync(join(tmpRoot, name), { recursive: true, force: true });
    }
  } catch {
    // An unreadable temp folder has nothing for us to sweep.
  }
}

async function withCopy<T>(
  file: string,
  tmpRoot: string,
  fn: (copy: string) => Promise<T>,
): Promise<T> {
  const { dir, copy } = copyDatabase(file, tmpRoot);
  try {
    return await fn(copy);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function columnsOf(q: SqliteQuery, db: string, table: string): Promise<Set<string>> {
  const rows = await q(db, `PRAGMA table_info(${table})`);
  return new Set(rows.map((r) => String(r.name)));
}

const num = (v: unknown): number => (typeof v === "number" ? v : Number(v ?? 0));
const text = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));

// ── Chromium ──────────────────────────────────────────────────────────────────────────────

/** Seconds between 1601-01-01 (Chromium's epoch) and 1970-01-01. */
const WINDOWS_EPOCH_OFFSET = 11_644_473_600;

/** The AES key from the Keychain's "<Browser> Safe Storage" password (macOS). */
export function deriveChromiumKey(password: string): Buffer {
  return pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
}

const CBC_IV = Buffer.alloc(16, 0x20);

/**
 * Decrypts one `encrypted_value`. From cookie DB version 24 the plaintext starts with
 * SHA-256(host_key), which is checked and dropped. Returns undefined when it doesn't decrypt.
 */
export function decryptChromiumValue(
  encrypted: Buffer,
  key: Buffer,
  hostKey: string,
  dbVersion: number,
): string | undefined {
  if (encrypted.length < 3 || encrypted.subarray(0, 3).toString("latin1") !== "v10") {
    return undefined;
  }
  let plain: Buffer;
  try {
    const d = createDecipheriv("aes-128-cbc", key, CBC_IV);
    plain = Buffer.concat([d.update(encrypted.subarray(3)), d.final()]);
  } catch {
    return undefined;
  }
  if (dbVersion >= 24) {
    if (plain.length < 32) return undefined;
    const digest = createHash("sha256").update(hostKey).digest();
    if (!plain.subarray(0, 32).equals(digest)) return undefined;
    plain = plain.subarray(32);
  }
  return plain.toString("utf8");
}

export function chromiumSameSite(v: number): SameSite {
  if (v === 0) return "no_restriction";
  if (v === 1) return "lax";
  if (v === 2) return "strict";
  return "unspecified";
}

export async function readChromiumCookies(o: {
  file: string;
  tmpRoot: string;
  key: Buffer;
  nowSeconds: number;
  sqlite?: SqliteQuery;
}): Promise<ReadResult> {
  const q = o.sqlite ?? defaultSqlite;
  return withCopy(o.file, o.tmpRoot, async (db) => {
    const cols = await columnsOf(q, db, "cookies");
    if (!cols.has("host_key") || !cols.has("encrypted_value")) {
      throw new PsycheError("unavailable", "the cookie file is not in a format Psyche knows");
    }
    const meta = await q(db, "SELECT value FROM meta WHERE key = 'version'").catch(() => []);
    const dbVersion = num(meta[0]?.value);
    const partitioned = cols.has("top_frame_site_key") ? "top_frame_site_key" : "''";
    const hasExpires = cols.has("has_expires") ? "has_expires" : "1";
    const rows = await q(
      db,
      // Microseconds since 1601 overflow a JS number's safe range: divide in SQL.
      `SELECT host_key, name, value, hex(encrypted_value) AS enc, path,
        expires_utc / 1000000 AS expires_s,
        ${hasExpires} AS has_expires, is_secure, is_httponly, samesite,
        ${partitioned} AS partition_key FROM cookies`,
    );
    const out: ReadResult = { cookies: [], expired: 0, skipped: 0 };
    for (const r of rows) {
      const host = text(r.host_key).toLowerCase();
      if (text(r.partition_key) !== "") {
        out.skipped += 1;
        continue;
      }
      const expiresS = num(r.expires_s);
      const persistent = num(r.has_expires) !== 0 && expiresS > 0;
      const expires = persistent ? expiresS - WINDOWS_EPOCH_OFFSET : undefined;
      if (expires !== undefined && expires <= o.nowSeconds) {
        out.expired += 1;
        continue;
      }
      let value = text(r.value);
      const enc = text(r.enc);
      if (value === "" && enc !== "") {
        const plain = decryptChromiumValue(Buffer.from(enc, "hex"), o.key, host, dbVersion);
        if (plain === undefined) {
          out.skipped += 1;
          continue;
        }
        value = plain;
      }
      out.cookies.push({
        host,
        name: text(r.name),
        value,
        path: text(r.path) || "/",
        secure: num(r.is_secure) !== 0,
        httpOnly: num(r.is_httponly) !== 0,
        sameSite: chromiumSameSite(num(r.samesite)),
        ...(expires === undefined ? {} : { expires }),
      });
    }
    return out;
  });
}

// ── Firefox ───────────────────────────────────────────────────────────────────────────────

/** Firefox stores expiry in seconds, newer builds in milliseconds. */
function firefoxExpiry(v: number): number {
  return v > 1e11 ? Math.floor(v / 1000) : v;
}

export function firefoxSameSite(v: number, secure: boolean): SameSite {
  if (v === 1) return "lax";
  if (v === 2) return "strict";
  // SameSite=None needs Secure in Chromium; an insecure "none" stays the browser default.
  if (v === 0) return secure ? "no_restriction" : "unspecified";
  return "unspecified";
}

export async function readFirefoxCookies(o: {
  file: string;
  tmpRoot: string;
  nowSeconds: number;
  sqlite?: SqliteQuery;
}): Promise<ReadResult> {
  const q = o.sqlite ?? defaultSqlite;
  return withCopy(o.file, o.tmpRoot, async (db) => {
    const cols = await columnsOf(q, db, "moz_cookies");
    if (!cols.has("host") || !cols.has("value")) {
      throw new PsycheError("unavailable", "the cookie file is not in a format Psyche knows");
    }
    const attrs = cols.has("originAttributes") ? "originAttributes" : "''";
    const rows = await q(
      db,
      `SELECT host, name, value, path, expiry, isSecure, isHttpOnly, sameSite,
        ${attrs} AS origin_attributes FROM moz_cookies`,
    );
    const out: ReadResult = { cookies: [], expired: 0, skipped: 0 };
    for (const r of rows) {
      // Containers, private windows and partitioned cookies are not the owner's default jar.
      if (text(r.origin_attributes) !== "") {
        out.skipped += 1;
        continue;
      }
      const expires = firefoxExpiry(num(r.expiry));
      if (expires <= o.nowSeconds) {
        out.expired += 1;
        continue;
      }
      const secure = num(r.isSecure) !== 0;
      out.cookies.push({
        host: text(r.host).toLowerCase(),
        name: text(r.name),
        value: text(r.value),
        path: text(r.path) || "/",
        secure,
        httpOnly: num(r.isHttpOnly) !== 0,
        sameSite: firefoxSameSite(num(r.sameSite), secure),
        expires,
      });
    }
    return out;
  });
}

// ── Keychain ──────────────────────────────────────────────────────────────────────────────

/**
 * Reads "<Browser> Safe Storage" with `security`. macOS shows its own prompt for it; the
 * password is returned to the caller only and never logged.
 */
export function readKeychainPassword(service: string, account: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "/usr/bin/security",
      ["find-generic-password", "-w", "-a", account, "-s", service],
      { timeout: 120_000 },
      (err, stdout) => {
        if (err) {
          const code = (err as { code?: unknown }).code;
          return reject(
            code === 44
              ? new PsycheError(
                  "not_found",
                  "the browser's Safe Storage key is not in the Keychain",
                )
              : new PsycheError("forbidden", "the Keychain did not give Psyche the browser's key"),
          );
        }
        resolve(stdout.replace(/\n$/, ""));
      },
    );
  });
}
