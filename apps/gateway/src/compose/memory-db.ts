import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { deleteSettings, getSetting, openDb, type PsycheDb, setSetting } from "@psyche/db";
import {
  clearPlain,
  copyBack,
  copyTables,
  isEmpty,
  MEMORY_STORE_TABLES,
  newKey,
  openEncrypted,
  restorePlain,
  syncSchema,
  verifySame,
} from "@psyche/memory";
import { type MemoryStoreStatus, PsycheError } from "@psyche/protocol";
import {
  type DerivedKeyStore,
  type KeyWrapper,
  loadOrCreateSubsystemKey,
  type SealedBox,
  writeSubsystemKey,
} from "@psyche/vault";
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

/** A failure after which no copy may be discarded: the encrypted file or the backup is needed. */
class Unrecoverable extends Error {}

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
  /**
   * Turning on: makes the key (or keeps the one there is), seals a copy under the vault's own key
   * in `state/memory.key.escrow.json` (so a restore on a new Mac with the vault's recovery key can
   * open the file), checks the sealed copy opens, and only then sets the switch. Effective at the
   * next start. Needs the vault unlocked.
   */
  enable(): Promise<void>;
  /** For a backup: writes a consistent copy of the open encrypted file (still encrypted) to `dest`. */
  snapshot(): ((dest: string) => Promise<void>) | undefined;
  /** After a backup: an encrypted backup taken after a verified move lets the safety copy go. */
  afterBackup(encrypted: boolean): void;
  /** The unencrypted copy kept from before the move: there, removed, or never made. */
  safetyCopy(): "kept" | "removed" | null;
}

/** The vault's escrow, for the memory key (sealed under the vault's own key). */
export interface KeyEscrow {
  readonly locked: boolean;
  escrow(name: string, data: Buffer): SealedBox;
  unescrow(name: string, box: SealedBox): Buffer;
}

const INTERACTIVE_SLOTS: readonly VaultSlotChoice[] = ["keychain"];

/** Where the copy of psyche.sqlite from before the move is kept (outside what backups include). */
export const SAFETY_COPY = join("safety", "memory.pre-encrypt.sqlite");
/** `{ movedAt, openedAgain, removedAt? }`: the safety copy's life. */
export const MEMORY_SAFETY = "memory.encrypt.safety";

interface Safety {
  movedAt: string;
  openedAgain: boolean;
  removedAt?: string;
}

const safetyOf = (db: PsycheDb): Safety | undefined => {
  const v = getSetting(db, MEMORY_SAFETY)?.value as Safety | undefined;
  return v !== undefined && typeof v === "object" && typeof v.movedAt === "string" ? v : undefined;
};

