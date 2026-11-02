import { PsycheError } from "@psyche/protocol";
import { type RowConn, streamRows } from "./encrypted.ts";

/**
 * Keeping the encrypted memory store in step with `psyche.sqlite` (docs/design/em9-encrypted-store.md).
 *
 * - `syncSchema`: `psyche.sqlite`'s migrations are the one source of the memory tables' shape. When
 *   a moved table's definition there differs from the encrypted file's, the table is rebuilt in the
 *   file from the plain definition, keeping every column the two share (SQLite's documented
 *   "make other kinds of table schema changes" procedure), with its indexes and triggers.
 * - `copyBack`: the way back (turning encryption off): every row of the moved tables returns to
 *   the plain file, replacing whatever stale rows it still had, verified by counts.
 * - `clearPlain`: once a verified copy exists in the encrypted file, the plain rows are deleted
 *   with secure delete and the file vacuumed, so the old text is not left readable.
 *
 * Data-only migrations (UPDATE/INSERT/DELETE on a moved table) cannot be replayed this way; the
 * migrations lint test fails if a new one appears.
 */

interface MasterRow {
  type: string;
  name: string;
  tbl_name: string;
  sql: string | null;
}

/** Anything with `prepare`/`exec`: the plain or the encrypted connection. */
export interface SqlConn {
  prepare(sql: string): {
    all(...a: unknown[]): unknown[];
    get(...a: unknown[]): unknown;
    run(...a: unknown[]): { changes: number };
  };
  exec(sql: string): unknown;
  pragma(sql: string): unknown;
  transaction<T>(fn: () => T): () => T;
}

