import { describe, expect, it } from "vitest";
import { SPACE_MAIN_CHAT_REASON } from "../src/index.ts";
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

  // r1 finding 1: a run in the main chat gets neither the Space's head nor its scope, so an
  // automation in a Space never targets main.
  it.each([
    ["create in a Space aimed at main", "create", { sessionTarget: "main", spaceId: "sp_a" }, true],
    [
      "create in a Space, isolated",
      "create",
      { sessionTarget: "isolated", spaceId: "sp_a" },
      false,
    ],
    [
      "create in a Space, named",
      "create",
      { sessionTarget: "named:tiles", spaceId: "sp_a" },
      false,
    ],
    ["create outside a Space aimed at main", "create", { sessionTarget: "main" }, false],
    ["move an isolated one in a Space to main", "retarget", { sessionTarget: "main" }, true],
    ["move a main one into a Space", "join", { spaceId: "sp_a" }, true],
    [
      "move a main one into a Space and off main",
      "join",
      { spaceId: "sp_a", sessionTarget: "isolated" },
      false,
    ],
  ] as const)("%s", async (_label, op, change, refused) => {
    const { scheduler, db } = setup({ start: T0 });
    addSpace(db, "sp_a");
    const attempt = async () => {
      if (op === "create") return scheduler.create({ ...hourly, ...change });
      if (op === "retarget") {
        const a = await scheduler.create({ ...hourly, spaceId: "sp_a" });
        return scheduler.update(a.id, change);
      }
      const a = await scheduler.create({ ...hourly, sessionTarget: "main" });
      return scheduler.update(a.id, change);
    };
    if (refused) {
      await expect(attempt()).rejects.toMatchObject({
        code: "invalid_params",
        details: { reason: SPACE_MAIN_CHAT_REASON },
      });
    } else {
      await expect(attempt()).resolves.toBeDefined();
    }
  });

  it("stays when its Space is deleted, with no Space", async () => {
    const { scheduler, db } = setup({ start: T0 });
    addSpace(db, "sp_a");
    const a = await scheduler.create({ ...hourly, spaceId: "sp_a" });
    db.sqlite.prepare("DELETE FROM spaces WHERE id = 'sp_a'").run();
    expect((await scheduler.get(a.id))?.spaceId).toBeNull();
  });
});
