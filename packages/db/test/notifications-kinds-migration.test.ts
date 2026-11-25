import { describe, expect, it } from "vitest";
import { openDb } from "../src/index.ts";

/** 202611251100_notifications_kinds: `promise_due` and `specialist_result` are storable kinds. */
describe("notifications kinds migration", () => {
  const insert = (db: ReturnType<typeof openDb>, id: string, kind: string) =>
    db.sqlite
      .prepare(
        `INSERT INTO notifications (id, kind, title, body, seq, created_at, updated_at)
         VALUES (?, ?, 't', 'b', 1, '2026-11-25T00:00:00.000Z', '2026-11-25T00:00:00.000Z')`,
      )
      .run(id, kind);

  it("accepts the new kinds and still refuses an unknown one", () => {
    const db = openDb(":memory:");
    insert(db, "n1", "promise_due");
    insert(db, "n2", "specialist_result");
    insert(db, "n3", "approval");
    expect(() => insert(db, "n4", "not_a_kind")).toThrow(/CHECK/);
    db.close();
  });

  it("keeps its indexes and the delivery foreign key", () => {
    const db = openDb(":memory:");
    const names = (
      db.sqlite
        .prepare(
          "SELECT name FROM sqlite_master WHERE tbl_name = 'notifications' AND type = 'index'",
        )
        .all() as { name: string }[]
    ).map((r) => r.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "notifications_seq_idx",
        "notifications_open_dedupe_idx",
        "notifications_open_task_idx",
      ]),
    );
    insert(db, "n1", "promise_due");
    db.sqlite
      .prepare(
        `INSERT INTO notification_deliveries (notification_id, surface, status, created_at, updated_at)
         VALUES ('n1', 'desktop', 'pending', 'x', 'x')`,
      )
      .run();
    expect(db.sqlite.pragma("foreign_key_check")).toEqual([]);
    db.close();
  });
});
