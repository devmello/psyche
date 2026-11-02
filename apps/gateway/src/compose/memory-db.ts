import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { deleteSettings, getSetting, type PsycheDb, setSetting } from "@psyche/db";
import {
  clearPlain,
  copyBack,
  copyTables,
  MEMORY_STORE_TABLES,
  openEncrypted,
  syncSchema,
} from "@psyche/memory";
import { type MemoryStoreStatus, PsycheError } from "@psyche/protocol";
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
  #owned = false;
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

  /** Points every caller at another database (the plain one, after turning encryption off). */
  replace(db: SqliteDb): void {
    this.#db = db;
    this.#owned = false;
  }

  attach(db: SqliteDb): void {
    this.#db = db;
    this.#owned = true;
    for (const f of this.#onReady.splice(0)) f();
  }

  /** Runs once the database is open (at once if it already is). */
  whenReady(fn: () => void): void {
    if (this.#db !== undefined) fn();
    else this.#onReady.push(fn);
  }

  /** Closes the encrypted file it opened; never a database it was only pointed at. */
  close(): void {
    if (this.#owned) this.#db?.close();
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
  /**
   * Turns encryption off now: copies every row back into psyche.sqlite (verified), then points
   * the stores at it and deletes the encrypted file and its key. Throws while the file is closed.
   */
  turnOff(): Promise<void>;
}

const INTERACTIVE_SLOTS: readonly VaultSlotChoice[] = ["keychain"];

/**
 * Where a move into the encrypted file stands, in `psyche.sqlite` (so a crash at any step resumes):
 * absent = never moved (or moved back); `copied` = the encrypted file holds a verified copy but the
 * plain rows are still there; `cleared` = the plain rows are gone and the encrypted file is the
 * only copy.
 */
export const MEMORY_MOVE_STATE = "memory.encrypt.state";

type MoveState = "copied" | "cleared" | undefined;

const moveState = (db: PsycheDb): MoveState => {
  const v = getSetting(db, MEMORY_MOVE_STATE)?.value;
  return v === "copied" || v === "cleared" ? v : undefined;
};

const removeFiles = (path: string) => {
  for (const x of ["", "-wal", "-shm"]) rmSync(`${path}${x}`, { force: true });
};

export function resolveMemoryStore(o: {
  db: PsycheDb;
  home: string;
  wrapper: KeyWrapper;
  slot: VaultSlotChoice;
  derived?: Pick<DerivedKeyStore, "getOrCreate" | "unavailableReason">;
  log?: (msg: string) => void;
}): MemoryHandle {
  const wanted = getSetting(o.db, MEMORY_ENCRYPT_SETTING)?.value === true;
  // Once the plain rows are gone the encrypted file is the only copy: it is opened whatever the
  // switch says, until "turn off" has copied everything back.
  if (!wanted && moveState(o.db) !== "cleared") {
    return {
      sqlite: o.db.sqlite,
      late: undefined,
      status: () => ({ state: "off" }),
      start: () => undefined,
      stop: () => undefined,
      turnOff: async () => undefined,
    };
  }
  if (!wanted) o.log?.("memory: the encrypted store holds the only copy; opening it");
  const late = new LateDatabase();
  const path = join(o.home, "state", "memory.sqlite");
  const keyFile = join(o.home, "state", "memory.key.json");
  let failure: string | undefined;
  let enc: SqliteDb | undefined;
  let turnedOff = false;
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
      const state = moveState(o.db);
      // A file from an attempt that never finished its copy is not trusted: start it again.
      if (state === undefined) removeFiles(path);
      const fresh = !existsSync(path);
      if (fresh && state === "cleared")
        throw new Error("the encrypted memory store is missing and the plain copy was cleared");
      const db = openEncrypted(path, key, { vec: true });
      try {
        if (fresh) {
          copyTables(db, o.db.sqlite, MEMORY_STORE_TABLES);
          setSetting(o.db, MEMORY_MOVE_STATE, "copied");
        } else {
          // Later migrations of psyche.sqlite reach the encrypted file here.
          const rebuilt = syncSchema(db, o.db.sqlite, MEMORY_STORE_TABLES);
          if (rebuilt.length > 0) o.log?.(`memory: updated ${rebuilt.join(", ")}`);
        }
        if (moveState(o.db) === "copied") {
          clearPlain(o.db.sqlite, MEMORY_STORE_TABLES);
          setSetting(o.db, MEMORY_MOVE_STATE, "cleared");
        }
      } catch (err) {
        db.close();
        if (fresh) {
          removeFiles(path);
          if (moveState(o.db) === "copied") deleteSettings(o.db, [MEMORY_MOVE_STATE]);
        }
        failure = err instanceof Error ? err.message : String(err);
        o.log?.(`memory: ${failure}`);
        throw err;
      }
      failure = undefined;
      enc = db;
      return db;
    },
    onReady: (db) => late.attach(db),
    onWaiting: (reason) => late.setReason(reason),
  });
  return {
    sqlite: late.handle,
    late,
    status: () =>
      turnedOff
        ? { state: "off" }
        : late.ready
          ? { state: "ready" }
          : failure !== undefined
            ? { state: "unavailable", reason: failure }
            : { state: "pending", reason: opener.reason },
    start: () => opener.start(),
    stop: () => {
      opener.stop();
      late.close();
    },
    turnOff: async () => {
      if (turnedOff) return;
      if (enc === undefined)
        throw new PsycheError("unavailable", "the memory store is not open yet; try again shortly");
      // Everything goes back to psyche.sqlite first; only then is the encrypted file removed.
      copyBack(enc, o.db.sqlite, MEMORY_STORE_TABLES);
      setSetting(o.db, MEMORY_ENCRYPT_SETTING, false);
      deleteSettings(o.db, [MEMORY_MOVE_STATE]);
      late.replace(o.db.sqlite);
      enc.close();
      enc = undefined;
      removeFiles(path);
      rmSync(keyFile, { force: true });
      turnedOff = true;
    },
  };
}

/** What Settings shows (`memory.status` → `store`). */
export function memoryStoreStatus(db: PsycheDb, handle: MemoryHandle): MemoryStoreStatus {
  const encrypted = getSetting(db, MEMORY_ENCRYPT_SETTING)?.value === true;
  const s = handle.status();
  return {
    encrypted,
    state: s.state,
    reason: "reason" in s ? s.reason : null,
    restartNeeded: encrypted && s.state === "off",
  };
}

/** `memory.store.setEncrypted`: on at the next start; off now, after copying everything back. */
export async function setMemoryEncrypted(
  db: PsycheDb,
  handle: MemoryHandle,
  on: boolean,
): Promise<MemoryStoreStatus> {
  if (on) setSetting(db, MEMORY_ENCRYPT_SETTING, true);
  else if (handle.status().state === "off") setSetting(db, MEMORY_ENCRYPT_SETTING, false);
  else await handle.turnOff();
  return memoryStoreStatus(db, handle);
}
