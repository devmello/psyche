import { copyFileSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_MIGRATIONS_DIR, runMigrations } from "../src/index.ts";
import { makeTmpDir } from "./helpers.ts";

const NEW = "202611241000_memory_promises.sql";
const T = "2026-11-20T00:00:00.000Z";

/** The promise ledger's v2 rebuild of graph_loops (docs/design/promise-ledger-2026.md §8.1). */
describe("202611241000 memory promises", () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    for (const c of cleanups.splice(0)) c();
  });

  /** A database migrated up to, but not including, the promise ledger migration. */
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

  function seedV1(sqlite: Database.Database): void {
    const run = (sql: string, ...args: unknown[]) => sqlite.prepare(sql).run(...args);
    run(
      "INSERT INTO graph_entities (id, kind, name, sort_name, created_at, updated_at) VALUES ('e1','person','Sam','sam',?,?)",
      T,
      T,
    );
    run(
      "INSERT INTO graph_interactions (id, kind, source, external_ref, occurred_at, direction, thread_key, created_at) VALUES ('im','mail','mail','m1',?,'out','thread-1',?)",
      T,
      T,
    );
    run(
      "INSERT INTO graph_interactions (id, kind, source, external_ref, occurred_at, direction, thread_key, created_at) VALUES ('ig','meeting','notes','n1',?,'both',NULL,?)",
      T,
      T,
    );
    run(
      "INSERT INTO graph_interactions (id, kind, source, external_ref, occurred_at, direction, thread_key, created_at) VALUES ('ic','chat','chats','c1',?,'out','t-chat',?)",
      T,
      T,
    );
    const loop = (
      id: string,
      direction: string,
      status: string,
      detectedBy: string,
      dueAt: string | null,
      interaction: string | null,
      closedBy: string | null,
    ) =>
      run(
        "INSERT INTO graph_loops (id, direction, text, evidence, counterpart_id, due_at, status, source_interaction_id, provenance, confidence, detected_by, dedupe_key, created_at, updated_at, closed_at, closed_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        id,
        direction,
        `text ${id}`,
        `evidence ${id}`,
        "e1",
        dueAt,
        status,
        interaction,
        "untrusted",
        0.7,
        detectedBy,
        `key-${id}`,
        T,
        T,
        closedBy === null ? null : T,
        closedBy,
      );
    // Every v1 state, and every detector, so the backfill of `basis` is checked on each.
    loop("l-sug", "waiting_on", "suggested", "model", null, "ig", null);
    loop("l-open", "i_owe", "open", "owner", "2026-11-27T17:00:00.000Z", "im", null);
    loop("l-snz", "i_owe", "snoozed", "model", null, null, null);
    loop("l-done", "waiting_on", "done", "rule", null, "im", "reply_seen");
    loop("l-dis", "i_owe", "dismissed", "rule", null, "ic", "owner");
    loop("l-ask", "waiting_on", "open", "rule", "2026-12-01T00:00:00.000Z", "im", null);
    loop("l-late", "i_owe", "dismissed", "owner", null, null, "due_passed");
    // A loop from a meeting that the rule detector wrote is still a promise (meeting source).
    loop("l-meet-rule", "i_owe", "open", "rule", null, "ig", null);
    run(
      "INSERT INTO graph_feedback (id, kind, entity_id, key_hash, created_at) VALUES ('fb1','dismissed_loop','e1','kh',?)",
      T,
    );
    run(
      "INSERT INTO graph_feedback (id, kind, entity_id, key_hash, created_at) VALUES ('fb2','wrong_fact','e1',NULL,?)",
      T,
    );
    run(
      "INSERT INTO graph_facts (id, entity_id, attribute, value, provenance, confidence, valid_from, recorded_at, created_at, updated_at) VALUES ('f1','e1','city','Lisbon','untrusted',0.5,?,?,?,?)",
      T,
      T,
      T,
      T,
    );
    run(
      "INSERT INTO graph_citations (id, target_kind, target_id, source, source_ref, quote, start, \"end\", source_hash, author_entity_id, provenance, observed_at, created_at) VALUES ('c1','fact','f1','mail','m1','I live in Lisbon',0,16,'h','e1','untrusted',?,?)",
      T,
      T,
    );
    run(
      "INSERT INTO graph_citations (id, target_kind, target_id, source, source_ref, quote, start, \"end\", source_hash, author_entity_id, provenance, observed_at, created_at) VALUES ('c2','interaction','im','mail','m1','hello',0,5,'h','e1','untrusted',?,?)",
      T,
      T,
    );
  }

  it("keeps every v1 loop, maps its state and backfills basis, due and source fields", () => {
    const sqlite = before();
    seedV1(sqlite);
    const old = sqlite
      .prepare(
        "SELECT id, direction, text, evidence, counterpart_id, project_id, due_at, status, source_interaction_id, provenance, confidence, detected_by, dedupe_key, created_at, updated_at, closed_at, closed_by FROM graph_loops ORDER BY id",
      )
      .all();
    expect(old).toHaveLength(8);

    runMigrations(sqlite);

    expect(sqlite.pragma("foreign_key_check")).toEqual([]);
    // Every pre-existing column reads back unchanged: states map to themselves (none is lost).
    const now = sqlite
      .prepare(
        "SELECT id, direction, text, evidence, counterpart_id, project_id, due_at, status, source_interaction_id, provenance, confidence, detected_by, dedupe_key, created_at, updated_at, closed_at, closed_by FROM graph_loops ORDER BY id",
      )
      .all();
    expect(now).toEqual(old);

    const ledger = Object.fromEntries(
      (
        sqlite
          .prepare(
            "SELECT id, basis, what_action, due_text, due_kind, due_confidence, proposed_due_at, snoozed_until, broken_at, warned_at, nudge_count, last_nudge_at, thread_key, source_kind, counterpart_label, remote_visible FROM graph_loops",
          )
          .all() as { id: string }[]
      ).map((r) => [r.id, r]),
    );
    const base = {
      what_action: null,
      due_text: null,
      proposed_due_at: null,
      snoozed_until: null,
      broken_at: null,
      warned_at: null,
      nudge_count: 0,
      last_nudge_at: null,
      counterpart_label: null,
      // Fail closed: nothing is remote-visible until the ledger recomputes it.
      remote_visible: 0,
    };
    // rule + waiting_on -> ask; model-written or meeting-sourced -> promise; the rest -> request.
    expect(ledger["l-ask"]).toMatchObject({
      ...base,
      basis: "ask",
      due_kind: "explicit",
      due_confidence: 0.8,
      thread_key: "thread-1",
      source_kind: "mail",
    });
    expect(ledger["l-done"]).toMatchObject({ ...base, basis: "ask", due_kind: "none" });
    expect(ledger["l-sug"]).toMatchObject({
      ...base,
      basis: "promise",
      due_kind: "none",
      due_confidence: null,
      thread_key: null,
      source_kind: "meeting",
    });
    expect(ledger["l-snz"]).toMatchObject({
      ...base,
      basis: "promise",
      source_kind: null,
      thread_key: null,
    });
    expect(ledger["l-meet-rule"]).toMatchObject({
      ...base,
      basis: "promise",
      source_kind: "meeting",
    });
    expect(ledger["l-open"]).toMatchObject({
      ...base,
      basis: "request",
      due_kind: "explicit",
      due_confidence: 0.8,
      thread_key: "thread-1",
      source_kind: "mail",
    });
    expect(ledger["l-dis"]).toMatchObject({
      ...base,
      basis: "request",
      source_kind: "chat",
      thread_key: "t-chat",
    });
    expect(ledger["l-late"]).toMatchObject({ ...base, basis: "request", source_kind: null });

    // The other rebuilt tables keep their rows too.
    expect(count(sqlite, "graph_feedback")).toBe(2);
    expect(count(sqlite, "graph_citations")).toBe(2);
    expect(sqlite.prepare("SELECT kind FROM graph_feedback ORDER BY id").all()).toEqual([
      { kind: "dismissed_loop" },
      { kind: "wrong_fact" },
    ]);
    expect(
      sqlite.prepare("SELECT quote, target_kind FROM graph_citations ORDER BY id").all(),
    ).toEqual([
      { quote: "I live in Lisbon", target_kind: "fact" },
      { quote: "hello", target_kind: "interaction" },
    ]);

    // Existing cleanup triggers still point at the final table: deleting the fact takes its
    // citation, and so does deleting an interaction.
    sqlite.prepare("DELETE FROM graph_facts WHERE id = 'f1'").run();
    expect(count(sqlite, "graph_citations")).toBe(1);
  });

  it("is a no-op on an empty ledger and creates the indexes and the events table", () => {
    const sqlite = before();
    runMigrations(sqlite);
    expect(sqlite.pragma("foreign_key_check")).toEqual([]);
    const idx = (
      sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as {
        name: string;
      }[]
    ).map((r) => r.name);
    for (const name of [
      "graph_loops_status_idx",
      "graph_loops_counterpart_idx",
      "graph_loops_dedupe_idx",
      "graph_loops_due_idx",
      "graph_loops_person_status_idx",
      "graph_citations_target_idx",
      "graph_citations_source_idx",
      "graph_citations_author_idx",
      "graph_feedback_entity_idx",
      "graph_loop_events_loop_idx",
    ])
      expect(idx, name).toContain(name);
    expect(count(sqlite, "graph_loop_events")).toBe(0);
  });

  it("accepts the new states, citations on loops, feedback kinds and events, and rejects others", () => {
    const sqlite = before();
    seedV1(sqlite);
    runMigrations(sqlite);
    const run = (sql: string, ...args: unknown[]) => sqlite.prepare(sql).run(...args);

    // The new states and closers, and every ledger column, written then read back.
    run(
      `UPDATE graph_loops SET status = 'broken', basis = 'promise', what_action = 'send',
         due_text = 'by Friday', due_kind = 'inferred', due_confidence = 0.5,
         proposed_due_at = '2026-12-02T17:00:00.000Z', snoozed_until = '2026-11-25T08:00:00.000Z',
         broken_at = '2026-11-28T06:00:00.000Z', warned_at = '2026-11-26T16:00:00.000Z',
         nudge_count = 2, last_nudge_at = '2026-11-30T09:00:00.000Z', thread_key = 'tk',
         source_kind = 'mail', counterpart_label = 'Sam Lee', remote_visible = 1
       WHERE id = 'l-open'`,
    );
    expect(
      sqlite
        .prepare(
          "SELECT status, basis, what_action, due_text, due_kind, due_confidence, proposed_due_at, snoozed_until, broken_at, warned_at, nudge_count, last_nudge_at, thread_key, source_kind, counterpart_label, remote_visible FROM graph_loops WHERE id = 'l-open'",
        )
        .get(),
    ).toEqual({
      status: "broken",
      basis: "promise",
      what_action: "send",
      due_text: "by Friday",
      due_kind: "inferred",
      due_confidence: 0.5,
      proposed_due_at: "2026-12-02T17:00:00.000Z",
      snoozed_until: "2026-11-25T08:00:00.000Z",
      broken_at: "2026-11-28T06:00:00.000Z",
      warned_at: "2026-11-26T16:00:00.000Z",
      nudge_count: 2,
      last_nudge_at: "2026-11-30T09:00:00.000Z",
      thread_key: "tk",
      source_kind: "mail",
      counterpart_label: "Sam Lee",
      remote_visible: 1,
    });
    run("UPDATE graph_loops SET status = 'released', closed_by = 'released' WHERE id = 'l-snz'");
    run("UPDATE graph_loops SET status = 'dismissed', closed_by = 'aged_out' WHERE id = 'l-sug'");
    run("UPDATE graph_loops SET status = 'done', closed_by = 'auto' WHERE id = 'l-ask'");

    // Out-of-range values are refused (positive controls above, negatives here).
    const bad = (set: string) =>
      expect(() => run(`UPDATE graph_loops SET ${set} WHERE id = 'l-dis'`), set).toThrow();
    bad("status = 'lost'");
    bad("closed_by = 'nobody'");
    bad("basis = 'rumour'");
    bad("what_action = 'think'");
    bad("due_kind = 'maybe'");
    bad("due_confidence = 1.5");
    bad("source_kind = 'fax'");
    bad("remote_visible = 2");
    // The belt: a Messages-sourced promise can never be remote-visible (design section 7.2).
    bad("source_kind = 'messages', remote_visible = 1");
    run("UPDATE graph_loops SET source_kind = 'messages', remote_visible = 0 WHERE id = 'l-dis'");
    bad("remote_visible = 1");
    bad("nudge_count = -1");

    // Citations attach to loops, and a deleted loop takes them and its events along.
    run(
      "INSERT INTO graph_citations (id, target_kind, target_id, source, source_ref, quote, start, \"end\", source_hash, author_entity_id, provenance, observed_at, created_at) VALUES ('c3','loop','l-open','mail','m1','I will send it',0,14,'h','e1','owner',?,?)",
      T,
      T,
    );
    for (const kind of [
      "created",
      "confirmed",
      "source_added",
      "due_changed",
      "due_proposed",
      "status",
      "warned",
      "asked",
      "nudge_drafted",
      "nudge_sent",
      "auto_done",
      "undo",
    ])
      run(
        "INSERT INTO graph_loop_events (id, loop_id, at, kind, from_value, to_value, by, citation_id) VALUES (?,?,?,?,?,?,?,?)",
        `ev-${kind}`,
        "l-open",
        T,
        kind,
        "a",
        "b",
        "owner",
        "c3",
      );
    expect(() =>
      run(
        "INSERT INTO graph_loop_events (id, loop_id, at, kind, by) VALUES ('x','l-open',?,'nope','owner')",
        T,
      ),
    ).toThrow();
    expect(() =>
      run(
        "INSERT INTO graph_loop_events (id, loop_id, at, kind, by) VALUES ('y','l-open',?,'status','robot')",
        T,
      ),
    ).toThrow();
    expect(() =>
      run(
        "INSERT INTO graph_loop_events (id, loop_id, at, kind, by) VALUES ('z','missing',?,'status','owner')",
        T,
      ),
    ).toThrow();
    expect(count(sqlite, "graph_loop_events")).toBe(12);
    run("DELETE FROM graph_loops WHERE id = 'l-open'");
    expect(count(sqlite, "graph_loop_events")).toBe(0);
    expect(
      sqlite.prepare("SELECT count(*) AS n FROM graph_citations WHERE target_kind = 'loop'").get(),
    ).toEqual({ n: 0 });

    // The new feedback kinds.
    run(
      "INSERT INTO graph_feedback (id, kind, key_hash, created_at) VALUES ('n1','not_promise','h',?)",
      T,
    );
    run(
      "INSERT INTO graph_feedback (id, kind, key_hash, created_at) VALUES ('n2','confirmed_promise','h',?)",
      T,
    );
    expect(() =>
      run("INSERT INTO graph_feedback (id, kind, created_at) VALUES ('n3','bogus',?)", T),
    ).toThrow();
    expect(sqlite.pragma("foreign_key_check")).toEqual([]);
  });

  it("leaves a legacy-style insert (no ledger columns) working with safe defaults", () => {
    const sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    runMigrations(sqlite);
    sqlite
      .prepare(
        "INSERT INTO graph_loops (id, direction, text, status, provenance, confidence, detected_by, dedupe_key, created_at, updated_at) VALUES ('l','i_owe','x','open','owner',1,'owner','k',?,?)",
      )
      .run(T, T);
    expect(
      sqlite
        .prepare(
          "SELECT basis, due_kind, nudge_count, remote_visible, source_kind FROM graph_loops WHERE id = 'l'",
        )
        .get(),
    ).toEqual({
      basis: "request",
      due_kind: "none",
      nudge_count: 0,
      remote_visible: 0,
      source_kind: null,
    });
  });

  it("a dangling row in an unrelated table does not block the migration, and is logged", () => {
    const sqlite = before();
    seedV1(sqlite);
    // A violation the rebuild did not cause: a fact whose entity is gone (foreign keys off).
    sqlite.pragma("foreign_keys = OFF");
    sqlite
      .prepare(
        "INSERT INTO graph_facts (id, entity_id, attribute, value, provenance, confidence, valid_from, recorded_at, created_at, updated_at) VALUES ('dangling','nobody','city','Oslo','untrusted',0.5,?,?,?,?)",
      )
      .run(T, T, T, T);
    sqlite.pragma("foreign_keys = ON");
    const warnings: [string, unknown][] = [];
    const result = runMigrations(sqlite, {
      logger: { warn: (m, f) => warnings.push([m, f]) },
    });
    expect(result.applied).toContain("202611241000_memory_promises");
    expect(count(sqlite, "graph_loops")).toBe(8);
    // Every later table rebuild also finds the same dangling fact and logs it: one line each.
    expect(warnings.length).toBeGreaterThanOrEqual(1);
    for (const w of warnings)
      expect(w).toEqual([
        "db.migration.foreign_key_violations_elsewhere",
        { count: expect.any(Number), tables: expect.arrayContaining(["graph_facts"]) },
      ]);
  });
});

