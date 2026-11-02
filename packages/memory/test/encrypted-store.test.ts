import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "@psyche/db";
import { FakeClock } from "@psyche/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EverythingStore } from "../src/graph/everything.ts";
import { GraphStore } from "../src/graph/store.ts";
import {
  copyTables,
  deleteEverything,
  MEMORY_STORE_TABLES,
  MemoryKeyFile,
  newKey,
  openEncrypted,
} from "../src/secure/encrypted.ts";

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "psyche-enc-")));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Every byte of every file belonging to the database (main, WAL, shm). */
function bytesOf(path: string): Buffer {
  const parts = readdirSync(dir)
    .filter((f) => f.startsWith(path.split("/").pop() as string))
    .map((f) => readFileSync(join(dir, f)));
  return Buffer.concat(parts);
}

describe("openEncrypted", () => {
  it("creates a file that is not plaintext, reopens with the key, refuses another", () => {
    const path = join(dir, "memory.sqlite");
    const key = newKey();
    const db = openEncrypted(path, key);
    db.exec("create table t(v text)");
    db.prepare("insert into t values (?)").run("SENTINEL-sam-birthday-may-3");
    db.close();
    expect(statSync(path).mode & 0o077).toBe(0);
    expect(bytesOf(path).includes("SENTINEL-sam-birthday")).toBe(false);
    expect(readFileSync(path).subarray(0, 15).toString("latin1")).not.toBe("SQLite format 3");
    const again = openEncrypted(path, key);
    expect(again.prepare("select v from t").get()).toEqual({ v: "SENTINEL-sam-birthday-may-3" });
    again.close();
    expect(() => openEncrypted(path, newKey())).toThrow(/does not open/);
    expect(() => openEncrypted(path, Buffer.alloc(16))).toThrow(/32 bytes/);
  });

  it("a plain database with the same data does show it (so the check above means something)", () => {
    const p = join(dir, "plain.sqlite");
    const plain = openDb(p, { migrate: false });
    plain.sqlite.exec("create table t(v text)");
    plain.sqlite.prepare("insert into t values (?)").run("SENTINEL-sam-birthday-may-3");
    plain.sqlite.close();
    expect(bytesOf(p).includes("SENTINEL-sam-birthday")).toBe(true);
  });

  it("keeps FTS5 and sqlite-vec working inside it", () => {
    const db = openEncrypted(join(dir, "m.sqlite"), newKey(), { vec: true });
    db.exec("create virtual table f using fts5(a)");
    db.exec("insert into f values ('hello world')");
    expect(db.prepare("select count(*) n from f where f match 'hello'").get()).toEqual({ n: 1 });
    db.exec("create virtual table v using vec0(e float[3])");
    const ins = db.prepare("insert into v(rowid, e) values (?, ?)");
    for (let i = 1; i <= 5; i++) ins.run(BigInt(i), new Float32Array([i, 0, 1]));
    const hit = db
      .prepare("select rowid from v where e match ? and k = 1")
      .get(new Float32Array([4.1, 0, 1])) as { rowid: bigint };
    expect(Number(hit.rowid)).toBe(4);
    db.close();
  });
});

describe("MemoryKeyFile", () => {
  it("creates a 0600 key once, then loads the same one", () => {
    const f = new MemoryKeyFile(join(dir, "security", "memory.key"));
    const a = f.loadOrCreate();
    expect(a.created).toBe(true);
    expect(statSync(f.path).mode & 0o777).toBe(0o600);
    const b = f.loadOrCreate();
    expect(b.created).toBe(false);
    expect(b.key.equals(a.key)).toBe(true);
  });

  it("refuses a key file other users could read, a missing one, or a short one", () => {
    const f = new MemoryKeyFile(join(dir, "memory.key"));
    expect(() => f.load()).toThrow(/missing/);
    f.write(newKey());
    chmodSync(f.path, 0o644);
    expect(() => f.load()).toThrow(/mode 0600/);
    chmodSync(f.path, 0o600);
    writeFileSync(f.path, "abcd\n", { mode: 0o600 });
    expect(() => f.load()).toThrow(/32-byte/);
  });

  it("replaces the key atomically, leaving no temp file", () => {
    const f = new MemoryKeyFile(join(dir, "memory.key"));
    f.write(newKey());
    const next = newKey();
    f.write(next);
    expect(f.load().equals(next)).toBe(true);
    expect(readdirSync(dir).filter((x) => x.endsWith(".tmp"))).toEqual([]);
  });
});

