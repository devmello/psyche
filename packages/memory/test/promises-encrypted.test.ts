import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MIGRATIONS_DIR, runMigrations } from "@psyche/db";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { copyTables, MEMORY_STORE_TABLES, newKey, openEncrypted } from "../src/secure/encrypted.ts";
import { syncSchema } from "../src/secure/migrate.ts";

const NEW = "202611241000_memory_promises.sql";
const T = "2026-11-20T00:00:00.000Z";

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "psyche-promises-")));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A database migrated up to, but not including, the promise ledger migration. */
function plainBefore(): Database.Database {
  const old = join(dir, "before");
  mkdirSync(old);
  for (const f of readdirSync(DEFAULT_MIGRATIONS_DIR)) {
    if (f.endsWith(".sql") && f < NEW) copyFileSync(join(DEFAULT_MIGRATIONS_DIR, f), join(old, f));
  }
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  runMigrations(sqlite, { dir: old });
  return sqlite;
}

const LEDGER_COLUMNS =
  "status, basis, what_action, due_text, due_kind, due_confidence, proposed_due_at, snoozed_until, broken_at, warned_at, nudge_count, last_nudge_at, thread_key, source_kind, counterpart_label, remote_visible";

const LEDGER_ROW = {
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
};

function writeLedger(db: Database.Database, id = "l1"): void {
  db.prepare(
    `UPDATE graph_loops SET status = @status, basis = @basis, what_action = @what_action,
       due_text = @due_text, due_kind = @due_kind, due_confidence = @due_confidence,
       proposed_due_at = @proposed_due_at, snoozed_until = @snoozed_until, broken_at = @broken_at,
       warned_at = @warned_at, nudge_count = @nudge_count, last_nudge_at = @last_nudge_at,
       thread_key = @thread_key, source_kind = @source_kind, counterpart_label = @counterpart_label,
       remote_visible = @remote_visible WHERE id = @id`,
  ).run({ ...LEDGER_ROW, id });
  db.prepare(
    "INSERT INTO graph_citations (id, target_kind, target_id, source, source_ref, quote, start, \"end\", source_hash, provenance, observed_at, created_at) VALUES ('c1','loop',?,'mail','m1','I will send it',0,14,'h','owner',?,?)",
  ).run(id, T, T);
  db.prepare(
    "INSERT INTO graph_loop_events (id, loop_id, at, kind, from_value, to_value, by, citation_id) VALUES ('ev1',?,?,'status','open','broken','auto','c1')",
  ).run(id, T);
  db.prepare(
    "INSERT INTO graph_feedback (id, kind, key_hash, created_at) VALUES ('fb','not_promise','h',?)",
  ).run(T);
}