describe("foreign key check after a rebuild", () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    for (const c of cleanups.splice(0)) c();
  });

  function run(sql: string): { error?: string; warnings: number } {
    const { dir, cleanup } = makeTmpDir();
    cleanups.push(cleanup);
    mkdirSync(join(dir, "m"));
    writeFileSync(join(dir, "m", "202611240001_test_base.sql"), BASE);
    writeFileSync(
      join(dir, "m", "202611250000_test_rebuild.sql"),
      `-- migrate: foreign_keys=off\n${sql}`,
    );
    const sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = OFF");
    let warnings = 0;
    try {
      runMigrations(sqlite, { dir: join(dir, "m"), logger: { warn: () => warnings++ } });
      return { warnings };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e), warnings };
    }
  }

  // The tables exist before the rebuild; `other` already holds a dangling row.
  const BASE = `CREATE TABLE parent (id TEXT PRIMARY KEY NOT NULL);
CREATE TABLE other (id TEXT PRIMARY KEY NOT NULL, p TEXT REFERENCES parent (id));
CREATE TABLE child (id TEXT PRIMARY KEY NOT NULL, p TEXT REFERENCES parent (id));
INSERT INTO other VALUES ('o1', 'gone');
`;

  it("aborts when a rebuilt table ends up with a dangling reference", () => {
    const r = run(`
CREATE TABLE child_new (id TEXT PRIMARY KEY NOT NULL, p TEXT REFERENCES parent (id));
INSERT INTO child_new VALUES ('c1', 'missing');
DROP TABLE child;
ALTER TABLE child_new RENAME TO child;
`);
    expect(r.error).toMatch(/foreign key violation/);
  });

  it("only logs a violation in a table the migration did not touch", () => {
    const r = run(`
CREATE TABLE child_new (id TEXT PRIMARY KEY NOT NULL, p TEXT REFERENCES parent (id));
DROP TABLE child;
ALTER TABLE child_new RENAME TO child;
`);
    expect(r.error).toBeUndefined();
    expect(r.warnings).toBe(1);
  });
});
