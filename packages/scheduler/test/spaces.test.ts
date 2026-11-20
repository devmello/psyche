import { describe, expect, it } from "vitest";
import { BASE, setup } from "./helpers.ts";

const T0 = Date.parse("2026-11-20T12:00:00Z");

/** An automation's Space (docs/design/spaces-2026.md §4.1): stored, checked and read back. */
function addSpace(db: ReturnType<typeof setup>["db"], id: string, archived = false) {
  db.sqlite
    .prepare(
      `INSERT INTO spaces (id, name, sort, created_from, created_at, updated_at, archived_at)
       VALUES (?, ?, 0, 'owner', ?, ?, ?)`,
    )
    .run(id, `Space ${id}`, db.now(), db.now(), archived ? db.now() : null);
}

const hourly = { ...BASE, kind: "interval", schedule: "PT1H" } as const;

describe("an automation's Space", () => {
  it("is created in a Space, moved to another, and moved out", async () => {
    const { scheduler, db } = setup({ start: T0 });
    addSpace(db, "sp_a");
    addSpace(db, "sp_b");
    const a = await scheduler.create({ ...hourly, spaceId: "sp_a" });
    expect(a.spaceId).toBe("sp_a");
    expect((await scheduler.update(a.id, { spaceId: "sp_b" })).spaceId).toBe("sp_b");
    expect((await scheduler.update(a.id, { title: "Renamed" })).spaceId).toBe("sp_b");
    expect((await scheduler.update(a.id, { spaceId: null })).spaceId).toBeNull();
    expect((await scheduler.create(hourly)).spaceId).toBeNull();
  });

  it("refuses an unknown or archived Space", async () => {
    const { scheduler, db } = setup({ start: T0 });
    addSpace(db, "sp_old", true);
    await expect(scheduler.create({ ...hourly, spaceId: "ghost" })).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(scheduler.create({ ...hourly, spaceId: "sp_old" })).rejects.toMatchObject({
      code: "conflict",
    });
  });

  it("stays when its Space is deleted, with no Space", async () => {
    const { scheduler, db } = setup({ start: T0 });
    addSpace(db, "sp_a");
    const a = await scheduler.create({ ...hourly, spaceId: "sp_a" });
    db.sqlite.prepare("DELETE FROM spaces WHERE id = 'sp_a'").run();
    expect((await scheduler.get(a.id))?.spaceId).toBeNull();
  });
});
