/// <reference path="./types/better-sqlite3-multiple-ciphers.d.ts" />
import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import type { CredentialBinding, CredentialKind } from "@psyche/protocol";
import Database from "better-sqlite3-multiple-ciphers";
import { fail } from "./errors.ts";

/** Secret JSON of an item (data model §6 `items.secret`). Lives only inside `vault.db`. */
export interface ItemSecret {
  username?: string;
  password?: string;
  totpSecret?: string;
  token?: string;
  refreshToken?: string;
  expiresAt?: string;
  scopes?: string[];
  /** OAuth extras a connector stores with its tokens (G13). */
  tokenType?: string;
  obtainedAt?: string;
  privateKey?: string;
  text?: string;
}

/** Non-secret attributes kept with the item (header name, flags). */
export interface ItemAttrs {
  headerName?: string;
  headerPrefix?: string;
  requireAuthEachUse?: boolean;
  /** G9: the secret lives in the system keychain; G10 / G11: in an external manager. */
  backend?: "keychain" | "1password" | "bitwarden";
  /** G10 / G11: where the external item lives (names or ids; never a value). */
  external?: { vault: string; item: string } | { item: string };
  /** Secret fields present (keychain items), so `resolve` can check them without a prompt. */
  fields?: string[];
}

export interface ItemRow {
  id: string;
  kind: CredentialKind;
  name: string;
  slug: string;
  secret: ItemSecret;
  bindings: CredentialBinding[];
  attrs: ItemAttrs;
  ownerConnectorId: string | null;
  createdAt: string;
  updatedAt: string;
}

export const VAULT_SCHEMA_VERSION = 2;

const KINDS = "'login','api_key','oauth_token','ssh_key','note','payment_link','signing_key'";

