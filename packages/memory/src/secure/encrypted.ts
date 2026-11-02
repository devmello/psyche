/// <reference path="./better-sqlite3-multiple-ciphers.d.ts" />
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
import { PsycheError } from "@psyche/protocol";
import Database from "better-sqlite3-multiple-ciphers";
import * as sqliteVec from "sqlite-vec";

/**
 * Building blocks for the encrypted memory store (docs/design/everything-memory-2026.md §11,
 * decision 9; spike in docs/design/em-s1-sqlcipher-spike.md). Nothing here moves the Gateway's
 * data yet: these are the pieces the move needs, each tested on its own.
 *
 * - `openEncrypted`: a SQLCipher file (SQLCipher 4 defaults, raw 32-byte key, WAL, secure delete)
 *   that still speaks FTS5 and sqlite-vec.
 * - `MemoryKeyFile`: the data key on disk at mode 0600, replaced atomically.
 * - `copyTables`: copies tables (with their indexes, triggers and FTS5 tables) from the plaintext
 *   `psyche.sqlite` into the encrypted file, verified by row counts.
 * - `deleteEverything`: empties the memory tables, re-keys with a fresh key (so free pages are
 *   unreadable) and vacuums.
 */

/** Tables that move to `state/memory.sqlite`: the graph, the memory index and everything memory. */
export const MEMORY_STORE_TABLES = [
  "memory_files",
  "memory_claims",
  "memory_chunks",
  "memory_jobs",
  "memory_state",
  "memory_recalls",
  "graph_entities",
  "graph_identifiers",
  "graph_aliases",
  "graph_facts",
  "graph_edges",
  "graph_interactions",
  "graph_participants",
  "graph_loops",
  "graph_suggestions",
  "graph_feedback",
  "graph_blocklist",
  "graph_cursors",
  "graph_citations",
  "graph_exclusions",
  "graph_fact_vectors",
  "memory_runs",
  "memory_quarantine",
  "memory_never_rules",
  "memory_trusted_senders",
  "memory_extracted_items",
  "memory_claim_subjects",
  "memory_fts",
  "graph_fts",
] as const;

export type EncryptedDb = Database.Database;

export const newKey = (): Buffer => randomBytes(32);

const KEY_LITERAL = (key: Buffer): string => `x'${key.toString("hex")}'`;

function keyPragma(db: EncryptedDb, key: Buffer): void {
  db.pragma("cipher='sqlcipher'");
  db.pragma("legacy=4");
  // Raw-key mode: the key goes in as a blob literal, so there is no key derivation to pay for.
  db.pragma(`key="${KEY_LITERAL(key)}"`);
}

/** Opens (or creates) an encrypted database; `unauthorized` when the key is wrong. */
export function openEncrypted(
  path: string,
  key: Buffer,
  opts: { vec?: boolean } = {},
): EncryptedDb {
  if (key.length !== 32) throw new PsycheError("invalid_params", "the memory key must be 32 bytes");
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    if (!existsSync(path)) closeSync(openSync(path, "a", 0o600));
    chmodSync(path, 0o600);
  }
  const db = new Database(path);
  try {
    keyPragma(db, key);
    // `PRAGMA key` never fails; the first read does.
    db.prepare("SELECT count(*) AS n FROM sqlite_master").get();
  } catch {
    db.close();
    throw new PsycheError("unauthorized", "the memory key does not open this database");
  }
  db.pragma("secure_delete=ON");
  db.pragma("foreign_keys=ON");
  if (path !== ":memory:") db.pragma("journal_mode=WAL");
  if (opts.vec === true) db.loadExtension(sqliteVec.getLoadablePath());
  return db;
}

/**
 * The data key on disk (server mode and the first step on a Mac). Mode 0600 in a 0700 directory,
 * written through a temp file and renamed, refused if its mode is wider or it is owned by another
 * user. A Mac with a helper should hold it in the keychain without a Touch ID prompt (the nightly
 * pass must start at 3 a.m.): that needs a helper capability that does not exist yet.
 */
