import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSetting, openDb, setSetting } from "@psyche/db";
import { copyBack, GraphStore, MEMORY_STORE_TABLES, tableChecksums } from "@psyche/memory";
import { FakeClock } from "@psyche/testing";
import { KeyFileWrapper } from "@psyche/vault";
import { afterEach, describe, expect, it } from "vitest";
import {
  LateDatabase,
  MEMORY_ENCRYPT_SETTING,
  MEMORY_MOVE_STATE,
  memoryStoreStatus,
  resolveMemoryStore,
  setMemoryEncrypted,
} from "../src/compose/memory-db.ts";

const dirs: string[] = [];
const stops: Array<() => unknown> = [];
afterEach(() => {
  for (const s of stops.splice(0)) s();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fixture(encrypt?: boolean) {
  const dir = mkdtempSync(join(tmpdir(), "psyche-mdb-"));
  dirs.push(dir);
  const db = openDb(join(dir, "psyche.sqlite"));
  if (encrypt !== undefined) setSetting(db, MEMORY_ENCRYPT_SETTING, encrypt);
  const keyPath = join(dir, "vault.key");
  writeFileSync(keyPath, "c".repeat(64), { mode: 0o600 });
  return { dir, db, home: dir, wrapper: new KeyFileWrapper(keyPath) };
}

const wait = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("timed out");
};

describe("memory store location", () => {
  it("off (the default): the stores get psyche.sqlite itself, the same object, and nothing else opens", () => {
    for (const setting of [undefined, false]) {
      const f = fixture(setting);
      const m = resolveMemoryStore({ ...f, slot: "key_file" });
      expect(m.sqlite).toBe(f.db.sqlite);
      expect(m.late).toBeUndefined();
      expect(m.status()).toEqual({ state: "off" });
      m.start();
      expect(readFileSync(join(f.dir, "psyche.sqlite")).length).toBeGreaterThan(0);
      expect(() => readFileSync(join(f.dir, "state", "memory.sqlite"))).toThrow();
      expect(() => readFileSync(join(f.dir, "state", "memory.key.json"))).toThrow();
    }
  });

  it("on: opens the encrypted file once the key is there, with the graph copied from the plain file", async () => {
    const f = fixture(true);
    const clock = new FakeClock(Date.parse("2026-11-02T10:00:00Z"));
    new GraphStore({ sqlite: f.db.sqlite, clock }).createEntity({
      kind: "person",
      name: "Sam Lee",
    });
    const m = resolveMemoryStore({ ...f, slot: "key_file" });
    stops.push(() => m.stop());
    expect(m.status().state).toBe("pending");
    const g = new GraphStore({ sqlite: m.sqlite, clock });
    expect(g.search("sam", {})).toEqual([]);
    m.start();
    await wait(() => m.status().state === "ready");
    expect(g.search("sam", {}).map((e) => e.name)).toEqual(["Sam Lee"]);
    const raw = readFileSync(join(f.dir, "state", "memory.sqlite"));
    expect(raw.includes("Sam Lee")).toBe(false);
    expect(readFileSync(join(f.dir, "state", "memory.key.json"), "utf8")).not.toMatch(/"key"/);
  });

  it("on the keychain slot without a helper it stays pending and makes no file", async () => {
    const f = fixture(true);
    const m = resolveMemoryStore({ ...f, slot: "keychain" });
    stops.push(() => m.stop());
    m.start();
    await new Promise((r) => setTimeout(r, 50));
    expect(m.status().state).toBe("pending");
    expect(m.status()).toMatchObject({ reason: expect.stringMatching(/helper/) });
    expect(() => readFileSync(join(f.dir, "state", "memory.sqlite"))).toThrow();
  });

  it("a later migration of psyche.sqlite reaches the encrypted file on the next open", async () => {
    const f = fixture(true);
    const first = resolveMemoryStore({ ...f, slot: "key_file" });
    first.start();
    await wait(() => first.status().state === "ready");
    first.stop();
    f.db.sqlite.exec("ALTER TABLE graph_entities ADD COLUMN later_column TEXT");
    const again = resolveMemoryStore({ ...f, slot: "key_file" });
    stops.push(() => again.stop());
    again.start();
    await wait(() => again.status().state === "ready");
    const cols = (
      again.sqlite.prepare("PRAGMA table_info(graph_entities)").all() as { name: string }[]
    ).map((c) => c.name);
    expect(cols).toContain("later_column");
  });
});

describe("moving the data", () => {
  const sam = (sqlite: ConstructorParameters<typeof GraphStore>[0]["sqlite"]) =>
    new GraphStore({ sqlite, clock: new FakeClock(0) });
  const plainBytes = (dir: string) =>
    Buffer.concat(
      ["psyche.sqlite", "psyche.sqlite-wal"].map((n) => {
        try {
          return readFileSync(join(dir, n));
        } catch {
          return Buffer.alloc(0);
        }
      }),
    );

  it("after a verified copy the plain rows are cleared, so the text is only in the encrypted file", async () => {
    const f = fixture(true);
    sam(f.db.sqlite).createEntity({ kind: "person", name: "Sam SENTINEL" });
    const m = resolveMemoryStore({ ...f, slot: "key_file" });
    stops.push(() => m.stop());
    m.start();
    await wait(() => m.status().state === "ready");
    expect(getSetting(f.db, MEMORY_MOVE_STATE)?.value).toBe("cleared");
    expect(f.db.sqlite.prepare("SELECT count(*) n FROM graph_entities").get()).toEqual({ n: 0 });
    expect(plainBytes(f.dir).includes("SENTINEL")).toBe(false);
    expect(sam(m.sqlite).search("sam", {})).toHaveLength(1);
  });

  it("a half-written file from an attempt that never finished is thrown away and the copy redone", async () => {
    const f = fixture(true);
    sam(f.db.sqlite).createEntity({ kind: "person", name: "Sam Lee" });
    mkdirSync(join(f.dir, "state"), { recursive: true });
    writeFileSync(join(f.dir, "state", "memory.sqlite"), "half");
    const m = resolveMemoryStore({ ...f, slot: "key_file" });
    stops.push(() => m.stop());
    m.start();
    await wait(() => m.status().state === "ready");
    expect(sam(m.sqlite).search("sam", {})).toHaveLength(1);
  });

  it("a crash after the copy but before the clear resumes with the clear", async () => {
    const f = fixture(true);
    sam(f.db.sqlite).createEntity({ kind: "person", name: "Sam Lee" });
    const m = resolveMemoryStore({ ...f, slot: "key_file" });
    m.start();
    await wait(() => m.status().state === "ready");
    // As if the process stopped right after "copied": the plain rows are still there.
    copyBack(m.sqlite, f.db.sqlite, MEMORY_STORE_TABLES);
    m.stop();
    setSetting(f.db, MEMORY_MOVE_STATE, "copied");
    const again = resolveMemoryStore({ ...f, slot: "key_file" });
    stops.push(() => again.stop());
    again.start();
    await wait(() => again.status().state === "ready");
    expect(getSetting(f.db, MEMORY_MOVE_STATE)?.value).toBe("cleared");
    expect(f.db.sqlite.prepare("SELECT count(*) n FROM graph_entities").get()).toEqual({ n: 0 });
    expect(sam(again.sqlite).search("sam", {})).toHaveLength(1);
    expect(existsSync(join(f.dir, "state", "memory-move-backup.sqlite"))).toBe(false);
  });

  it("a failure while clearing leaves psyche.sqlite exactly as it was and discards the attempt", async () => {
    const f = fixture(true);
    sam(f.db.sqlite).createEntity({ kind: "person", name: "Sam Lee" });
    const before = tableChecksums(f.db.sqlite, MEMORY_STORE_TABLES);
    f.db.sqlite.exec(
      "CREATE TRIGGER block_clear BEFORE DELETE ON graph_entities BEGIN SELECT RAISE(ABORT, 'disk said no'); END",
    );
    const m = resolveMemoryStore({ ...f, slot: "key_file" });
    stops.push(() => m.stop());
    m.start();
    await wait(() => m.status().state === "unavailable");
    expect(m.status()).toMatchObject({ reason: expect.stringMatching(/disk said no/) });
    f.db.sqlite.exec("DROP TRIGGER block_clear");
    expect(tableChecksums(f.db.sqlite, MEMORY_STORE_TABLES)).toEqual(before);
    expect(getSetting(f.db, MEMORY_MOVE_STATE)).toBeUndefined();
    expect(existsSync(join(f.dir, "state", "memory.sqlite"))).toBe(false);
    expect(existsSync(join(f.dir, "state", "memory-move-backup.sqlite"))).toBe(false);
    // The next attempt goes through.
    await wait(() => m.status().state === "ready", 8000);
    expect(sam(m.sqlite).search("sam", {})).toHaveLength(1);
  });

  it("if the encrypted file disappears after the clear, every remaining copy is kept", async () => {
    const f = fixture(true);
    sam(f.db.sqlite).createEntity({ kind: "person", name: "Sam Lee" });
    const m = resolveMemoryStore({ ...f, slot: "key_file" });
    m.start();
    await wait(() => m.status().state === "ready");
    m.stop();
    rmSync(join(f.dir, "state", "memory.sqlite"));
    const again = resolveMemoryStore({ ...f, slot: "key_file" });
    stops.push(() => again.stop());
    again.start();
    await wait(() => again.status().state === "unavailable");
    expect(again.status()).toMatchObject({ reason: expect.stringMatching(/missing/) });
    expect(getSetting(f.db, MEMORY_MOVE_STATE)?.value).toBe("cleared");
  });

  it("switched off by hand while the encrypted file is the only copy, it still opens that file", async () => {
    const f = fixture(true);
    sam(f.db.sqlite).createEntity({ kind: "person", name: "Sam Lee" });
    const m = resolveMemoryStore({ ...f, slot: "key_file" });
    m.start();
    await wait(() => m.status().state === "ready");
    m.stop();
    setSetting(f.db, MEMORY_ENCRYPT_SETTING, false);
    const again = resolveMemoryStore({ ...f, slot: "key_file" });
    stops.push(() => again.stop());
    expect(again.late).toBeDefined();
    again.start();
    await wait(() => again.status().state === "ready");
    expect(sam(again.sqlite).search("sam", {})).toHaveLength(1);
  });

  it("turning off copies everything back, points the stores at psyche.sqlite and removes the file and key", async () => {
    const f = fixture(true);
    sam(f.db.sqlite).createEntity({ kind: "person", name: "Sam Lee" });
    const m = resolveMemoryStore({ ...f, slot: "key_file" });
    stops.push(() => m.stop());
    const g = sam(m.sqlite);
    await expect(m.turnOff()).rejects.toThrow(/not open/);
    m.start();
    await wait(() => m.status().state === "ready");
    g.createEntity({ kind: "person", name: "Learned While Encrypted" });
    await m.turnOff();
    expect(getSetting(f.db, MEMORY_ENCRYPT_SETTING)?.value).toBe(false);
    expect(getSetting(f.db, MEMORY_MOVE_STATE)).toBeUndefined();
    expect(sam(f.db.sqlite).search("learned", {})).toHaveLength(1);
    // The same store object keeps working, now on the plain file.
    g.createEntity({ kind: "person", name: "After Turning Off" });
    expect(sam(f.db.sqlite).search("after", {})).toHaveLength(1);
    expect(existsSync(join(f.dir, "state", "memory.sqlite"))).toBe(false);
    expect(existsSync(join(f.dir, "state", "memory.key.json"))).toBe(false);
    m.stop();
    expect(f.db.sqlite.open).toBe(true);
    const next = resolveMemoryStore({ ...f, slot: "key_file" });
    expect(next.sqlite).toBe(f.db.sqlite);
  });
});

describe("LateDatabase", () => {
  it("before it opens: reads are empty, writes fail with unavailable, nothing is kept", () => {
    const late = new LateDatabase();
    late.setReason("waiting for the Mac helper");
    const h = late.handle;
    expect(h.prepare("SELECT * FROM graph_entities").all()).toEqual([]);
    expect(h.prepare("SELECT 1").get()).toBeUndefined();
    expect(() => h.prepare("INSERT INTO graph_entities (id) VALUES ('x')").run()).toThrow(
      /not open: waiting for the Mac helper/,
    );
    expect(() => h.exec("DELETE FROM graph_entities")).toThrow(/unavailable|not open/);
    expect(() => h.transaction(() => 1)).toThrow(/not open/);
    const g = new GraphStore({ sqlite: h, clock: new FakeClock(0) });
    expect(() => g.createEntity({ kind: "person", name: "Sam" })).toThrow(/not open/);
  });

  it("after it opens every call goes to the real database, and waiting work runs once", () => {
    const late = new LateDatabase();
    let ran = 0;
    late.whenReady(() => {
      ran += 1;
    });
    const real = openDb(":memory:", { migrate: false }).sqlite;
    real.exec("CREATE TABLE t (v TEXT)");
    late.attach(real);
    expect(ran).toBe(1);
    late.handle.prepare("INSERT INTO t VALUES ('a')").run();
    expect(real.prepare("SELECT v FROM t").all()).toEqual([{ v: "a" }]);
    late.whenReady(() => {
      ran += 1;
    });
    expect(ran).toBe(2);
  });
});

describe("the switch", () => {
  it("on is stored and waits for the next start; off before that start just clears it", async () => {
    const f = fixture();
    const m = resolveMemoryStore({ ...f, slot: "key_file" });
    expect(memoryStoreStatus(f.db, m)).toEqual({
      encrypted: false,
      state: "off",
      reason: null,
      restartNeeded: false,
    });
    expect(await setMemoryEncrypted(f.db, m, true)).toMatchObject({
      encrypted: true,
      state: "off",
      restartNeeded: true,
    });
    expect(await setMemoryEncrypted(f.db, m, false)).toMatchObject({
      encrypted: false,
      restartNeeded: false,
    });
  });

  it("off while the encrypted store is open copies everything back first", async () => {
    const f = fixture(true);
    new GraphStore({ sqlite: f.db.sqlite, clock: new FakeClock(0) }).createEntity({
      kind: "person",
      name: "Sam Lee",
    });
    const m = resolveMemoryStore({ ...f, slot: "key_file" });
    stops.push(() => m.stop());
    m.start();
    await wait(() => m.status().state === "ready");
    expect(memoryStoreStatus(f.db, m)).toMatchObject({ encrypted: true, state: "ready" });
    expect(await setMemoryEncrypted(f.db, m, false)).toMatchObject({
      encrypted: false,
      state: "off",
      restartNeeded: false,
    });
    expect(f.db.sqlite.prepare("SELECT name FROM graph_entities").all()).toEqual([
      { name: "Sam Lee" },
    ]);
  });
});
