import { existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { getSetting, type PsycheDb } from "@psyche/db";
import { copyTables, MEMORY_STORE_TABLES, openEncrypted } from "@psyche/memory";
import { PsycheError } from "@psyche/protocol";
import { type DerivedKeyStore, type KeyWrapper, loadOrCreateSubsystemKey } from "@psyche/vault";
import { DeferredOpen } from "./deferred-open.ts";
import type { VaultSlotChoice } from "./vault.ts";

/**
 * Where the graph, the memory index and everything memory live (docs/design/em9-encrypted-store.md).
 * `memory.encrypt` off (the default and the only state this change can reach from Settings): the
 * stores get `psyche.sqlite` itself, the very same object, so nothing about today's path changes.
 * On: they get a `LateDatabase`, which answers once `state/memory.sqlite` is open with a key from
 * the vault slot or the Mac helper.
 */
export const MEMORY_ENCRYPT_SETTING = "memory.encrypt";
export const MEMORY_KEY_NAME = "memory-store";

export type MemoryStoreState =
  | { state: "off" }
  | { state: "pending"; reason: string }
  | { state: "ready" }
  | { state: "unavailable"; reason: string };

type SqliteDb = PsycheDb["sqlite"];
const READS = /^\s*(?:select|with|explain)\b/i;

const unavailable = (reason: string): PsycheError =>
  new PsycheError("unavailable", `memory store is not open: ${reason}`);

/** A statement while the store is closed: reads see nothing, writes say why they did not happen. */
function closedStatement(sql: string, reason: () => string): unknown {
  const reads = READS.test(sql);
  const write = () => {
    throw unavailable(reason());
  };
  return {
    reader: reads,
    source: sql,
    get: () => (reads ? undefined : write()),
    all: () => (reads ? [] : write()),
    iterate: () => (reads ? [][Symbol.iterator]() : write()),
    pluck: () => closedStatement(sql, reason),
    raw: () => closedStatement(sql, reason),
    run: write,
    bind: () => closedStatement(sql, reason),
  };
}

/**
 * A `better-sqlite3` look-alike for a database that opens later. Nothing is cached or copied in
 * memory: before it opens, reads are empty and every write throws `unavailable` (never lost
 * silently, never written to the plain file); after `attach`, every call goes to the real one.
 */
export class LateDatabase {
  #db: SqliteDb | undefined;
  #reason = "waiting for the key";
  readonly #onReady: (() => void)[] = [];
  readonly handle: SqliteDb;

  constructor() {
    const self = this;
    this.handle = new Proxy({} as SqliteDb, {
      get(_t, prop) {
        const db = self.#db;
        if (db !== undefined) {
          const v = (db as unknown as Record<string | symbol, unknown>)[prop];
          return typeof v === "function" ? v.bind(db) : v;
        }
        switch (prop) {
          case "prepare":
            return (sql: string) => closedStatement(sql, () => self.#reason);
          case "pragma":
            return () => [];
          case "name":
            return "memory.sqlite (closed)";
          case "open":
            return false;
          case "inTransaction":
            return false;
          case "exec":
          case "transaction":
          case "loadExtension":
          case "backup":
          case "function":
          case "aggregate":
            return () => {
              throw unavailable(self.#reason);
            };
          default:
            return undefined;
        }
      },
    });
  }

  get ready(): boolean {
    return this.#db !== undefined;
  }

  setReason(reason: string): void {
    this.#reason = reason;
  }

  get reason(): string {
    return this.#reason;
  }

  attach(db: SqliteDb): void {
    this.#db = db;
    for (const f of this.#onReady.splice(0)) f();
  }

  /** Runs once the database is open (at once if it already is). */
  whenReady(fn: () => void): void {
    if (this.#db !== undefined) fn();
    else this.#onReady.push(fn);
  }

  close(): void {
    this.#db?.close();
    this.#db = undefined;
  }
}

export interface MemoryHandle {
  /** What the stores use: `psyche.sqlite` itself when encryption is off. */
  sqlite: SqliteDb;
  /** The late database, only when encryption is on. */
  late: LateDatabase | undefined;
  status(): MemoryStoreState;
  /** Opens the encrypted file once its key arrives (a no-op when off). */
  start(): void;
  stop(): void;
}

const INTERACTIVE_SLOTS: readonly VaultSlotChoice[] = ["keychain"];

/** Tables whose definition differs between the plain database and the encrypted file. */
export function schemaDrift(plain: SqliteDb, enc: SqliteDb): string[] {
  const sql = (db: SqliteDb, t: string) =>
    (
      db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(t) as
        | { sql: string }
        | undefined
    )?.sql;
  return MEMORY_STORE_TABLES.filter((t) => {
    const a = sql(plain, t);
    return a !== undefined && a !== sql(enc, t);
  });
}

export function resolveMemoryStore(o: {
  db: PsycheDb;
  home: string;
  wrapper: KeyWrapper;
  slot: VaultSlotChoice;
  derived?: Pick<DerivedKeyStore, "getOrCreate" | "unavailableReason">;
  log?: (msg: string) => void;
}): MemoryHandle {
  if (getSetting(o.db, MEMORY_ENCRYPT_SETTING)?.value !== true) {
    return {
      sqlite: o.db.sqlite,
      late: undefined,
      status: () => ({ state: "off" }),
      start: () => undefined,
      stop: () => undefined,
    };
  }
  const late = new LateDatabase();
  const path = join(o.home, "state", "memory.sqlite");
  const keyFile = join(o.home, "state", "memory.key.json");
  let failure: string | undefined;
  const provider = async (): Promise<Buffer | undefined> => {
    if (INTERACTIVE_SLOTS.includes(o.slot)) {
      const derived = o.derived;
      if (derived === undefined) throw new Error("the Mac helper is not available on this host");
      if ((await derived.unavailableReason()) !== null) return undefined;
      return (await derived.getOrCreate(MEMORY_KEY_NAME)).key;
    }
    return (await loadOrCreateSubsystemKey(keyFile, o.wrapper, "Open the memory store")).key;
  };
  const opener = new DeferredOpen<SqliteDb>({
    provider,
    open: (key) => {
      const fresh = !existsSync(path);
      const enc = openEncrypted(path, key, { vec: true });
      try {
        if (fresh) copyTables(enc, o.db.sqlite.name, MEMORY_STORE_TABLES);
        const drift = schemaDrift(o.db.sqlite, enc);
        if (drift.length > 0)
          throw new Error(`the encrypted memory store is out of date (${drift.join(", ")})`);
      } catch (err) {
        enc.close();
        // A file this attempt created is not kept half-filled: the next attempt starts clean.
        if (fresh) for (const x of ["", "-wal", "-shm"]) rmSync(`${path}${x}`, { force: true });
        failure = err instanceof Error ? err.message : String(err);
        o.log?.(`memory: ${failure}`);
        throw err;
      }
      return enc;
    },
    onReady: (enc) => late.attach(enc),
    onWaiting: (reason) => late.setReason(reason),
  });
  return {
    sqlite: late.handle,
    late,
    status: () =>
      late.ready
        ? { state: "ready" }
        : failure !== undefined
          ? { state: "unavailable", reason: failure }
          : { state: "pending", reason: opener.reason },
    start: () => opener.start(),
    stop: () => {
      opener.stop();
      late.close();
    },
  };
}

/** `dirname` of the memory file, for callers that need to create it. */
export const memoryStatePath = (home: string): string =>
  dirname(join(home, "state", "memory.sqlite"));
