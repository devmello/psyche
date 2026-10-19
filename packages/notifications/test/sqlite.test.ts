import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createValidator, Notification as NotificationSchema } from "@psyche/protocol";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { notificationsMigrationSql, SqliteNotificationStore } from "../src/index.ts";
import { setup } from "./helpers.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fileDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "psyche-ntf-"));
  dirs.push(dir);
  return join(dir, "psyche.sqlite");
}

describe("SqliteNotificationStore", () => {
  it("survives a restart: inbox, delivery state, dedupe and reconciliation", async () => {
    const path = fileDb();
    let db = new Database(path);
    const quiet = { quietHours: { start: "22:00", end: "07:00", timezone: "UTC" } };
    const first = setup({
      store: new SqliteNotificationStore(db, { migrate: true }),
      routing: quiet,
    });
    first.clock.set(Date.UTC(2026, 9, 18, 23));
    const done = await first.notifier.notify({
      kind: "task_done",
      title: "D",
      body: "",
      taskId: "t1",
    });
    const apr = await first.notifier.notify({
      kind: "approval",
      title: "A",
      body: "",
      approvalId: "apr_1",
    });
    await first.notifier.markRead(done.id);
    db.close();

    db = new Database(path);
    const second = setup({ store: new SqliteNotificationStore(db), routing: quiet });
    second.clock.set(Date.UTC(2026, 9, 19, 7));
    expect((await second.notifier.list()).map((n) => n.id)).toEqual([apr.id, done.id]);
    const res = await second.notifier.reconcile({ bootedAt: second.clock.now() });
    expect(res.stale.map((n) => n.id)).toEqual([apr.id]);
    // The deferred OS delivery of the task notification survived and goes out now.
    expect(await second.notifier.flushDue()).toBe(1);
    expect(second.os.calls.map((c) => c.id)).toEqual([done.id]);
    // De-duplication still finds the open row after the restart.
    const again = await second.notifier.notify({
      kind: "task_done",
      title: "D2",
      body: "",
      taskId: "t1",
    });
    expect(again.id).toBe(done.id);
    for (const n of await second.notifier.list()) {
      expect(createValidator(NotificationSchema).errors(n)).toEqual([]);
    }
    db.close();
  });

  it("enforces one open notification per dedupe key in the schema", () => {
    const db = new Database(":memory:");
    db.exec(notificationsMigrationSql());
    const insert = (id: string, resolved: string | null) =>
      db
        .prepare(
          "INSERT INTO notifications (id, kind, title, body, dedupe_key, seq, resolved_at, created_at, updated_at) VALUES (?, 'input_needed', 't', 'b', 'k', ?, ?, 'x', 'x')",
        )
        .run(id, Number(id.slice(1)), resolved);
    insert("n1", "2026-10-18T20:00:00.000Z");
    insert("n2", null);
    expect(() => insert("n3", null)).toThrow(/UNIQUE/);
  });

  it("rejects unknown kinds and invalid JSON", () => {
    const db = new Database(":memory:");
    db.exec(notificationsMigrationSql());
    expect(() =>
      db
        .prepare(
          "INSERT INTO notifications (id, kind, title, body, seq, created_at, updated_at) VALUES ('n', 'spam', 't', 'b', 1, 'x', 'x')",
        )
        .run(),
    ).toThrow(/CHECK/);
    expect(() =>
      db
        .prepare(
          "INSERT INTO notifications (id, kind, title, body, actions, seq, created_at, updated_at) VALUES ('n', 'system', 't', 'b', '{', 1, 'x', 'x')",
        )
        .run(),
    ).toThrow(/CHECK/);
  });
});
