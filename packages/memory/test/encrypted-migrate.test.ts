import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "@psyche/db";
import { FakeClock } from "@psyche/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GraphStore } from "../src/graph/store.ts";
import { copyTables, MEMORY_STORE_TABLES, newKey, openEncrypted } from "../src/secure/encrypted.ts";
import { clearPlain, copyBack, syncSchema } from "../src/secure/migrate.ts";

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "psyche-mig-")));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const clock = new FakeClock(Date.parse("2026-11-02T12:00:00Z"));
const bytes = (name: string) =>
  Buffer.concat(
    readdirSync(dir)
      .filter((f) => f.startsWith(name))
      .map((f) => readFileSync(join(dir, f))),
  );

function setup() {
  const path = join(dir, "psyche.sqlite");
  const plain = openDb(path);
  const g = new GraphStore({ sqlite: plain.sqlite, clock });
  g.createEntity({
    kind: "person",
    name: "Sam SENTINEL",
    identifiers: [{ kind: "email", value: "sam@acme.com" }],
  });
  plain.sqlite
    .prepare(
      "INSERT INTO memory_claims (id, text, kind, provenance, confidence, created_at, updated_at) VALUES ('c1','SENTINEL tea','fact','agent',0.8,'t','t')",
    )
    .run();
  plain.sqlite.pragma("wal_checkpoint(TRUNCATE)");
  const enc = openEncrypted(join(dir, "memory.sqlite"), newKey());
  copyTables(enc, plain.sqlite, MEMORY_STORE_TABLES);
  return { path, plain: plain.sqlite, enc };
}

describe("syncSchema", () => {
  it("does nothing when the definitions match", () => {
    const { plain, enc } = setup();
    expect(syncSchema(enc, plain, MEMORY_STORE_TABLES)).toEqual([]);
    enc.close();
    plain.close();
  });

  it("rebuilds a table a later migration changed, keeping rows, indexes, triggers and the search", () => {
    const { plain, enc } = setup();
    plain.exec("ALTER TABLE graph_entities ADD COLUMN later_note TEXT");
    expect(syncSchema(enc, plain, MEMORY_STORE_TABLES)).toEqual(["graph_entities"]);
    const cols = (enc.prepare("PRAGMA table_info(graph_entities)").all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(cols).toContain("later_note");
    const g = new GraphStore({ sqlite: enc, clock });
    expect(g.search("sam", {}).map((e) => e.name)).toEqual(["Sam SENTINEL"]);
    g.createEntity({ kind: "person", name: "Priya Rao" });
    expect(g.search("priya", {})).toHaveLength(1);
    expect(enc.pragma("foreign_key_check")).toEqual([]);
    expect(syncSchema(enc, plain, MEMORY_STORE_TABLES)).toEqual([]);
    enc.close();
    plain.close();
  });
});

describe("clearPlain and copyBack", () => {
  it("clears the plain rows so the old text is gone, then the way back restores everything", () => {
    const { path, plain, enc } = setup();
    new GraphStore({ sqlite: enc, clock }).createEntity({ kind: "person", name: "Learned Later" });
    const removed = clearPlain(plain, MEMORY_STORE_TABLES);
    expect(removed).toBeGreaterThan(0);
    expect(plain.prepare("SELECT count(*) n FROM graph_entities").get()).toEqual({ n: 0 });
    expect(bytes("psyche.sqlite").includes("SENTINEL")).toBe(false);

    const back = copyBack(enc, plain, MEMORY_STORE_TABLES);
    expect(back.graph_entities).toBe(2);
    expect(back.memory_claims).toBe(1);
    const g = new GraphStore({ sqlite: plain, clock });
    expect(g.search("learned", {}).map((e) => e.name)).toEqual(["Learned Later"]);
    expect(g.search("sam", {})).toHaveLength(1);
    expect(plain.prepare("SELECT text FROM memory_claims").all()).toEqual([
      { text: "SENTINEL tea" },
    ]);
    // The index over memory_chunks was rebuilt from its table and is consistent.
    expect(() =>
      plain.exec("INSERT INTO memory_fts(memory_fts) VALUES ('integrity-check')"),
    ).not.toThrow();
    expect(plain.pragma("foreign_key_check")).toEqual([]);
    enc.close();
    plain.close();
  });

  it("copying back twice gives the same rows, not doubles", () => {
    const { path, plain, enc } = setup();
    copyBack(enc, plain, MEMORY_STORE_TABLES);
    const again = copyBack(enc, plain, MEMORY_STORE_TABLES);
    expect(again.graph_entities).toBe(1);
    expect(plain.prepare("SELECT count(*) n FROM graph_fts").get()).toEqual({ n: 1 });
    enc.close();
    plain.close();
  });
});

describe("migrations and the encrypted store", () => {
  /** Migrations up to here were applied before any data could live in the encrypted file. */
  const BEFORE_EM9 = "202611021500";

  it("no new migration changes rows of a moved table (schema changes reach it, row changes cannot)", () => {
    const dir = join(import.meta.dirname, "..", "..", "db", "migrations");
    const moved = MEMORY_STORE_TABLES.join("|");
    const offending = readdirSync(dir)
      .filter((f) => f.endsWith(".sql") && f > BEFORE_EM9)
      .filter((f) =>
        new RegExp(
          `\\b(UPDATE|INSERT\\s+INTO|DELETE\\s+FROM)\\s+"?(${moved})\\b`,
          "i",
        ).test(readFileSync(join(dir, f), "utf8")),
      );
    // A migration that must change rows of a moved table needs a step in syncSchema's caller
    // that applies the same change to the encrypted file; add it, then list the file here.
    expect(offending).toEqual([]);
  });
});
