import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MIGRATIONS_DIR, openDb, type PsycheDb } from "@psyche/db";
import { FakeClock } from "@psyche/testing";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryReceiptStore, Receipts, SqliteReceiptStore } from "../src/index.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function dbFile(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "psyche-audit-")));
  dirs.push(dir);
  return join(dir, "psyche.sqlite");
}

/** The `UPDATE` in the short-seq migration, so the test runs the shipped backfill. */
function backfillSql(): string {
  const sql = readFileSync(
    join(DEFAULT_MIGRATIONS_DIR, "202610211300_audit_receipt-short-seq.sql"),
    "utf8",
  )
    .split("\n")
    .filter((l) => !l.startsWith("--"))
    .join("\n");
  const stmt = sql.split(";").find((s) => s.trim().startsWith("UPDATE"));
  if (stmt === undefined) throw new Error("backfill statement not found");
  return stmt;
}

let ids = 0;
function boot(db: PsycheDb, clock: FakeClock) {
  return new Receipts({
    clock,
    store: new SqliteReceiptStore(db.sqlite),
    newId: () => `rcp_${++ids}`,
  });
}

const send = (summary: string) => ({ kind: "email.send", outcome: "ok" as const, summary });

describe("receipt short ids are unique across restarts (#66)", () => {
  it("continues numbering after the Receipts instance and the database are reopened", async () => {
    const clock = new FakeClock();
    const file = dbFile();
    const db0 = openDb(file);
    const boot0 = boot(db0, clock);
    expect((await boot0.record(send("a"))).shortId).toBe("R1");
    expect((await boot0.record(send("b"))).shortId).toBe("R2");
    db0.close();

    const db1 = openDb(file);
    const boot1 = boot(db1, clock);
    const c = await boot1.record(send("c"));
    expect(c.shortId).toBe("R3");
    expect((await boot1.get(c.id))?.shortId).toBe("R3");
    const all = (await boot1.list()).map((r) => r.shortId);
    expect(all).toEqual(["R1", "R2", "R3"]);
    db1.close();
  });

  it("two instances on one database never hand out the same id", async () => {
    const clock = new FakeClock();
    const db = openDb(":memory:");
    const a = boot(db, clock);
    const b = boot(db, clock);
    const got = [
      await a.record(send("1")),
      await b.record(send("2")),
      await a.record(send("3")),
      await b.record(send("4")),
    ].map((r) => r.shortId);
    expect(got).toEqual(["R1", "R2", "R3", "R4"]);
  });

  it("an explicit R<n> short id moves the sequence; other short ids do not", async () => {
    const clock = new FakeClock();
    const db = openDb(":memory:");
    const r = boot(db, clock);
    await r.record({ ...send("x"), shortId: "R7" });
    await r.record({ ...send("y"), shortId: "custom-1" });
    expect((await r.record(send("z"))).shortId).toBe("R8");
  });

  it("the memory store numbers from what it holds, too", async () => {
    const store = new MemoryReceiptStore();
    const first = new Receipts({ store });
    await first.record(send("a"));
    await first.record(send("b"));
    expect((await new Receipts({ store }).record(send("c"))).shortId).toBe("R3");
  });

  it("the migration backfills existing R<n> ids so the next id follows the highest", async () => {
    const clock = new FakeClock();
    const db = openDb(":memory:");
    db.sqlite
      .prepare(
        "INSERT INTO receipts (id, short_id, kind, outcome, summary, created_at, updated_at) VALUES ('old', 'R41', 'k', 'ok', 's', 't', 't')",
      )
      .run();
    // A row written before the column existed, then the migration's backfill statement.
    db.sqlite.prepare("UPDATE receipts SET short_seq = NULL").run();
    db.sqlite.prepare(backfillSql()).run();
    expect((await boot(db, clock).record(send("n"))).shortId).toBe("R42");
  });
});