export class MemoryKeyFile {
  readonly #path: string;

  constructor(path: string) {
    this.#path = path;
  }

  get path(): string {
    return this.#path;
  }

  exists(): boolean {
    return existsSync(this.#path);
  }

  /** Why the file cannot be trusted, or null. */
  problem(): string | null {
    try {
      const st = statSync(this.#path);
      if (!st.isFile()) return "the memory key is not a regular file";
      if ((st.mode & 0o077) !== 0) return "the memory key file must be mode 0600";
      if (typeof process.getuid === "function" && st.uid !== process.getuid()) {
        return "the memory key file is owned by another user";
      }
      return null;
    } catch {
      return "the memory key file is missing";
    }
  }

  load(): Buffer {
    const why = this.problem();
    if (why !== null) throw new PsycheError("unavailable", why);
    const key = Buffer.from(readFileSync(this.#path, "utf8").trim(), "hex");
    if (key.length !== 32)
      throw new PsycheError("unavailable", "the memory key file is not a 32-byte key");
    return key;
  }

  loadOrCreate(): { key: Buffer; created: boolean } {
    if (this.exists()) return { key: this.load(), created: false };
    const key = newKey();
    this.write(key);
    return { key, created: true };
  }

  write(key: Buffer): void {
    mkdirSync(dirname(this.#path), { recursive: true, mode: 0o700 });
    const tmp = `${this.#path}.${process.pid}.tmp`;
    const fd = openSync(tmp, "w", 0o600);
    try {
      writeSync(fd, `${key.toString("hex")}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.#path);
  }
}

interface MasterRow {
  type: string;
  name: string;
  tbl_name: string;
  sql: string | null;
}

export interface CopyReport {
  tables: Record<string, number>;
  /** Rows now in the destination, per table, equal to the source (checked). */
  verified: true;
}

const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`;

/** A connection rows can be read from or written to (plain `better-sqlite3` or the encrypted one). */
export interface RowConn {
  prepare(sql: string): {
    all(...a: unknown[]): unknown[];
    get(...a: unknown[]): unknown;
    run(...a: unknown[]): { changes: number };
    iterate(...a: unknown[]): IterableIterator<unknown>;
    raw(on?: boolean): unknown;
  };
  exec(sql: string): unknown;
  pragma(sql: string): unknown;
  transaction<T>(fn: () => T): () => T;
}

const columnsOf = (db: RowConn, table: string): string[] =>
  (db.prepare(`PRAGMA table_info(${quote(table)})`).all() as { name: string }[]).map((c) => c.name);

/**
 * Streams the rows of `table` from one connection into the same table of another, by the columns
 * both have. Each side is written only through its own connection: the plain file and the
 * encrypted one are opened by two different SQLite libraries, which must never share a file
 * (their locks do not see each other), so nothing is ATTACHed across them.
 */
export function streamRows(from: RowConn, to: RowConn, table: string): number {
  const shared = columnsOf(from, table).filter((c) => columnsOf(to, table).includes(c));
  if (shared.length === 0) return 0;
  const list = shared.map(quote).join(", ");
  const read = from.prepare(`SELECT ${list} FROM ${quote(table)}`);
  read.raw(true);
  const write = to.prepare(
    `INSERT INTO ${quote(table)} (${list}) VALUES (${shared.map(() => "?").join(", ")})`,
  );
  let n = 0;
  for (const row of read.iterate() as IterableIterator<unknown[]>) {
    write.run(...row);
    n++;
  }
  return n;
}

const countOf = (db: RowConn, table: string): number =>
  (db.prepare(`SELECT count(*) AS n FROM ${quote(table)}`).get() as { n: number }).n;

/**
 * Copies `tables` from the plain database (`source`, its own open connection) into `dest` (an open
 * encrypted database): the tables and their indexes and triggers, then the rows, then a row-count
 * check and a foreign-key check. The source is only read. Tables the source does not have are
 * skipped. FTS5 tables are copied by content, or rebuilt when they index another table.
 */
export function copyTables(
  dest: EncryptedDb,
  source: RowConn,
  tables: readonly string[],
): CopyReport {
  const master = source
    .prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL")
    .all() as MasterRow[];
  const wanted = new Set(tables);
  const isVirtual = (r: MasterRow) => /^CREATE VIRTUAL TABLE/i.test(r.sql ?? "");
  const virtuals = master.filter((r) => r.type === "table" && isVirtual(r) && wanted.has(r.name));
  // FTS5 keeps its own shadow tables (`<name>_data`, …); creating the virtual table makes them.
  const shadow = (r: MasterRow) => virtuals.some((v) => r.name.startsWith(`${v.name}_`));
  const plain = master.filter(
    (r) => r.type === "table" && !isVirtual(r) && wanted.has(r.name) && !shadow(r),
  );
  const report: CopyReport = { tables: {}, verified: true };
  const to = dest as unknown as RowConn;
  dest.exec("PRAGMA foreign_keys=OFF");
  try {
    // One read snapshot of the source for the whole copy, so the counts below compare like with like.
    source.exec("BEGIN");
    try {
      dest.transaction(() => {
        for (const t of plain) dest.exec(t.sql as string);
        for (const v of virtuals) dest.exec(v.sql as string);
        for (const t of plain) report.tables[t.name] = streamRows(source, to, t.name);
        for (const v of virtuals) {
          if (/content\s*=\s*'/i.test(v.sql as string))
            dest.exec(`INSERT INTO ${quote(v.name)}(${quote(v.name)}) VALUES ('rebuild')`);
          else report.tables[v.name] = streamRows(source, to, v.name);
        }
        // Indexes and triggers last, so the copy does not fire them.
        for (const r of master) {
          if ((r.type === "index" || r.type === "trigger") && wanted.has(r.tbl_name))
            dest.exec(r.sql as string);
        }
      })();
      for (const t of plain) {
        const a = countOf(to, t.name);
        const b = countOf(source, t.name);
        if (a !== b)
          throw new PsycheError("internal", `copy of ${t.name} is incomplete (${a} of ${b})`);
      }
    } finally {
      source.exec("COMMIT");
    }
    const broken = dest.pragma("foreign_key_check") as unknown[];
    if (broken.length > 0) throw new PsycheError("internal", "the copy broke a foreign key");
    return report;
  } finally {
    dest.exec("PRAGMA foreign_keys=ON");
  }
}

/**
 * "Delete everything Psyche learned" for the encrypted store (§11.3): every row of the memory
 * tables goes, with secure delete; then the file is re-keyed with a fresh key so any page that
 * still holds old data is unreadable, vacuumed and checkpointed. Returns the new key, which the
 * caller must persist (through the key file) before anything else opens the database.
 */
export function deleteEverything(
  db: EncryptedDb,
  opts: { keep?: readonly string[]; vec?: readonly string[] } = {},
): { newKey: Buffer; tables: number } {
  const keep = new Set(opts.keep ?? []);
  const names = (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[]
  ).map((r) => r.name);
  db.pragma("secure_delete=ON");
  db.exec("PRAGMA foreign_keys=OFF");
  let tables = 0;
  db.transaction(() => {
    for (const name of names) {
      if (keep.has(name)) continue;
      // FTS5 shadow tables empty with their virtual table; delete only plain and virtual tables.
      if (
        /_(data|idx|content|docsize|config)$/.test(name) &&
        names.includes(name.replace(/_[a-z]+$/, ""))
      )
        continue;
      db.exec(`DELETE FROM ${quote(name)}`);
      tables++;
    }
  })();
  for (const v of opts.vec ?? []) db.exec(`DROP TABLE IF EXISTS ${quote(v)}`);
  db.exec("PRAGMA foreign_keys=ON");
  const newKey = newKey_();
  db.pragma(`rekey="${KEY_LITERAL(newKey)}"`);
  db.exec("VACUUM");
  db.pragma("wal_checkpoint(TRUNCATE)");
  return { newKey, tables };
}

const newKey_ = newKey;
