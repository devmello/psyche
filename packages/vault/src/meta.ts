import type { CredentialKind, CredentialMeta, CredentialUse } from "@psyche/protocol";

/** The subset of a better-sqlite3 handle this module uses (`PsycheDb.sqlite` satisfies it). */
export interface SqlHandle {
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
}

/**
 * Metadata mirror in the main database (`credential_meta`, `credential_uses`; data model §6),
 * so Settings → Credentials and `credentials.list` work while the vault is locked. Nothing
 * here is secret. Tables come from `packages/db/migrations/202610191000_vault_credentials.sql`.
 */
export interface MetaMirror {
  upsert(meta: CredentialMeta): void;
  delete(id: string): void;
  get(id: string): CredentialMeta | undefined;
  list(kind?: CredentialKind): CredentialMeta[];
  recordUse(use: CredentialUse): void;
  uses(credentialId: string, limit: number): CredentialUse[];
  /** True when a fill already succeeded under this approval (a `once` approval fills once). */
  filledUnder(approvalId: string): boolean;
}

interface MetaRaw {
  id: string;
  kind: CredentialKind;
  name: string;
  slug: string;
  bindings: string;
  owner_connector_id: string | null;
  last_used_at: string | null;
  use_count: number;
  created_at: string;
  updated_at: string;
}

interface UseRaw {
  id: string;
  credential_id: string;
  task_id: string | null;
  approval_id: string | null;
  executor: CredentialUse["executor"];
  target: string;
  outcome: CredentialUse["outcome"];
  reason: string | null;
  created_at: string;
}

const metaFromRaw = (r: MetaRaw): CredentialMeta => ({
  id: r.id,
  kind: r.kind,
  name: r.name,
  slug: r.slug,
  bindings: JSON.parse(r.bindings) as CredentialMeta["bindings"],
  ownerConnectorId: r.owner_connector_id,
  lastUsedAt: r.last_used_at,
  useCount: r.use_count,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const useFromRaw = (r: UseRaw): CredentialUse => ({
  id: r.id,
  credentialId: r.credential_id,
  taskId: r.task_id,
  approvalId: r.approval_id,
  executor: r.executor,
  target: r.target,
  outcome: r.outcome,
  reason: r.reason,
  createdAt: r.created_at,
});

export class SqliteMetaMirror implements MetaMirror {
  readonly #db: SqlHandle;

  constructor(db: SqlHandle) {
    this.#db = db;
  }

  upsert(m: CredentialMeta): void {
    this.#db
      .prepare(
        `INSERT INTO credential_meta (id, kind, name, slug, bindings, owner_connector_id, last_used_at, use_count, created_at, updated_at)
         VALUES (@id, @kind, @name, @slug, @bindings, @owner, @lastUsed, @useCount, @created, @updated)
         ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, name = excluded.name, slug = excluded.slug,
           bindings = excluded.bindings, owner_connector_id = excluded.owner_connector_id,
           last_used_at = excluded.last_used_at, use_count = excluded.use_count, updated_at = excluded.updated_at`,
      )
      .run({
        id: m.id,
        kind: m.kind,
        name: m.name,
        slug: m.slug,
        bindings: JSON.stringify(m.bindings),
        owner: m.ownerConnectorId,
        lastUsed: m.lastUsedAt,
        useCount: m.useCount,
        created: m.createdAt,
        updated: m.updatedAt,
      });
  }

  delete(id: string): void {
    this.#db.prepare("DELETE FROM credential_meta WHERE id = ?").run(id);
  }

  get(id: string): CredentialMeta | undefined {
    const r = this.#db.prepare("SELECT * FROM credential_meta WHERE id = ?").get(id) as
      | MetaRaw
      | undefined;
    return r === undefined ? undefined : metaFromRaw(r);
  }

  list(kind?: CredentialKind): CredentialMeta[] {
    const rows = (
      kind === undefined
        ? this.#db.prepare("SELECT * FROM credential_meta ORDER BY name, id").all()
        : this.#db
            .prepare("SELECT * FROM credential_meta WHERE kind = ? ORDER BY name, id")
            .all(kind)
    ) as MetaRaw[];
    return rows.map(metaFromRaw);
  }

  recordUse(u: CredentialUse): void {
    this.#db
      .prepare(
        `INSERT INTO credential_uses (id, credential_id, task_id, approval_id, executor, target, outcome, reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        u.id,
        u.credentialId,
        u.taskId,
        u.approvalId,
        u.executor,
        u.target,
        u.outcome,
        u.reason,
        u.createdAt,
      );
    if (u.outcome === "filled") {
      this.#db
        .prepare(
          "UPDATE credential_meta SET use_count = use_count + 1, last_used_at = ? WHERE id = ?",
        )
        .run(u.createdAt, u.credentialId);
    }
  }

  filledUnder(approvalId: string): boolean {
    return (
      this.#db
        .prepare(
          "SELECT 1 FROM credential_uses WHERE approval_id = ? AND outcome = 'filled' LIMIT 1",
        )
        .get(approvalId) !== undefined
    );
  }

  uses(credentialId: string, limit: number): CredentialUse[] {
    const rows = this.#db
      .prepare(
        "SELECT * FROM credential_uses WHERE credential_id = ? ORDER BY created_at DESC, id DESC LIMIT ?",
      )
      .all(credentialId, limit) as UseRaw[];
    return rows.map(useFromRaw);
  }
}