/** Overwrites a file with zeros and removes it (best effort on SSDs: see the design note). */
function shred(path: string): void {
  if (!existsSync(path)) return;
  const size = statSync(path).size;
  const fd = openSync(path, "r+");
  try {
    const zeros = Buffer.alloc(1 << 20);
    for (let at = 0; at < size; at += zeros.length)
      writeSync(fd, zeros, 0, Math.min(zeros.length, size - at), at);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  rmSync(path, { force: true });
}

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
  derived?: Pick<DerivedKeyStore, "get" | "put" | "remove" | "unavailableReason">;
  /** The vault: seals the memory key for recovery, and opens it on a new Mac. */
  escrow?: KeyEscrow;
  log?: (msg: string) => void;
}): MemoryHandle {
  const keyFile = join(o.home, "state", "memory.key.json");
  const escrowFile = join(o.home, "state", "memory.key.escrow.json");
  const safetyPath = join(o.home, SAFETY_COPY);
  const interactive = INTERACTIVE_SLOTS.includes(o.slot);
  /** The key this host holds (the helper's item, or the wrapped key file); never makes one. */
  const heldKey = async (): Promise<Buffer | undefined> => {
    if (interactive) {
      if (o.derived === undefined) throw new Error("the Mac helper is not available on this host");
      if ((await o.derived.unavailableReason()) !== null) return undefined;
      return await o.derived.get(MEMORY_KEY_NAME);
    }
    if (!existsSync(keyFile)) return undefined;
    return (await loadOrCreateSubsystemKey(keyFile, o.wrapper, "Open the memory store")).key;
  };
  const holdKey = async (key: Buffer): Promise<void> => {
    if (interactive) {
      if (o.derived === undefined) throw new Error("the Mac helper is not available on this host");
      await o.derived.put(MEMORY_KEY_NAME, key);
      return;
    }
    rmSync(keyFile, { force: true });
    await writeSubsystemKey(keyFile, o.wrapper, key, "Open the memory store");
  };
  const readEscrow = (): SealedBox | undefined => {
    if (!existsSync(escrowFile)) return undefined;
    return (JSON.parse(readFileSync(escrowFile, "utf8")) as { box: SealedBox }).box;
  };
  const safetyCopy = (): "kept" | "removed" | null => {
    const s = safetyOf(o.db);
    return s === undefined ? null : s.removedAt !== undefined ? "removed" : "kept";
  };
  const removeSafety = () => {
    shred(safetyPath);
    const s = safetyOf(o.db);
    if (s !== undefined)
      setSetting(o.db, MEMORY_SAFETY, { ...s, removedAt: new Date().toISOString() });
    o.log?.("memory: the unencrypted safety copy was removed after an encrypted backup");
  };
  const enable = async (): Promise<void> => {
    const vault = o.escrow;
    if (vault === undefined) throw new PsycheError("unavailable", "the vault is not set up");
    if (vault.locked)
      throw new PsycheError(
        "unavailable",
        "unlock the vault first: it keeps a copy of the memory key",
      );
    const key = (await heldKey()) ?? newKey();
    await holdKey(key);
    const box = vault.escrow(MEMORY_KEY_NAME, key);
    if (!vault.unescrow(MEMORY_KEY_NAME, box).equals(key))
      throw new PsycheError("internal", "the sealed copy of the memory key did not open");
    mkdirSync(join(o.home, "state"), { recursive: true, mode: 0o700 });
    const tmp = `${escrowFile}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ v: 1, box })}\n`, { mode: 0o600 });
    renameSync(tmp, escrowFile);
    setSetting(o.db, MEMORY_ENCRYPT_SETTING, true);
  };
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
      enable,
      snapshot: () => undefined,
      afterBackup: () => undefined,
      safetyCopy,
    };
  }
  if (!wanted) o.log?.("memory: the encrypted store holds the only copy; opening it");
  const late = new LateDatabase();
  const path = join(o.home, "state", "memory.sqlite");
  let failure: string | undefined;
  let enc: SqliteDb | undefined;
  let turnedOff = false;
  /**
   * The key: the one this host holds; else (a new Mac, a restored backup) the sealed copy, opened
   * by the vault once it is unlocked, and stored back on this host. A key is never made here:
   * without a sealed copy nothing is moved (turn it on from Settings, which makes both).
   */
  /** Why the key is not here yet, when it is more specific than "waiting". */
  let waiting: string | undefined;
  const provider = async (): Promise<Buffer | undefined> => {
    waiting = undefined;
    const held = await heldKey();
    if (held !== undefined) return held;
    if (interactive && (await o.derived?.unavailableReason()) !== null) return undefined;
    const box = readEscrow();
    if (box === undefined) {
      failure = "there is no saved copy of the memory key; turn encryption on from Settings";
      throw new Error(failure);
    }
    if (o.escrow === undefined || o.escrow.locked) {
      waiting = "unlock the vault to restore the memory key on this Mac";
      return undefined;
    }
    const key = o.escrow.unescrow(MEMORY_KEY_NAME, box);
    await holdKey(key);
    o.log?.("memory: restored the memory key from the vault");
    return key;
  };
  const backup = safetyPath;
  /**
   * Moves the rows into the encrypted file:
   * 1. back up psyche.sqlite (same library, online backup) unless a backup of this move exists;
   * 2. copy (or, resuming, bring the schema up to date), then compare counts and checksums;
   * 3. clear the plain rows, then compare the encrypted file with the backup;
   * 4. only then record "cleared" and delete the backup.
   * Any failure after step 3 began puts the rows back from the backup and checks them.
   */
  const sameRows = (x: SqliteDb, y: SqliteDb): boolean => {
    try {
      verifySame(x, y, MEMORY_STORE_TABLES, "check");
      return true;
    } catch {
      return false;
    }
  };
  const moveIn = async (db: SqliteDb, fresh: boolean): Promise<void> => {
    const plain = o.db.sqlite;
    // Resuming after a crash between the clear and recording it: the plain side is empty and the
    // backup and the encrypted file are the copies. Never discard either then.
    const resumedAfterClear = !fresh && isEmpty(plain, MEMORY_STORE_TABLES);
    if (resumedAfterClear && !existsSync(backup))
      throw new Unrecoverable("the plain rows are gone and there is no backup to check against");
    if (!resumedAfterClear) {
      rmSync(backup, { force: true });
      mkdirSync(join(o.home, "safety"), { recursive: true, mode: 0o700 });
      await plain.backup(backup);
      chmodSync(backup, 0o600);
    }
    if (fresh) copyTables(db, plain, MEMORY_STORE_TABLES);
    else syncSchema(db, plain, MEMORY_STORE_TABLES);
    const bak = openDb(backup, { readonly: true, migrate: false });
    try {
      if (resumedAfterClear) {
        try {
          verifySame(bak.sqlite, db, MEMORY_STORE_TABLES, "copy check");
        } catch (err) {
          throw new Unrecoverable(err instanceof Error ? err.message : String(err));
        }
      } else {
        verifySame(plain, db, MEMORY_STORE_TABLES, "copy check");
        verifySame(plain, bak.sqlite, MEMORY_STORE_TABLES, "backup check");
        setSetting(o.db, MEMORY_MOVE_STATE, "copied");
        try {
          clearPlain(plain, MEMORY_STORE_TABLES);
          verifySame(bak.sqlite, db, MEMORY_STORE_TABLES, "check after clearing");
        } catch (err) {
          try {
            // A clear that failed inside its transaction changed nothing; otherwise restore.
            if (!sameRows(bak.sqlite, plain)) {
              restorePlain(plain, backup, MEMORY_STORE_TABLES);
              verifySame(bak.sqlite, plain, MEMORY_STORE_TABLES, "restore check");
            }
          } catch (again) {
            throw new Unrecoverable(
              `${err instanceof Error ? err.message : String(err)}; restoring failed too (${String(again)})`,
            );
          }
          throw err;
        }
      }
    } finally {
      bak.sqlite.close();
    }
    setSetting(o.db, MEMORY_MOVE_STATE, "cleared");
    // The copy from before the move stays until the encrypted file has opened on a later start
    // and an encrypted backup holds it with its sealed key (`afterBackup`).
    setSetting(o.db, MEMORY_SAFETY, { movedAt: new Date().toISOString(), openedAgain: false });
  };
  const opener = new DeferredOpen<SqliteDb>({
    provider,
    open: async (key) => {
      let state = moveState(o.db);
      if (state !== undefined && !existsSync(path)) {
        // The encrypted file went away. If psyche.sqlite still has the rows, start over;
        // otherwise every remaining copy is kept and nothing is opened.
        if (state === "copied" && !isEmpty(o.db.sqlite, MEMORY_STORE_TABLES)) {
          deleteSettings(o.db, [MEMORY_MOVE_STATE]);
          state = undefined;
        } else {
          failure = `the encrypted memory store is missing; ${backup} and psyche.sqlite were kept as they are`;
          o.log?.(`memory: ${failure}`);
          throw new Unrecoverable(failure);
        }
      }
      // A file from an attempt that never recorded a verified copy is not trusted: start again.
      if (state === undefined) removeFiles(path);
      const fresh = !existsSync(path);
      const db = openEncrypted(path, key, { vec: true });
      try {
        if (state === "cleared") {
          const s = safetyOf(o.db);
          if (s !== undefined && !s.openedAgain)
            setSetting(o.db, MEMORY_SAFETY, { ...s, openedAgain: true });
          // Later migrations of psyche.sqlite reach the encrypted file here.
          const rebuilt = syncSchema(db, o.db.sqlite, MEMORY_STORE_TABLES);
          if (rebuilt.length > 0) o.log?.(`memory: updated ${rebuilt.join(", ")}`);
        } else {
          await moveIn(db, fresh);
        }
      } catch (err) {
        db.close();
        if (err instanceof Unrecoverable) {
          // Keep every copy (the encrypted file, the backup, the state) for a person to look at.
          failure = `${err.message}; the encrypted file and ${backup} were kept`;
        } else {
          // psyche.sqlite holds every row (never cleared, or restored and checked): the attempt
          // is discarded and the next start tries again. An opened, cleared store is never.
          if (state !== "cleared") {
            removeFiles(path);
            deleteSettings(o.db, [MEMORY_MOVE_STATE]);
            rmSync(backup, { force: true });
          }
          failure = err instanceof Error ? err.message : String(err);
        }
        o.log?.(`memory: ${failure}`);
        throw err;
      }
      failure = undefined;
      enc = db;
      return db;
    },
    onReady: (db) => late.attach(db),
    onWaiting: (reason) => late.setReason(waiting ?? reason),
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
            : { state: "pending", reason: waiting ?? opener.reason },
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
      rmSync(escrowFile, { force: true });
      if (interactive) await o.derived?.remove(MEMORY_KEY_NAME).catch(() => undefined);
      // Everything is back in psyche.sqlite, so the old copy has no use left.
      shred(safetyPath);
      deleteSettings(o.db, [MEMORY_SAFETY]);
      turnedOff = true;
    },
    enable,
    snapshot: () => {
      const db = enc;
      if (db === undefined || turnedOff) return undefined;
      return async (dest: string) => {
        // VACUUM INTO keeps the cipher and key: the copy is as encrypted as the file.
        db.prepare("VACUUM INTO ?").run(dest);
      };
    },
    afterBackup: (encrypted) => {
      const s = safetyOf(o.db);
      if (!encrypted || turnedOff || s === undefined || s.removedAt !== undefined) return;
      if (moveState(o.db) !== "cleared" || !s.openedAgain || !existsSync(escrowFile)) return;
      removeSafety();
    },
    safetyCopy,
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
    safetyCopy: handle.safetyCopy(),
  };
}

/** `memory.store.setEncrypted`: on at the next start; off now, after copying everything back. */
export async function setMemoryEncrypted(
  db: PsycheDb,
  handle: MemoryHandle,
  on: boolean,
): Promise<MemoryStoreStatus> {
  if (on) await handle.enable();
  else if (handle.status().state === "off") setSetting(db, MEMORY_ENCRYPT_SETTING, false);
  else await handle.turnOff();
  return memoryStoreStatus(db, handle);
}
