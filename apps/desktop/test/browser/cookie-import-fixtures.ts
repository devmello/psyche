import { createCipheriv, createHash, pbkdf2Sync } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Fixture browser profiles for the cookie-import tests, built in a temp "home". Nothing here
 * reads the owner's real browsers or Keychain: the Safe Storage password is a known test value.
 */

export const SAFE_STORAGE_PASSWORD = "fixture-safe-storage-password";
const EPOCH_1601 = 11_644_473_600n;

export interface FixtureCookie {
  host: string;
  name: string;
  value: string;
  path?: string;
  /** Unix seconds; undefined for a session cookie. */
  expires?: number;
  secure?: boolean;
  httpOnly?: boolean;
  /** Chromium: -1 unspecified, 0 none, 1 lax, 2 strict. Firefox: 0 none, 1 lax, 2 strict. */
  sameSite?: number;
  partition?: string;
  /** Store the value in plain `value` instead of `encrypted_value` (Chromium). */
  plain?: boolean;
}

export function encryptChromium(value: string, host: string, version: number, password: string) {
  const key = pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
  const c = createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
  const prefix = version >= 24 ? createHash("sha256").update(host).digest() : Buffer.alloc(0);
  const body = Buffer.concat([
    c.update(Buffer.concat([prefix, Buffer.from(value, "utf8")])),
    c.final(),
  ]);
  return Buffer.concat([Buffer.from("v10", "latin1"), body]);
}

export function writeChromiumDb(
  file: string,
  cookies: readonly FixtureCookie[],
  o: { version?: number; password?: string; legacy?: boolean } = {},
): void {
  const version = o.version ?? 24;
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE meta(key LONGVARCHAR NOT NULL UNIQUE PRIMARY KEY, value LONGVARCHAR)");
  db.prepare("INSERT INTO meta(key, value) VALUES ('version', ?)").run(String(version));
  db.exec(
    `CREATE TABLE cookies(creation_utc INTEGER NOT NULL, host_key TEXT NOT NULL,
      ${o.legacy ? "" : "top_frame_site_key TEXT NOT NULL,"} name TEXT NOT NULL,
      value TEXT NOT NULL, encrypted_value BLOB NOT NULL, path TEXT NOT NULL,
      expires_utc INTEGER NOT NULL, is_secure INTEGER NOT NULL, is_httponly INTEGER NOT NULL,
      last_access_utc INTEGER NOT NULL, has_expires INTEGER NOT NULL,
      is_persistent INTEGER NOT NULL, priority INTEGER NOT NULL, samesite INTEGER NOT NULL)`,
  );
  const insert = db.prepare(
    `INSERT INTO cookies(creation_utc, host_key, ${o.legacy ? "" : "top_frame_site_key,"} name,
      value, encrypted_value, path, expires_utc, is_secure, is_httponly, last_access_utc,
      has_expires, is_persistent, priority, samesite)
     VALUES (1, ?, ${o.legacy ? "" : "?,"} ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 1, ?)`,
  );
  for (const c of cookies) {
    const enc = c.plain
      ? Buffer.alloc(0)
      : encryptChromium(c.value, c.host, version, o.password ?? SAFE_STORAGE_PASSWORD);
    const expiresUtc = c.expires === undefined ? 0n : (BigInt(c.expires) + EPOCH_1601) * 1_000_000n;
    const args = [
      c.host,
      ...(o.legacy ? [] : [c.partition ?? ""]),
      c.name,
      c.plain ? c.value : "",
      enc,
      c.path ?? "/",
      expiresUtc,
      c.secure === false ? 0 : 1,
      c.httpOnly ? 1 : 0,
      c.expires === undefined ? 0 : 1,
      c.expires === undefined ? 0 : 1,
      c.sameSite ?? -1,
    ];
    insert.run(...args);
  }
  db.close();
}

export function writeFirefoxDb(file: string, cookies: readonly FixtureCookie[]): void {
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(
    `CREATE TABLE moz_cookies(id INTEGER PRIMARY KEY, originAttributes TEXT NOT NULL DEFAULT '',
      name TEXT, value TEXT, host TEXT, path TEXT, expiry INTEGER, lastAccessed INTEGER,
      creationTime INTEGER, isSecure INTEGER, isHttpOnly INTEGER, inBrowserElement INTEGER DEFAULT 0,
      sameSite INTEGER DEFAULT 0, rawSameSite INTEGER DEFAULT 0, schemeMap INTEGER DEFAULT 0)`,
  );
  const insert = db.prepare(
    `INSERT INTO moz_cookies(originAttributes, name, value, host, path, expiry, lastAccessed,
      creationTime, isSecure, isHttpOnly, sameSite) VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?)`,
  );
  for (const c of cookies) {
    insert.run(
      c.partition ?? "",
      c.name,
      c.value,
      c.host,
      c.path ?? "/",
      c.expires ?? 0,
      c.secure === false ? 0 : 1,
      c.httpOnly ? 1 : 0,
      c.sameSite ?? 0,
    );
  }
  db.close();
}

export function chromeRoot(home: string): string {
  return join(home, "Library", "Application Support", "Google", "Chrome");
}

export function firefoxRoot(home: string): string {
  return join(home, "Library", "Application Support", "Firefox");
}

export function writeLocalState(root: string, names: Record<string, string>): void {
  mkdirSync(root, { recursive: true });
  const info_cache = Object.fromEntries(Object.entries(names).map(([d, name]) => [d, { name }]));
  writeFileSync(join(root, "Local State"), JSON.stringify({ profile: { info_cache } }));
}

export function writeProfilesIni(root: string, profiles: { name: string; path: string }[]): void {
  mkdirSync(root, { recursive: true });
  const body = profiles
    .map((p, i) => `[Profile${i}]\nName=${p.name}\nIsRelative=1\nPath=${p.path}\n`)
    .join("\n");
  writeFileSync(join(root, "profiles.ini"), `[General]\nStartWithLastProfile=1\n\n${body}`);
}
