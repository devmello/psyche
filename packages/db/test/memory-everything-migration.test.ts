import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_MIGRATIONS_DIR, runMigrations } from "../src/index.ts";
import { makeTmpDir } from "./helpers.ts";

const NEW = "202610281200_memory_everything.sql";

describe("202610281200 memory everything", () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    for (const c of cleanups.splice(0)) c();
  });

  it("keeps every graph row and gives old facts a trusted-as-before review state", () => {
    const { dir, cleanup } = makeTmpDir();
    cleanups.push(cleanup);
    const before = join(dir, "before");
    mkdirSync(before);
    for (const f of readdirSync(DEFAULT_MIGRATIONS_DIR)) {
      if (f.endsWith(".sql") && f < NEW)
        copyFileSync(join(DEFAULT_MIGRATIONS_DIR, f), join(before, f));
    }
    const sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    runMigrations(sqlite, { dir: before });

    const t = "2026-10-20T00:00:00.000Z";
    const ent = sqlite.prepare(
      "INSERT INTO graph_entities (id, kind, name, sort_name, created_at, updated_at) VALUES (?,?,?,?,?,?)",
    );
    ent.run("e1", "person", "Sam", "sam", t, t);
    ent.run("e2", "project", "Remodel", "remodel", t, t);
    sqlite.prepare("UPDATE graph_entities SET merged_into = 'e1' WHERE id = 'e2'").run();
    sqlite
      .prepare(
        "INSERT INTO graph_facts (id, entity_id, attribute, value, provenance, confidence, valid_from, recorded_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
      )
      .run("f1", "e1", "city", "Lisbon", "untrusted", 0.5, t, t, t, t);
    sqlite
      .prepare(
        "INSERT INTO graph_facts (id, entity_id, attribute, value, provenance, confidence, valid_from, recorded_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
      )
      .run("f2", "e1", "employer", "Acme", "owner", 1, t, t, t, t);
    sqlite.prepare("UPDATE graph_facts SET superseded_by = 'f2' WHERE id = 'f1'").run();
    sqlite
      .prepare(
        "INSERT INTO graph_edges (id, src, dst, rel, provenance, confidence, valid_from, created_at, updated_at) VALUES ('g1','e1','e2','member_of','owner',1,?,?,?)",
      )
      .run(t, t, t);
    sqlite
      .prepare(
        "INSERT INTO graph_interactions (id, kind, source, external_ref, occurred_at, direction, project_id, created_at) VALUES ('i1','mail','mail','m1',?, 'in','e2',?)",
      )
      .run(t, t);
    sqlite.prepare("INSERT INTO graph_participants VALUES ('i1','e1','from')").run();
    sqlite
      .prepare(
        "INSERT INTO graph_identifiers (kind, value_norm, value_display, entity_id, source, linked_by, created_at) VALUES ('email','sam@x.io','Sam@x.io','e1','mail','rule',?)",
      )
      .run(t);

    runMigrations(sqlite);

    const count = (table: string) =>
      (sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
    expect(count("graph_entities")).toBe(2);
    expect(count("graph_facts")).toBe(2);
    expect(count("graph_edges")).toBe(1);
    expect(count("graph_participants")).toBe(1);
    expect(count("graph_identifiers")).toBe(1);
    expect(
      sqlite.prepare("SELECT project_id FROM graph_interactions WHERE id = 'i1'").get(),
    ).toEqual({ project_id: "e2" });
    expect(sqlite.prepare("SELECT merged_into FROM graph_entities WHERE id = 'e2'").get()).toEqual({
      merged_into: "e1",
    });
    expect(
      sqlite
        .prepare(
          "SELECT id, review, sensitivity, subject_kind, superseded_by FROM graph_facts ORDER BY id",
        )
        .all(),
    ).toEqual([
      {
        id: "f1",
        review: "accepted",
        sensitivity: "none",
        subject_kind: "about_other",
        superseded_by: "f2",
      },
      {
        id: "f2",
        review: "accepted",
        sensitivity: "none",
        subject_kind: "owner_stated",
        superseded_by: null,
      },
    ]);
    expect(sqlite.pragma("foreign_key_check")).toEqual([]);
    // References now point at the final table names, so cascades still work.
    sqlite.prepare("DELETE FROM graph_entities WHERE id = 'e1'").run();
    expect(count("graph_facts")).toBe(0);
    expect(count("graph_participants")).toBe(0);
  });

  it("accepts the new kinds, attributes and relations and refuses the old CHECK gaps", () => {
    const sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    runMigrations(sqlite);
    const t = "2026-10-28T00:00:00.000Z";
    const ent = sqlite.prepare(
      "INSERT INTO graph_entities (id, kind, name, sort_name, created_at, updated_at) VALUES (?,?,?,?,?,?)",
    );
    ent.run("p", "person", "Sam", "sam", t, t);
    ent.run("ev", "event", "Lisbon", "lisbon", t, t);
    ent.run("tp", "topic", "Rust", "rust", t, t);
    expect(() => ent.run("x", "thing", "Car", "car", t, t)).toThrow();
    const fact = (id: string, attr: string, extra = "") =>
      sqlite.exec(
        `INSERT INTO graph_facts (id, entity_id, attribute, value, provenance, confidence, valid_from, recorded_at, created_at, updated_at${extra ? ", sensitivity" : ""}) VALUES ('${id}','p','${attr}','v','untrusted',0.5,'${t}','${t}','${t}','${t}'${extra ? `,'${extra}'` : ""})`,
      );
    fact("a", "likes");
    expect(() => fact("b", "likes", "gov_id")).toThrow();
    expect(() => fact("c", "ssn")).toThrow();
    sqlite.exec(
      `INSERT INTO graph_edges (id, src, dst, rel, role, provenance, confidence, valid_from, created_at, updated_at) VALUES ('g','p','p','family','sibling','untrusted',0.5,'${t}','${t}','${t}')`,
    );
    expect(() =>
      sqlite.exec(
        `INSERT INTO graph_edges (id, src, dst, rel, provenance, confidence, valid_from, created_at, updated_at) VALUES ('h','p','p','knows','untrusted',0.5,'${t}','${t}','${t}')`,
      ),
    ).toThrow();
  });

  it("deletes a target's citations with it, including by entity cascade", () => {
    const sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    runMigrations(sqlite);
    const t = "2026-10-28T00:00:00.000Z";
    sqlite.exec(
      `INSERT INTO graph_entities (id, kind, name, sort_name, created_at, updated_at) VALUES ('p','person','Sam','sam','${t}','${t}');
       INSERT INTO graph_facts (id, entity_id, attribute, value, provenance, confidence, valid_from, recorded_at, created_at, updated_at) VALUES ('f','p','city','Lisbon','untrusted',0.5,'${t}','${t}','${t}','${t}');
       INSERT INTO graph_citations (id, target_kind, target_id, source, source_ref, quote, start, "end", source_hash, provenance, observed_at, created_at) VALUES ('c','fact','f','mail','m1','I live in Lisbon',0,16,'h','untrusted','${t}','${t}');`,
    );
    sqlite.exec("DELETE FROM graph_entities WHERE id = 'p'");
    expect(sqlite.prepare("SELECT count(*) AS n FROM graph_citations").get()).toEqual({ n: 0 });
  });
});
