import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, setSetting } from "@psyche/db";
import { GraphStore } from "@psyche/memory";
import { FakeClock } from "@psyche/testing";
import { KeyFileWrapper } from "@psyche/vault";
import { afterEach, describe, expect, it } from "vitest";
import {
  LateDatabase,
  MEMORY_ENCRYPT_SETTING,
  resolveMemoryStore,
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

  it("an encrypted file whose tables fell behind the plain schema is not used", async () => {
    const f = fixture(true);
    const first = resolveMemoryStore({ ...f, slot: "key_file" });
    first.start();
    await wait(() => first.status().state === "ready");
    first.stop();
    f.db.sqlite.exec("ALTER TABLE graph_entities ADD COLUMN later_column TEXT");
    const again = resolveMemoryStore({ ...f, slot: "key_file" });
    stops.push(() => again.stop());
    again.start();
    await wait(() => again.status().state === "unavailable");
    expect(again.status()).toMatchObject({
      reason: expect.stringMatching(/out of date.*graph_entities/),
    });
    expect(again.late?.ready).toBe(false);
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
