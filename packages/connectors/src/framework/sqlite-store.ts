import { readFileSync } from "node:fs";
import type { ConnectorRecord, ConnectorStore } from "./types.ts";

/** The slice of better-sqlite3's `Database` this store uses (`@psyche/db`'s `PsycheDb.sqlite`). */
export interface ConnectorSqlite {
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
  exec(sql: string): unknown;
}

/** The DDL (identical to `packages/db/migrations/202610241000_connectors_init.sql`; a test checks). */
export function connectorsMigrationSql(): string {
  return readFileSync(new URL("../../migrations/connectors_init.sql", import.meta.url), "utf8");
}

interface Row {
  id: string;
  type: string;
  label: string;
  account: string | null;
  scopes: string;
  scope_mode: string;
  action_matrix: string;
  credential_id: string | null;
  status: string;
  config: string;
  last_sync: string | null;
  created_at: string;
  updated_at: string;
}

function toRecord(r: Row): ConnectorRecord {
  return {
    id: r.id,
    type: r.type,
    label: r.label,
    account: r.account,
    scopes: JSON.parse(r.scopes) as string[],
    scopeMode: r.scope_mode as ConnectorRecord["scopeMode"],
    actionMatrix: JSON.parse(r.action_matrix) as ConnectorRecord["actionMatrix"],
    credentialId: r.credential_id,
    status: r.status as ConnectorRecord["status"],
    config: JSON.parse(r.config) as ConnectorRecord["config"],
    lastSync:
      r.last_sync === null ? null : (JSON.parse(r.last_sync) as ConnectorRecord["lastSync"]),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/**
 * Connector records in SQLite (data model §8), so Settings → Connectors and onboarding read the
 * same rows across Gateway restarts (#505). In the Gateway the `@psyche/db` migration runner owns
 * the DDL; `{migrate: true}` applies it to a fresh database (tests).
 */
export class SqliteConnectorStore implements ConnectorStore {
  readonly #db: ConnectorSqlite;

  constructor(db: ConnectorSqlite, options: { migrate?: boolean } = {}) {
    this.#db = db;
    if (options.migrate === true) db.exec(connectorsMigrationSql());
  }

  async get(id: string): Promise<ConnectorRecord | undefined> {
    const r = this.#db.prepare("SELECT * FROM connectors WHERE id = ?").get(id) as Row | undefined;
    return r === undefined ? undefined : toRecord(r);
  }

  async list(): Promise<ConnectorRecord[]> {
    return (
      this.#db.prepare("SELECT * FROM connectors ORDER BY created_at, id").all() as Row[]
    ).map(toRecord);
  }

  async put(record: ConnectorRecord): Promise<void> {
    this.#db
      .prepare(
        `INSERT INTO connectors (id, type, label, account, scopes, scope_mode, action_matrix, credential_id, status, config, last_sync, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET type = excluded.type, label = excluded.label, account = excluded.account,
           scopes = excluded.scopes, scope_mode = excluded.scope_mode, action_matrix = excluded.action_matrix,
           credential_id = excluded.credential_id, status = excluded.status, config = excluded.config,
           last_sync = excluded.last_sync, updated_at = excluded.updated_at`,
      )
      .run(
        record.id,
        record.type,
        record.label,
        record.account,
        JSON.stringify(record.scopes),
        record.scopeMode,
        JSON.stringify(record.actionMatrix),
        record.credentialId,
        record.status,
        JSON.stringify(record.config),
        record.lastSync === null ? null : JSON.stringify(record.lastSync),
        record.createdAt,
        record.updatedAt,
      );
  }

  async delete(id: string): Promise<void> {
    this.#db.prepare("DELETE FROM connectors WHERE id = ?").run(id);
  }
}
