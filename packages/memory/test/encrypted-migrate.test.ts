import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MIGRATIONS_DIR, openDb, runMigrations } from "@psyche/db";
import { FakeClock } from "@psyche/testing";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GraphStore } from "../src/graph/store.ts";
import { copyTables, MEMORY_STORE_TABLES, newKey, openEncrypted } from "../src/secure/encrypted.ts";
import {
  clearPlain,
  copyBack,
  restorePlain,
  syncSchema,
  tableChecksums,
  verifySame,
} from "../src/secure/migrate.ts";

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
  /**
   * Rebuilds that only copy rows into a table with a wider CHECK or new columns (INSERT ... SELECT
   * into a `_v2` table). The statements the pattern below finds in them are the re-created
   * citation-cleanup triggers. The encrypted file takes the new shape from `syncSchema`.
   */
  const ROW_PRESERVING_REBUILDS = new Set(["202611031400_memory_work.sql"]);

  it("no new migration changes rows of a moved table (schema changes reach it, row changes cannot)", () => {
    const dir = join(import.meta.dirname, "..", "..", "db", "migrations");
    const moved = MEMORY_STORE_TABLES.join("|");
    const offending = readdirSync(dir)
      .filter((f) => f.endsWith(".sql") && f > BEFORE_EM9 && !ROW_PRESERVING_REBUILDS.has(f))
      .filter((f) =>
        new RegExp(`\\b(UPDATE|INSERT\\s+INTO|DELETE\\s+FROM)\\s+"?(${moved})\\b`, "i").test(
          readFileSync(join(dir, f), "utf8"),
        ),
      );
    // A migration that must change rows of a moved table needs a step in syncSchema's caller
    // that applies the same change to the encrypted file; add it, then list the file here.
    expect(offending).toEqual([]);
  });
});

describe("checksums, backup and restore", () => {
  it("the same rows give the same checksums across the two libraries; one changed value does not", () => {
    const { plain, enc } = setup();
    expect(() => verifySame(plain, enc, MEMORY_STORE_TABLES, "t")).not.toThrow();
    enc.prepare("UPDATE graph_entities SET name = 'Sam SENTINEX'").run();
    expect(tableChecksums(enc, ["graph_entities"]).graph_entities?.rows).toBe(1);
    expect(() => verifySame(plain, enc, MEMORY_STORE_TABLES, "t")).toThrow(
      /graph_entities differs/,
    );
    enc.close();
    plain.close();
  });

  it("restores the plain rows from an online backup after a clear, exactly", async () => {
    const { plain, enc } = setup();
    const before = tableChecksums(plain, MEMORY_STORE_TABLES);
    const bak = join(dir, "backup.sqlite");
    await plain.backup(bak);
    clearPlain(plain, MEMORY_STORE_TABLES);
    restorePlain(plain, bak, MEMORY_STORE_TABLES);
    expect(tableChecksums(plain, MEMORY_STORE_TABLES)).toEqual(before);
    expect(new GraphStore({ sqlite: plain, clock }).search("sam", {})).toHaveLength(1);
    enc.close();
    plain.close();
  });
});

describe("the memory work migration reaches an encrypted file that already holds rows", () => {
  it("rebuilds the graph tables in the encrypted file, keeps every row and adds the new tables", () => {
    const NEW = "202611031400_memory_work.sql";
    const old = join(dir, "old-migrations");
    mkdirSync(old);
    for (const f of readdirSync(DEFAULT_MIGRATIONS_DIR)) {
      if (f.endsWith(".sql") && f < NEW)
        copyFileSync(join(DEFAULT_MIGRATIONS_DIR, f), join(old, f));
    }
    const plain = new Database(join(dir, "plain.sqlite"));
    plain.pragma("foreign_keys = ON");
    runMigrations(plain, { dir: old });
    const t = "2026-11-02T00:00:00.000Z";
    plain.exec(`
      INSERT INTO graph_entities (id, kind, name, sort_name, created_at, updated_at) VALUES ('e1','person','Sam','sam','${t}','${t}');
      INSERT INTO graph_entities (id, kind, name, sort_name, project_status, created_at, updated_at) VALUES ('e2','project','Remodel','remodel','active','${t}','${t}');
      INSERT INTO graph_facts (id, entity_id, attribute, value, provenance, confidence, valid_from, recorded_at, created_at, updated_at) VALUES ('f1','e1','city','Porto','owner',1,'${t}','${t}','${t}','${t}');
      INSERT INTO graph_citations (id, target_kind, target_id, source, source_ref, quote, start, "end", source_hash, provenance, observed_at, created_at) VALUES ('c1','fact','f1','mail','m1','I moved to Porto',0,16,'h','owner','${t}','${t}');
      INSERT INTO graph_interactions (id, kind, source, external_ref, occurred_at, direction, project_id, created_at) VALUES ('i1','mail','mail','m1','${t}','in','e2','${t}');
      INSERT INTO graph_participants VALUES ('i1','e1','from');
    `);
    const enc = openEncrypted(join(dir, "memory.sqlite"), newKey());
    copyTables(
      enc,
      plain,
      MEMORY_STORE_TABLES.filter(
        (x) => !["graph_anchors", "graph_interaction_subjects"].includes(x),
      ),
    );

    runMigrations(plain);
    const rebuilt = syncSchema(enc, plain as never, MEMORY_STORE_TABLES);
    expect(rebuilt).toEqual(
      expect.arrayContaining([
        "graph_entities",
        "graph_facts",
        "graph_interactions",
        "graph_anchors",
        "graph_interaction_subjects",
      ]),
    );
    expect(enc.pragma("foreign_key_check")).toEqual([]);
    const n = (table: string) =>
      (enc.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
    expect([
      n("graph_entities"),
      n("graph_facts"),
      n("graph_citations"),
      n("graph_interactions"),
      n("graph_participants"),
    ]).toEqual([2, 1, 1, 1, 1]);
    expect(syncSchema(enc, plain as never, MEMORY_STORE_TABLES)).toEqual([]);

    // It works: a course, an assignment, a timeline.
    const g = new GraphStore({ sqlite: enc, clock });
    const course = g.createEntity({ kind: "project", name: "MATH 21", projectType: "course" });
    const hw = g.createEntity({
      kind: "assignment",
      name: "HW7",
      dueAt: "2026-11-06T23:59:00.000Z",
    });
    g.setEdge({ src: hw.id, rel: "part_of", dst: course.id, provenance: "owner" });
    expect(g.timeline(course.id).rows.map((r) => r.text)).toEqual(["Due Nov 6"]);
    // Deleting the fact still takes its citation in the encrypted file.
    enc.prepare("DELETE FROM graph_facts WHERE id = 'f1'").run();
    expect(n("graph_citations")).toBe(0);
    enc.close();
    plain.close();
  });
});