/** The items table; v2 adds `signing_key` (Web Bot Auth, I14) to the kind check. */
const ITEMS_TABLE = (name: string) => `
CREATE TABLE IF NOT EXISTS ${name} (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN (${KINDS})),
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  secret TEXT NOT NULL CHECK (json_valid(secret)),
  bindings TEXT NOT NULL CHECK (json_valid(bindings)),
  attrs TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(attrs)),
  owner_connector_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);`;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS header (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
);
${ITEMS_TABLE("items")}
`;

/**
 * v1 → v2: SQLite cannot change a CHECK constraint, so the items table is rebuilt with the
 * wider kind list inside one transaction (rows, ids and slugs unchanged).
 */
function migrate(db: Database.Database): void {
  const version = (
    db.prepare("SELECT value FROM header WHERE key = 'version'").get() as
      | { value: string }
      | undefined
  )?.value;
  if (version === undefined || Number(version) >= VAULT_SCHEMA_VERSION) return;
  db.transaction(() => {
    const sql = (
      db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'items'").get() as
        | { sql: string }
        | undefined
    )?.sql;
    if (sql !== undefined && !sql.includes("'signing_key'")) {
      db.exec(ITEMS_TABLE("items_v2"));
      db.exec(
        "INSERT INTO items_v2 (id, kind, name, slug, secret, bindings, attrs, owner_connector_id, created_at, updated_at) " +
          "SELECT id, kind, name, slug, secret, bindings, attrs, owner_connector_id, created_at, updated_at FROM items",
      );
      db.exec("DROP TABLE items");
      db.exec("ALTER TABLE items_v2 RENAME TO items");
    }
    db.prepare("UPDATE header SET value = ? WHERE key = 'version'").run(
      String(VAULT_SCHEMA_VERSION),
    );
  })();
}

interface RawItem {
  id: string;
  kind: CredentialKind;
  name: string;
  slug: string;
  secret: string;
  bindings: string;
  attrs: string;
  owner_connector_id: string | null;
  created_at: string;
  updated_at: string;
}

function fromRaw(r: RawItem): ItemRow {
  return {
    id: r.id,
    kind: r.kind,
    name: r.name,
    slug: r.slug,
    secret: JSON.parse(r.secret) as ItemSecret,
    bindings: JSON.parse(r.bindings) as CredentialBinding[],
    attrs: JSON.parse(r.attrs) as ItemAttrs,
    ownerConnectorId: r.owner_connector_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** Create `path` with mode 0600 (parents 0700) before SQLite opens it (security §14). */
function prepareFile(path: string): void {
  if (path === ":memory:") return;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (!existsSync(path)) closeSync(openSync(path, "a", 0o600));
  chmodSync(path, 0o600);
}

/**
 * The encrypted item store: SQLCipher 4 page format (AES-256-CBC, HMAC-SHA512, 4096-byte
 * pages) through SQLite3 Multiple Ciphers, keyed with the raw 32-byte DEK so PBKDF2 is skipped
 * (security §4.1). Synchronous like `@psyche/db`. Secret values exist nowhere else on disk.
 */
export class VaultStore {
  readonly #db: Database.Database;

  private constructor(db: Database.Database) {
    this.#db = db;
  }

  /** Open (or create) `path` with `dek`. Rejects with `unauthorized` when the key is wrong. */
  static open(path: string, dek: Buffer): VaultStore {
    if (dek.length !== 32) return fail("invalid_params", "vault key must be 32 bytes");
    prepareFile(path);
    const db = new Database(path);
    try {
      db.pragma("cipher='sqlcipher'");
      db.pragma("legacy=4");
      // The key goes in as a blob literal: raw-key mode. The hex string is short-lived.
      db.pragma(`key="x'${dek.toString("hex")}'"`);
      // PRAGMA key never fails; the first read does.
      db.prepare("SELECT count(*) AS n FROM sqlite_master").get();
    } catch {
      db.close();
      return fail("unauthorized", "vault key does not open vault.db");
    }
    db.pragma("secure_delete=ON");
    db.pragma("foreign_keys=ON");
    if (path !== ":memory:") db.pragma("journal_mode=WAL");
    db.exec(SCHEMA);
    db.prepare("INSERT OR IGNORE INTO header (key, value) VALUES ('version', ?)").run(
      String(VAULT_SCHEMA_VERSION),
    );
    migrate(db);
    return new VaultStore(db);
  }

  header(key: string): string | undefined {
    const row = this.#db.prepare("SELECT value FROM header WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  }

  setHeader(key: string, value: string): void {
    this.#db
      .prepare(
        "INSERT INTO header (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(key, value);
  }

  insert(item: ItemRow): void {
    this.#db
      .prepare(
        `INSERT INTO items (id, kind, name, slug, secret, bindings, attrs, owner_connector_id, created_at, updated_at)
         VALUES (@id, @kind, @name, @slug, @secret, @bindings, @attrs, @owner, @created, @updated)`,
      )
      .run({
        id: item.id,
        kind: item.kind,
        name: item.name,
        slug: item.slug,
        secret: JSON.stringify(item.secret),
        bindings: JSON.stringify(item.bindings),
        attrs: JSON.stringify(item.attrs),
        owner: item.ownerConnectorId,
        created: item.createdAt,
        updated: item.updatedAt,
      });
  }

  update(item: ItemRow): void {
    this.#db
      .prepare(
        `UPDATE items SET name = @name, secret = @secret, bindings = @bindings, attrs = @attrs,
           updated_at = @updated WHERE id = @id`,
      )
      .run({
        id: item.id,
        name: item.name,
        secret: JSON.stringify(item.secret),
        bindings: JSON.stringify(item.bindings),
        attrs: JSON.stringify(item.attrs),
        updated: item.updatedAt,
      });
  }

  get(id: string): ItemRow | undefined {
    const r = this.#db.prepare("SELECT * FROM items WHERE id = ?").get(id) as RawItem | undefined;
    return r === undefined ? undefined : fromRaw(r);
  }

  bySlug(slug: string): ItemRow | undefined {
    const r = this.#db.prepare("SELECT * FROM items WHERE slug = ?").get(slug) as
      | RawItem
      | undefined;
    return r === undefined ? undefined : fromRaw(r);
  }

  all(): ItemRow[] {
    return (this.#db.prepare("SELECT * FROM items ORDER BY created_at, id").all() as RawItem[]).map(
      fromRaw,
    );
  }

  /** Overwrite the secret with same-length filler, then delete (security §14). */
  delete(id: string): boolean {
    const tx = this.#db.transaction(() => {
      const r = this.#db.prepare("SELECT secret FROM items WHERE id = ?").get(id) as
        | { secret: string }
        | undefined;
      if (r === undefined) return false;
      this.#db
        .prepare("UPDATE items SET secret = ? WHERE id = ?")
        .run(JSON.stringify({ text: "0".repeat(r.secret.length) }), id);
      this.#db.prepare("DELETE FROM items WHERE id = ?").run(id);
      return true;
    });
    return tx.immediate();
  }

  /** Run `fn` in one `BEGIN IMMEDIATE` transaction (atomic token rotation, imports). */
  transaction<T>(fn: () => T): T {
    return this.#db.transaction(fn).immediate();
  }

  /** Checkpoint the WAL into the main file so deleted pages do not linger in `-wal`. */
  checkpoint(): void {
    try {
      this.#db.pragma("wal_checkpoint(TRUNCATE)");
    } catch {
      // :memory: or a read-only handle.
    }
  }

  /** Re-encrypt with a new DEK (`PRAGMA rekey`). */
  rekey(dek: Buffer): void {
    this.#db.pragma(`rekey="x'${dek.toString("hex")}'"`);
  }

  close(): void {
    this.checkpoint();
    this.#db.close();
  }
}