describe("moving the memory tables", () => {
  /** A real, migrated psyche.sqlite with graph data, learned facts and citations. */
  function populated() {
    const clock = new FakeClock(Date.parse("2026-10-29T12:00:00Z"));
    const path = join(dir, "psyche.sqlite");
    const db = openDb(path);
    const graph = new GraphStore({ sqlite: db.sqlite, clock });
    const em = new EverythingStore({ sqlite: db.sqlite, graph, clock });
    graph.createEntity({ kind: "person", name: "The Owner", isOwner: true });
    const sam = graph.createEntity({
      kind: "person",
      name: "Sam Lee",
      identifiers: [{ kind: "email", value: "sam@acme.com" }],
    }).id;
    const o = em.proposeFact({
      entityId: sam,
      attribute: "birthday",
      value: "May 3",
      provenance: "untrusted",
      subjectKind: "self_disclosure",
      citations: [
        {
          source: "mail",
          sourceRef: "<m>",
          quote: "SENTINEL my birthday is May 3",
          start: 0,
          end: 29,
          sourceHash: "h",
          authorEntityId: sam,
        },
      ],
    });
    if (o.status === "refused") throw new Error(o.reason);
    em.decide(o.fact.id, "confirm");
    db.sqlite
      .prepare(
        "INSERT INTO memory_claims (id, text, kind, provenance, confidence, created_at, updated_at) VALUES ('c1','Sam likes SENTINEL tea','fact','agent',0.8,'t','t')",
      )
      .run();
    em.linkClaim("c1", sam);
    db.sqlite.pragma("wal_checkpoint(TRUNCATE)");
    return { db, path, sam, factId: o.fact.id };
  }

  it("copies every memory table with its indexes, triggers and FTS, verified by counts", () => {
    const { db, path, sam } = populated();
    const enc = openEncrypted(join(dir, "memory.sqlite"), newKey());
    const r = copyTables(enc, path, MEMORY_STORE_TABLES);
    expect(r.tables.graph_entities).toBe(2);
    expect(r.tables.graph_facts).toBe(1);
    expect(r.tables.graph_citations).toBe(1);
    expect(r.tables.memory_claims).toBe(1);
    expect(
      enc
        .prepare("select name from sqlite_master where type='trigger' and name like 'graph_%'")
        .all(),
    ).toHaveLength(3);
    expect(
      enc
        .prepare(
          "select count(*) n from sqlite_master where type='index' and name='graph_facts_entity_idx'",
        )
        .get(),
    ).toEqual({ n: 1 });
    // The standalone FTS table came with its content; the external-content one was rebuilt.
    expect(
      enc.prepare("select count(*) n from graph_fts where graph_fts match 'sam'").get(),
    ).toEqual({ n: 1 });
    expect(
      enc.prepare("select count(*) n from memory_fts where memory_fts match 'sam'").get(),
    ).toEqual({ n: 0 });
    expect(enc.pragma("foreign_key_check")).toEqual([]);
    // A GraphStore on the encrypted copy reads the same person and their accepted fact.
    const g2 = new GraphStore({
      sqlite: enc as never,
      clock: new FakeClock(Date.parse("2026-10-29T12:00:00Z")),
    });
    expect(g2.facts(sam).map((f) => f.value)).toEqual(["May 3"]);
    // The citation cleanup trigger still fires in the copy.
    enc.prepare("DELETE FROM graph_facts").run();
    expect(enc.prepare("select count(*) n from graph_citations").get()).toEqual({ n: 0 });
    // The source is untouched.
    expect(db.sqlite.prepare("select count(*) n from graph_facts").get()).toEqual({ n: 1 });
    enc.close();
    db.sqlite.close();
  });

  it("the encrypted file holds none of the text in the clear", () => {
    const { db, path } = populated();
    const target = join(dir, "memory.sqlite");
    const enc = openEncrypted(target, newKey());
    copyTables(enc, path, MEMORY_STORE_TABLES);
    enc.pragma("wal_checkpoint(TRUNCATE)");
    enc.close();
    expect(bytesOf(target).includes("SENTINEL")).toBe(false);
    expect(bytesOf(path).includes("SENTINEL")).toBe(true);
    db.sqlite.close();
  });

  it("skips tables the source does not have", () => {
    const { db, path } = populated();
    const enc = openEncrypted(join(dir, "memory.sqlite"), newKey());
    expect(copyTables(enc, path, ["graph_entities", "no_such_table"]).tables).toEqual({
      graph_entities: 2,
    });
    enc.close();
    db.sqlite.close();
  });
});

describe("delete everything", () => {
  it("empties the tables, keeps the structure, re-keys, and leaves nothing readable behind", () => {
    const path = join(dir, "psyche.sqlite");
    const plain = openDb(path);
    plain.sqlite
      .prepare(
        "INSERT INTO graph_entities (id, kind, name, sort_name, created_at, updated_at) VALUES ('e1','person','Sam SENTINEL','sam','t','t')",
      )
      .run();
    plain.sqlite
      .prepare(
        "INSERT INTO graph_facts (id, entity_id, attribute, value, provenance, confidence, valid_from, recorded_at, created_at, updated_at) VALUES ('f1','e1','city','SENTINEL Lisbon','untrusted',0.5,'t','t','t','t')",
      )
      .run();
    plain.sqlite.pragma("wal_checkpoint(TRUNCATE)");
    const target = join(dir, "memory.sqlite");
    const key = newKey();
    const enc = openEncrypted(target, key);
    copyTables(enc, path, MEMORY_STORE_TABLES);
    plain.sqlite.close();
    const { newKey: fresh, tables } = deleteEverything(enc);
    expect(tables).toBeGreaterThan(10);
    expect(enc.prepare("select count(*) n from graph_facts").get()).toEqual({ n: 0 });
    expect(enc.prepare("select count(*) n from graph_entities").get()).toEqual({ n: 0 });
    // Structure survives: the schema, indexes and triggers are still there.
    expect(
      enc
        .prepare("select count(*) n from sqlite_master where type='table' and name='graph_facts'")
        .get(),
    ).toEqual({ n: 1 });
    enc.close();
    expect(fresh.equals(key)).toBe(false);
    expect(() => openEncrypted(target, key)).toThrow(/does not open/);
    const again = openEncrypted(target, fresh);
    expect(again.prepare("select count(*) n from graph_facts").get()).toEqual({ n: 0 });
    again.close();
    expect(existsSync(target)).toBe(true);
    expect(bytesOf(target).includes("SENTINEL")).toBe(false);
  });
});