describe("promise ledger in the encrypted memory store", () => {
  it("lists the events table among the moved tables", () => {
    expect(MEMORY_STORE_TABLES).toContain("graph_loop_events");
    expect(MEMORY_STORE_TABLES).toContain("graph_loops");
  });

  it("moves every ledger column, citation, event and feedback kind and reads them back", () => {
    const plain = new Database(":memory:");
    plain.pragma("foreign_keys = ON");
    runMigrations(plain);
    plain
      .prepare(
        "INSERT INTO graph_loops (id, direction, text, status, provenance, confidence, detected_by, dedupe_key, created_at, updated_at) VALUES ('l1','i_owe','send the deck','open','owner',0.9,'model','k',?,?)",
      )
      .run(T, T);
    writeLedger(plain);
    const enc = openEncrypted(join(dir, "memory.sqlite"), newKey());
    const report = copyTables(enc, plain, MEMORY_STORE_TABLES);
    expect(report.verified).toBe(true);
    expect(report.tables.graph_loop_events).toBe(1);
    expect(enc.prepare(`SELECT ${LEDGER_COLUMNS} FROM graph_loops WHERE id = 'l1'`).get()).toEqual(
      LEDGER_ROW,
    );
    expect(enc.prepare("SELECT kind, by, citation_id FROM graph_loop_events").get()).toEqual({
      kind: "status",
      by: "auto",
      citation_id: "c1",
    });
    expect(enc.prepare("SELECT target_kind FROM graph_citations").get()).toEqual({
      target_kind: "loop",
    });
    // The cleanup trigger came along: deleting the loop in the encrypted file takes both.
    enc.pragma("foreign_keys = ON");
    enc.prepare("DELETE FROM graph_loops WHERE id = 'l1'").run();
    expect(enc.prepare("SELECT count(*) n FROM graph_loop_events").get()).toEqual({ n: 0 });
    expect(enc.prepare("SELECT count(*) n FROM graph_citations").get()).toEqual({ n: 0 });
    enc.close();
    plain.close();
  });

  it("upgrades an encrypted file made before the ledger: rows kept, backfilled like the plain file", () => {
    const plain = plainBefore();
    const run = (sql: string, ...a: unknown[]) => plain.prepare(sql).run(...a);
    run(
      "INSERT INTO graph_entities (id, kind, name, sort_name, created_at, updated_at) VALUES ('e1','person','Sam','sam',?,?)",
      T,
      T,
    );
    for (const [id, kind, thread] of [
      ["im", "mail", "thread-1"],
      ["ig", "meeting", null],
      ["ic", "chat", "t-chat"],
      ["is", "message", "t-msg"],
    ] as const)
      run(
        "INSERT INTO graph_interactions (id, kind, source, external_ref, occurred_at, direction, thread_key, created_at) VALUES (?,?,'s',?,?,'out',?,?)",
        id,
        kind,
        id,
        T,
        thread,
        T,
      );
    const loop = (
      id: string,
      direction: string,
      status: string,
      by: string,
      due: string | null,
      src: string | null,
    ) =>
      run(
        "INSERT INTO graph_loops (id, direction, text, counterpart_id, due_at, status, source_interaction_id, provenance, confidence, detected_by, dedupe_key, created_at, updated_at) VALUES (?,?,?,'e1',?,?,?,'untrusted',0.7,?,?,?,?)",
        id,
        direction,
        `text ${id}`,
        due,
        status,
        src,
        by,
        `k-${id}`,
        T,
        T,
      );
    loop("l-ask", "waiting_on", "open", "rule", "2026-12-01T00:00:00.000Z", "im");
    loop("l-theirs", "waiting_on", "suggested", "model", null, "ig");
    loop("l-mine", "i_owe", "open", "model", "2026-11-27T17:00:00.000Z", "is");
    loop("l-req", "i_owe", "open", "owner", null, "ic");
    loop("l-meet", "i_owe", "open", "rule", null, "ig");
    loop("l-none", "i_owe", "dismissed", "owner", null, null);
    run(
      "INSERT INTO graph_feedback (id, kind, key_hash, created_at) VALUES ('old','dismissed_loop','h',?)",
      T,
    );
    const enc = openEncrypted(join(dir, "memory.sqlite"), newKey());
    copyTables(enc, plain, MEMORY_STORE_TABLES);

    // The plain database takes the migration, then the encrypted file follows it.
    runMigrations(plain);
    const rebuilt = syncSchema(enc, plain, MEMORY_STORE_TABLES);
    expect(rebuilt).toEqual(
      expect.arrayContaining(["graph_loops", "graph_citations", "graph_feedback"]),
    );
    expect(rebuilt).toContain("graph_loop_events");
    expect(enc.pragma("foreign_key_check")).toEqual([]);
    const cols = `id, ${LEDGER_COLUMNS}`;
    const fromEnc = enc.prepare(`SELECT ${cols} FROM graph_loops ORDER BY id`).all();
    // The encrypted file ends up exactly where the migration put the plain one.
    expect(fromEnc).toEqual(plain.prepare(`SELECT ${cols} FROM graph_loops ORDER BY id`).all());
    const by = Object.fromEntries((fromEnc as { id: string }[]).map((r) => [r.id, r]));
    expect(by["l-ask"]).toMatchObject({
      basis: "ask",
      due_kind: "explicit",
      due_confidence: 0.8,
      thread_key: "thread-1",
      source_kind: "mail",
    });
    expect(by["l-theirs"]).toMatchObject({
      basis: "promise",
      status: "suggested",
      due_kind: "none",
      due_confidence: null,
      source_kind: "meeting",
    });
    expect(by["l-mine"]).toMatchObject({
      basis: "promise",
      source_kind: "messages",
      thread_key: "t-msg",
      remote_visible: 0,
    });
    expect(by["l-req"]).toMatchObject({
      basis: "request",
      source_kind: "chat",
      thread_key: "t-chat",
    });
    expect(by["l-meet"]).toMatchObject({ basis: "promise", source_kind: "meeting" });
    expect(by["l-none"]).toMatchObject({ basis: "request", source_kind: null, thread_key: null });
    expect(enc.prepare("SELECT kind FROM graph_feedback").all()).toEqual([
      { kind: "dismissed_loop" },
    ]);
    // A second sync is a no-op: the backfill does not run again over later writes.
    enc.prepare("UPDATE graph_loops SET basis = 'ask' WHERE id = 'l-req'").run();
    expect(syncSchema(enc, plain, MEMORY_STORE_TABLES)).toEqual([]);
    expect(enc.prepare("SELECT basis FROM graph_loops WHERE id = 'l-req'").get()).toEqual({
      basis: "ask",
    });
    // Every column still writes and reads on the upgraded file.
    writeLedger(enc as unknown as Database.Database, "l-ask");
    expect(
      enc.prepare(`SELECT ${LEDGER_COLUMNS} FROM graph_loops WHERE id = 'l-ask'`).get(),
    ).toEqual(LEDGER_ROW);
    enc.close();
    plain.close();
  });
});
