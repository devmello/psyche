import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_MIGRATIONS_DIR, runMigrations } from "../src/index.ts";
import { makeTmpDir } from "./helpers.ts";

const NEW = "202611031400_memory_work.sql";
const T = "2026-11-02T00:00:00.000Z";

describe("202611031400 memory work", () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    for (const c of cleanups.splice(0)) c();
  });

  function before(): Database.Database {
    const { dir, cleanup } = makeTmpDir();
    cleanups.push(cleanup);
    const old = join(dir, "before");
    mkdirSync(old);
    for (const f of readdirSync(DEFAULT_MIGRATIONS_DIR)) {
      if (f.endsWith(".sql") && f < NEW)
        copyFileSync(join(DEFAULT_MIGRATIONS_DIR, f), join(old, f));
    }
    const sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    runMigrations(sqlite, { dir: old });
    return sqlite;
  }

  const count = (sqlite: Database.Database, table: string) =>
    (sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

  it("rebuilds the graph and keeps every row, citation and dependent table", () => {
    const sqlite = before();
    const run = (sql: string, ...args: unknown[]) => sqlite.prepare(sql).run(...args);
    run(
      "INSERT INTO graph_entities (id, kind, name, sort_name, created_at, updated_at) VALUES (?,?,?,?,?,?)",
      "e1",
      "person",
      "Sam",
      "sam",
      T,
      T,
    );
    run(
      "INSERT INTO graph_entities (id, kind, name, sort_name, project_status, due_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
      "e2",
      "project",
      "Remodel",
      "remodel",
      "active",
      "2026-12-01T00:00:00.000Z",
      T,
      T,
    );
    run("UPDATE graph_entities SET merged_into = 'e1' WHERE id = 'e2'");
    run(
      "INSERT INTO graph_facts (id, entity_id, attribute, value, provenance, confidence, valid_from, recorded_at, created_at, updated_at) VALUES ('f1','e1','city','Lisbon','untrusted',0.5,?,?,?,?)",
      T,
      T,
      T,
      T,
    );
    run(
      "INSERT INTO graph_facts (id, entity_id, attribute, value, provenance, confidence, valid_from, recorded_at, created_at, updated_at) VALUES ('f2','e1','city','Porto','owner',1,?,?,?,?)",
      T,
      T,
      T,
      T,
    );
    run("UPDATE graph_facts SET superseded_by = 'f2' WHERE id = 'f1'");
    run(
      "INSERT INTO graph_edges (id, src, dst, rel, provenance, confidence, valid_from, created_at, updated_at) VALUES ('g1','e1','e2','member_of','owner',1,?,?,?)",
      T,
      T,
      T,
    );
    run(
      "INSERT INTO graph_interactions (id, kind, source, external_ref, occurred_at, direction, project_id, created_at) VALUES ('i1','mail','mail','m1',?,'in','e2',?)",
      T,
      T,
    );
    run("INSERT INTO graph_participants VALUES ('i1','e1','from')");
    run(
      "INSERT INTO graph_loops (id, direction, text, project_id, source_interaction_id, status, provenance, confidence, detected_by, dedupe_key, created_at, updated_at) VALUES ('l1','waiting_on','reply','e2','i1','open','owner',1,'owner','k',?,?)",
      T,
      T,
    );
    run(
      "INSERT INTO graph_citations (id, target_kind, target_id, source, source_ref, quote, start, \"end\", source_hash, author_entity_id, provenance, observed_at, created_at) VALUES ('c1','fact','f2','mail','m1','I moved to Porto',0,16,'h','e1','untrusted',?,?)",
      T,
      T,
    );
    run(
      "INSERT INTO memory_quarantine (id, source, source_ref, sender_entity_id, reasons, excerpt, created_at) VALUES ('q1','mail','m9','e1','[\"x\"]','hi',?)",
      T,
    );
    run("INSERT INTO memory_never_rules VALUES ('attribute_for_entity','e1','city',?)", T);
    run("INSERT INTO memory_trusted_senders VALUES ('e1','trusted',?)", T);
    run(
      "INSERT INTO graph_fact_vectors VALUES ('f2','m','th',2,?,?)",
      Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]),
      T,
    );
    run(
      "INSERT INTO graph_suggestions (id, kind, entity_ids, name, reason, status, key_hash, created_at, updated_at) VALUES ('s1','project','[\"e1\"]','Remodel','why','pending','kh',?,?)",
      T,
      T,
    );

    runMigrations(sqlite);

    expect(sqlite.pragma("foreign_key_check")).toEqual([]);
    for (const [table, n] of [
      ["graph_entities", 2],
      ["graph_facts", 2],
      ["graph_edges", 1],
      ["graph_interactions", 1],
      ["graph_participants", 1],
      ["graph_loops", 1],
      ["graph_citations", 1],
      ["memory_quarantine", 1],
      ["memory_never_rules", 1],
      ["memory_trusted_senders", 1],
      ["graph_fact_vectors", 1],
      ["graph_suggestions", 1],
    ] as const) {
      expect(count(sqlite, table), table).toBe(n);
    }
    expect(
      sqlite
        .prepare(
          "SELECT kind, project_status, project_type, work_status, last_signal_at, private, due_at, merged_into FROM graph_entities WHERE id = 'e2'",
        )
        .get(),
    ).toEqual({
      kind: "project",
      project_status: "active",
      project_type: "project",
      work_status: null,
      last_signal_at: null,
      private: 0,
      due_at: "2026-12-01T00:00:00.000Z",
      merged_into: "e1",
    });
    expect(sqlite.prepare("SELECT superseded_by FROM graph_facts WHERE id = 'f1'").get()).toEqual({
      superseded_by: "f2",
    });
    expect(sqlite.prepare("SELECT gist FROM graph_interactions WHERE id = 'i1'").get()).toEqual({
      gist: null,
    });
    expect(
      sqlite.prepare("SELECT project_type, due_at FROM graph_suggestions WHERE id = 's1'").get(),
    ).toEqual({ project_type: null, due_at: null });

    // References point at the final names: a fact's delete takes its citation and vectors,
    // an interaction's delete takes its participants, and the entity cascade reaches the rest.
    sqlite.prepare("DELETE FROM graph_facts WHERE id = 'f2'").run();
    expect(count(sqlite, "graph_citations")).toBe(0);
    expect(count(sqlite, "graph_fact_vectors")).toBe(0);
    sqlite.prepare("DELETE FROM graph_interactions WHERE id = 'i1'").run();
    expect(count(sqlite, "graph_participants")).toBe(0);
    sqlite.prepare("DELETE FROM graph_entities WHERE id = 'e1'").run();
    expect(count(sqlite, "memory_quarantine")).toBe(1);
    expect(count(sqlite, "memory_never_rules")).toBe(0);
    expect(count(sqlite, "memory_trusted_senders")).toBe(0);
    expect(sqlite.pragma("foreign_key_check")).toEqual([]);
  });

  it("accepts assignments, work attributes, relations, interaction kinds and anchors", () => {
    const sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    runMigrations(sqlite);
    const ent = sqlite.prepare(
      "INSERT INTO graph_entities (id, kind, name, sort_name, project_type, work_status, due_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
    );
    ent.run("c", "project", "MATH 21", "math 21", "course", null, null, T, T);
    ent.run(
      "a",
      "assignment",
      "HW7",
      "hw7",
      "project",
      "not_started",
      "2026-11-06T00:00:00.000Z",
      T,
      T,
    );
    ent.run("p", "person", "Prof", "prof", "project", null, null, T, T);
    // A course is a project; only an assignment has a work status.
    expect(() => ent.run("x", "person", "Bad", "bad", "course", null, null, T, T)).toThrow();
    expect(() => ent.run("y", "project", "Bad", "bad", "project", "done", null, T, T)).toThrow();
    expect(() =>
      ent.run("z", "assignment", "Bad", "bad", "project", "overdue", null, T, T),
    ).toThrow();

    const edge = (id: string, src: string, dst: string, rel: string) =>
      sqlite
        .prepare(
          "INSERT INTO graph_edges (id, src, dst, rel, provenance, confidence, valid_from, created_at, updated_at) VALUES (?,?,?,?,'owner',1,?,?,?)",
        )
        .run(id, src, dst, rel, T, T, T);
    edge("g1", "a", "c", "part_of");
    edge("g2", "a", "p", "assigned_by");
    edge("g3", "p", "c", "teaches");

    for (const attribute of [
      "progress",
      "stopped_at",
      "blocked_on",
      "course_code",
      "term",
      "meets",
    ]) {
      sqlite
        .prepare(
          "INSERT INTO graph_facts (id, entity_id, attribute, value, provenance, confidence, valid_from, recorded_at, created_at, updated_at) VALUES (?,?,?,?,'owner',1,?,?,?,?)",
        )
        .run(`f_${attribute}`, "a", attribute, "v", T, T, T, T);
    }

    const inter = sqlite.prepare(
      "INSERT INTO graph_interactions (id, kind, source, external_ref, occurred_at, direction, created_at, gist) VALUES (?,?,?,?,?,'none',?,?)",
    );
    for (const kind of ["file", "reminder", "work"])
      inter.run(`i_${kind}`, kind, "x", kind, T, T, null);
    expect(() => inter.run("i_bad", "browser", "x", "b", T, T, null)).toThrow();
    expect(() => inter.run("i_long", "chat", "x", "long", T, T, "x".repeat(121))).toThrow();
    inter.run("i_gist", "chat", "x", "gist", T, T, "Talked about the Lisbon dates");

    sqlite
      .prepare(
        "INSERT INTO graph_suggestions (id, kind, entity_ids, name, reason, status, key_hash, created_at, updated_at, project_type, due_at) VALUES ('s','assignment','[\"c\"]','HW8','why','pending','k',?,?,NULL,?)",
      )
      .run(T, T, "2026-11-09T00:00:00.000Z");

    // Anchors: owner and rule anchors are confirmed; a model anchor starts unconfirmed.
    const anchor = sqlite.prepare(
      "INSERT INTO graph_anchors (id, entity_id, kind, ref, label, added_by, confirmed, created_at) VALUES (?,?,?,?,?,?,?,?)",
    );
    anchor.run("n1", "c", "folder", "/Users/me/School/MATH21", "MATH21", "owner", 1, T);
    anchor.run("n2", "a", "folder", "/Users/me/School/MATH21", "MATH21", "rule", 1, T);
    anchor.run("n3", "a", "mail_thread", "t1", "", "model", 0, T);
    expect(() => anchor.run("n4", "a", "mail_thread", "t2", "", "model", 1, T)).not.toThrow();
    expect(() => anchor.run("n5", "a", "mail_thread", "t3", "", "owner", 0, T)).toThrow();
    expect(() =>
      anchor.run("n6", "a", "folder", "/Users/me/School/MATH21", "", "rule", 1, T),
    ).toThrow();
    expect(() => anchor.run("n7", "a", "inbox", "x", "", "owner", 1, T)).toThrow();

    // Many subjects per interaction.
    const subject = sqlite.prepare(
      "INSERT INTO graph_interaction_subjects (interaction_id, entity_id, linked_by, confidence, created_at) VALUES (?,?,?,?,?)",
    );
    subject.run("i_file", "c", "rule", 1, T);
    subject.run("i_file", "a", "rule", 1, T);
    expect(() => subject.run("i_file", "a", "rule", 1, T)).toThrow();
    sqlite.prepare("DELETE FROM graph_entities WHERE id = 'a'").run();
    expect(count(sqlite, "graph_interaction_subjects")).toBe(1);
    expect(
      sqlite.prepare("SELECT count(*) AS n FROM graph_anchors WHERE entity_id = 'a'").get(),
    ).toEqual({ n: 0 });

    // A deleted interaction takes its citations (the gist's, §2.6).
    sqlite
      .prepare(
        "INSERT INTO graph_citations (id, target_kind, target_id, source, source_ref, quote, start, \"end\", source_hash, provenance, observed_at, created_at) VALUES ('c1','interaction','i_gist','mail','m1','the Lisbon dates',0,16,'h','untrusted',?,?)",
      )
      .run(T, T);
    sqlite.prepare("DELETE FROM graph_interactions WHERE id = 'i_gist'").run();
    expect(count(sqlite, "graph_citations")).toBe(0);
    expect(sqlite.pragma("foreign_key_check")).toEqual([]);
  });
});
