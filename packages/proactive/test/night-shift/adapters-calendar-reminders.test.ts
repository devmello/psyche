import { describe, expect, it } from "vitest";
import { remindersAdapter } from "../../src/night-shift/adapters/reminders.ts";
import type { CaptureOk } from "../../src/night-shift/adapters/types.ts";
import { FakeRegistry, reminder } from "./adapters-registry.ts";

describe("reminders adapter", () => {
  function setup() {
    const reg = new FakeRegistry();
    reg.reminders.set("r-1", reminder());
    return { reg, adapter: remindersAdapter(reg) };
  }
  const update = { tool: "reminders_update", args: { id: "r-1", notes: "after" } };
  const complete = { tool: "reminders_complete", args: { id: "r-1" } };
  const create = { tool: "reminders_create", args: { title: "Pay rent", listId: "L" } };

  it("update and complete: fresh, then stale when changed or gone", async () => {
    for (const call of [update, complete]) {
      const { reg, adapter } = setup();
      const cap = (await adapter.capture(call)) as CaptureOk;
      expect(cap.ok).toBe(true);
      expect(await adapter.check(call, cap)).toEqual({ fresh: true });
      reg.reminders.set("r-1", reminder({ modifiedAt: "2026-11-25T00:00:00Z" }));
      expect(await adapter.check(call, cap)).toEqual({ fresh: false, reason: "changed" });
      reg.reminders.delete("r-1");
      expect(await adapter.check(call, cap)).toEqual({ fresh: false, reason: "reminder_gone" });
    }
  });

  it("create: stale on a duplicate title in the same list only", async () => {
    const { reg, adapter } = setup();
    const cap = (await adapter.capture(create)) as CaptureOk;
    expect(await adapter.check(create, cap)).toEqual({ fresh: true });
    reg.reminders.set("r-2", reminder({ id: "r-2", title: "Pay rent", listId: "Other" }));
    expect(await adapter.check(create, cap)).toEqual({ fresh: true });
    reg.reminders.set("r-3", reminder({ id: "r-3", title: "Pay rent", listId: "L" }));
    expect(await adapter.check(create, cap)).toEqual({ fresh: false, reason: "duplicate" });
    expect(await adapter.capture(create)).toEqual({ ok: false, reason: "duplicate" });
  });

  it("complete by title needs exactly one match", async () => {
    const { reg, adapter } = setup();
    const byTitle = { tool: "reminders_complete", args: { title: "Call dentist", listId: "L" } };
    expect(await adapter.capture(byTitle)).toMatchObject({ ok: true, target: "r-1" });
    reg.reminders.set("r-2", reminder({ id: "r-2" }));
    expect(await adapter.capture(byTitle)).toEqual({ ok: false, reason: "ambiguous_title" });
    expect(await adapter.capture({ tool: "reminders_complete", args: { title: "nope" } })).toEqual({
      ok: false,
      reason: "reminder_gone",
    });
  });

  it("inverses: create deletes, complete uncompletes, update restores", async () => {
    const { adapter } = setup();
    const ucap = (await adapter.capture(update)) as CaptureOk;
    expect(adapter.inverse?.(update, ucap)).toEqual({
      tool: "reminders_update",
      args: { id: "r-1", notes: "before" },
    });
    const ccap = (await adapter.capture(complete)) as CaptureOk;
    expect(adapter.inverse?.(complete, ccap)).toEqual({
      tool: "reminders_complete",
      args: { id: "r-1", completed: false },
    });
    const ncap = (await adapter.capture(create)) as CaptureOk;
    expect(adapter.inverse?.(create, ncap)).toBeUndefined();
    expect(adapter.inverse?.(create, ncap, { id: "r-new" })).toEqual({
      tool: "reminders_delete",
      args: { id: "r-new" },
      destructive: true,
    });
  });

  it("fails closed when the registry is down", async () => {
    const { reg, adapter } = setup();
    reg.failing = true;
    expect(await adapter.capture(update)).toEqual({ ok: false, reason: "reminders_unreadable" });
  });
});
