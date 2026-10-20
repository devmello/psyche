import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Upgrade checks (roadmap v1.0, "migration guides"; docs/guides/upgrade.md).
 *
 * The Gateway applies `packages/db/migrations` itself when it opens the database. `psyche
 * migrate --check` answers, before you start a new version on old data: which migrations it
 * will apply, whether the data is newer than this build (a downgrade, which the Gateway refuses)
 * and whether an applied migration was edited. It reads only the `_migrations` table, read-only;
 * it never writes the database.
 */

export interface MigrationRef {
  id: string;
  checksum: string;
}

export interface MigrationPlan {
  /** Known to this build, not yet applied: the Gateway applies them at its next start. */
  pending: string[];
  /** Applied in the database but unknown to this build: the data is from a newer version. */
  unknown: string[];
  /** Applied with a different checksum than this build ships. */
  modified: string[];
  applied: number;
}

/** Same rule as `@psyche/db` `checksumOf`: sha256 of the file with CRLF normalized. */
export function migrationChecksum(sql: string): string {
  return `sha256:${createHash("sha256").update(sql.replace(/\r\n/g, "\n"), "utf8").digest("hex")}`;
}

/** Set by the release bundler (`--define __PSYCHE_MIGRATIONS__=<json>`), absent from source. */
declare const __PSYCHE_MIGRATIONS__: string | undefined;

const MIGRATION_FILE = /^\d{12}_[a-z0-9-]+_[a-z0-9_-]+\.sql$/;

export function migrationsFromDir(dir: string): MigrationRef[] {
  return readdirSync(dir)
    .filter((n) => MIGRATION_FILE.test(n))
    .sort()
    .map((n) => ({
      id: n.slice(0, -".sql".length),
      checksum: migrationChecksum(readFileSync(join(dir, n), "utf8")),
    }));
}

/**
 * The migrations this build ships: baked in by the release build, else read next to the
 * sources (a checkout or the Docker image, which keeps the workspace layout).
 */
export function knownMigrations(): MigrationRef[] | null {
  if (typeof __PSYCHE_MIGRATIONS__ === "string")
    return JSON.parse(__PSYCHE_MIGRATIONS__) as MigrationRef[];
  const dir = resolve(import.meta.dirname, "../../../packages/db/migrations");
  return existsSync(dir) ? migrationsFromDir(dir) : null;
}

export function planMigrations(
  applied: readonly MigrationRef[],
  known: readonly MigrationRef[],
): MigrationPlan {
  const knownById = new Map(known.map((m) => [m.id, m.checksum]));
  const appliedById = new Map(applied.map((m) => [m.id, m.checksum]));
  return {
    pending: known.filter((m) => !appliedById.has(m.id)).map((m) => m.id),
    unknown: applied.filter((m) => !knownById.has(m.id)).map((m) => m.id),
    modified: applied
      .filter((m) => knownById.has(m.id) && knownById.get(m.id) !== m.checksum)
      .map((m) => m.id),
    applied: applied.length,
  };
}

interface ReadOnlyDb {
  all(sql: string): unknown[];
  close(): void;
}

/** node:sqlite under Node, bun:sqlite in the compiled binary; read-only either way. */
async function openReadOnly(path: string): Promise<ReadOnlyDb> {
  if ((process.versions as Record<string, string | undefined>).bun) {
    const specifier = "bun:sqlite";
    const { Database } = (await import(specifier)) as {
      Database: new (
        p: string,
        o: { readonly: boolean },
      ) => {
        query(sql: string): { all(): unknown[] };
        close(): void;
      };
    };
    const db = new Database(path, { readonly: true });
    return { all: (sql) => db.query(sql).all(), close: () => db.close() };
  }
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path, { readOnly: true });
  return { all: (sql) => db.prepare(sql).all(), close: () => db.close() };
}

/** `_migrations` rows of the database at `path`; `[]` for a database that has none yet. */
export async function appliedMigrations(path: string): Promise<MigrationRef[]> {
  const db = await openReadOnly(path);
  try {
    const table = db.all(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = '_migrations'",
    );
    if (table.length === 0) return [];
    return (db.all("SELECT id, checksum FROM _migrations ORDER BY id") as MigrationRef[]).map(
      (r) => ({
        id: String(r.id),
        checksum: String(r.checksum),
      }),
    );
  } finally {
    db.close();
  }
}