const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`;
const isVirtual = (sql: string | null): boolean => /^CREATE VIRTUAL TABLE/i.test(sql ?? "");

function master(db: SqlConn, schema = "main"): MasterRow[] {
  return db
    .prepare(`SELECT type, name, tbl_name, sql FROM ${schema}.sqlite_master WHERE sql IS NOT NULL`)
    .all() as MasterRow[];
}

const columns = (db: SqlConn, schema: string, table: string): string[] =>
  (db.prepare(`PRAGMA ${schema}.table_info(${quote(table)})`).all() as { name: string }[]).map(
    (c) => c.name,
  );

const count = (db: SqlConn, schema: string, table: string): number =>
  (db.prepare(`SELECT count(*) AS n FROM ${schema}.${quote(table)}`).get() as { n: number }).n;

/** Rebuilds the tables of `enc` whose definition differs from `plain`'s. Returns their names. */
export function syncSchema(enc: SqlConn, plain: SqlConn, tables: readonly string[]): string[] {
  const want = new Map(master(plain).map((r) => [`${r.type}:${r.name}`, r]));
  const have = new Map(master(enc).map((r) => [`${r.type}:${r.name}`, r]));
  const plainAll = master(plain);
  const drifted = tables.filter((t) => {
    const w = want.get(`table:${t}`);
    return w !== undefined && w.sql !== have.get(`table:${t}`)?.sql;
  });
  if (drifted.length === 0) return [];
  enc.exec("PRAGMA foreign_keys=OFF");
  enc.exec("PRAGMA legacy_alter_table=ON");
  try {
    enc.transaction(() => {
      for (const t of drifted) {
        const def = want.get(`table:${t}`) as MasterRow;
        const exists = have.has(`table:${t}`);
        if (isVirtual(def.sql)) {
          // FTS5: recreate and refill. An external-content index is rebuilt from its table; a
          // standalone one keeps the columns both versions have.
          const temp = `${t}__old`;
          if (exists) enc.exec(`ALTER TABLE ${quote(t)} RENAME TO ${quote(temp)}`);
          enc.exec(def.sql as string);
          if (/content\s*=\s*'/i.test(def.sql as string))
            enc.exec(`INSERT INTO ${quote(t)}(${quote(t)}) VALUES ('rebuild')`);
          else if (exists) {
            const shared = columns(enc, "main", temp).filter((c) =>
              columns(enc, "main", t).includes(c),
            );
            const list = shared.map(quote).join(", ");
            enc.exec(`INSERT INTO ${quote(t)} (${list}) SELECT ${list} FROM ${quote(temp)}`);
          }
          if (exists) enc.exec(`DROP TABLE ${quote(temp)}`);
          continue;
        }
        const temp = `${t}__new`;
        enc.exec(
          (def.sql as string).replace(
            /^(CREATE TABLE\s+(?:IF NOT EXISTS\s+)?)("[^"]+"|\S+)/i,
            `$1${quote(temp)}`,
          ),
        );
        if (exists) {
          const before = count(enc, "main", t);
          const shared = columns(enc, "main", t).filter((c) =>
            columns(enc, "main", temp).includes(c),
          );
          const list = shared.map(quote).join(", ");
          enc.exec(`INSERT INTO ${quote(temp)} (${list}) SELECT ${list} FROM ${quote(t)}`);
          if (count(enc, "main", temp) !== before)
            throw new PsycheError("internal", `rebuilding ${t} lost rows`);
          enc.exec(`DROP TABLE ${quote(t)}`);
        }
        enc.exec(`ALTER TABLE ${quote(temp)} RENAME TO ${quote(t)}`);
        for (const r of plainAll)
          if ((r.type === "index" || r.type === "trigger") && r.tbl_name === t)
            enc.exec(r.sql as string);
      }
      const broken = enc.pragma("foreign_key_check") as unknown[];
      if (broken.length > 0) throw new PsycheError("internal", "the rebuild broke a foreign key");
    })();
  } finally {
    enc.exec("PRAGMA legacy_alter_table=OFF");
    enc.exec("PRAGMA foreign_keys=ON");
  }
  return drifted;
}

/**
 * Copies every row of `tables` from the encrypted file (`enc`) back into the plain database
 * (`plain`, its own connection, which has the tables from its migrations), replacing what it held,
 * verified by counts. Each file is written only by its own connection.
 */
export function copyBack(
  enc: RowConn,
  plain: RowConn,
  tables: readonly string[],
): Record<string, number> {
  const rows = master(plain as unknown as SqlConn).filter((r) => r.type === "table");
  const present = new Set(rows.map((r) => r.name));
  const virtual = new Set(rows.filter((r) => isVirtual(r.sql)).map((r) => r.name));
  const external = new Set(
    rows.filter((r) => isVirtual(r.sql) && /content\s*=\s*'/i.test(r.sql ?? "")).map((r) => r.name),
  );
  const out: Record<string, number> = {};
  plain.exec("PRAGMA foreign_keys=OFF");
  try {
    plain.transaction(() => {
      for (const t of tables) {
        if (!present.has(t) || external.has(t)) continue;
        plain.exec(`DELETE FROM ${quote(t)}`);
        out[t] = streamRows(enc, plain, t);
        if (!virtual.has(t) && countOf(plain, t) !== countOf(enc, t))
          throw new PsycheError("internal", `copy back of ${t} is incomplete`);
      }
      for (const t of tables)
        if (external.has(t)) plain.exec(`INSERT INTO ${quote(t)}(${quote(t)}) VALUES ('rebuild')`);
    })();
  } finally {
    plain.exec("PRAGMA foreign_keys=ON");
  }
  const broken = plain.pragma("foreign_key_check") as unknown[];
  if (broken.length > 0) throw new PsycheError("internal", "the copy back broke a foreign key");
  return out;
}

const countOf = (db: RowConn, table: string): number =>
  (db.prepare(`SELECT count(*) AS n FROM ${quote(table)}`).get() as { n: number }).n;

/** Deletes every row of `tables` from the plain database with secure delete, then vacuums. */
export function clearPlain(plain: SqlConn, tables: readonly string[]): number {
  const rows = master(plain).filter((r) => r.type === "table");
  const present = new Set(rows.map((r) => r.name));
  const external = new Set(
    rows.filter((r) => isVirtual(r.sql) && /content\s*=\s*'/i.test(r.sql ?? "")).map((r) => r.name),
  );
  plain.pragma("secure_delete=ON");
  plain.exec("PRAGMA foreign_keys=OFF");
  let n = 0;
  try {
    plain.transaction(() => {
      for (const t of tables) {
        if (!present.has(t)) continue;
        // An index over another table empties with a command, not a DELETE.
        if (external.has(t)) {
          plain.exec(`INSERT INTO ${quote(t)}(${quote(t)}) VALUES ('delete-all')`);
          continue;
        }
        n += plain.prepare(`DELETE FROM ${quote(t)}`).run().changes;
      }
    })();
  } finally {
    plain.exec("PRAGMA foreign_keys=ON");
  }
  plain.exec("VACUUM");
  plain.pragma("wal_checkpoint(TRUNCATE)");
  return n;
}
