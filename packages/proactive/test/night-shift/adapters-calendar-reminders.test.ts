import { describe, expect, it } from "vitest";
import { calendarAdapter } from "../../src/night-shift/adapters/calendar.ts";
import { remindersAdapter } from "../../src/night-shift/adapters/reminders.ts";
import type { CaptureOk } from "../../src/night-shift/adapters/types.ts";
import { event, FakeRegistry, reminder } from "./adapters-registry.ts";

describe("calendar adapter", () => {
  function setup() {
    const reg = new FakeRegistry();
    reg.events.set("e-1", event());
    return { reg, adapter: calendarAdapter(reg) };
  }
  const update = { tool: "calendar_update_event", args: { id: "e-1", location: "Room 4" } };
  const create = {
    tool: "calendar_create_event",
    args: { title: "Plan", start: "2026-11-26T09:00:00Z", end: "2026-11-26T10:00:00Z" },
  };

  it("captures an update of a solo event, with the before snapshot", async () => {
    const { adapter } = setup();
    const r = (await adapter.capture(update)) as CaptureOk;
    expect(r).toMatchObject({ ok: true, target: "e-1", before: { location: "Desk" } });
  });

  it("is fresh, then stale on an etag change, a deleted event and an added attendee", async () => {
    const { reg, adapter } = setup();
    const cap = (await adapter.capture(update)) as CaptureOk;
    expect(await adapter.check(update, cap)).toEqual({ fresh: true });
    reg.events.set("e-1", event({ etag: "v2" }));
    expect(await adapter.check(update, cap)).toEqual({ fresh: false, reason: "changed" });
    reg.events.set("e-1", event({ attendees: ["ann@x.com"] }));
    expect(await adapter.check(update, cap)).toEqual({ fresh: false, reason: "attendee_added" });
    reg.events.delete("e-1");
    expect(await adapter.check(update, cap)).toEqual({ fresh: false, reason: "event_gone" });
  });

  it("create: fresh until a duplicate with the same title and start appears", async () => {
    const { reg, adapter } = setup();
    const cap = (await adapter.capture(create)) as CaptureOk;
    expect(cap.ok).toBe(true);
    expect(await adapter.check(create, cap)).toEqual({ fresh: true });
    reg.events.set("e-2", event({ id: "e-2", title: "Plan", start: "2026-11-26T09:00:00Z" }));
    expect(await adapter.check(create, cap)).toEqual({ fresh: false, reason: "duplicate" });
    // A near miss (same title, other start) is not a duplicate.
    reg.events.clear();
    reg.events.set("e-3", event({ id: "e-3", title: "Plan", start: "2026-11-27T09:00:00Z" }));
    expect(await adapter.check(create, cap)).toEqual({ fresh: true });
  });

  const REFUSED: Array<[string, { tool: string; args: Record<string, unknown> }, string]> = [
    [
      "create with attendees",
      { ...create, args: { ...create.args, attendees: ["a@x.com"] } },
      "attendees_refused",
    ],
    [
      "create with guests",
      { ...create, args: { ...create.args, guests: ["a@x.com"] } },
      "attendees_refused",
    ],
    [
      "update adding attendees",
      { ...update, args: { ...update.args, attendees: ["a@x.com"] } },
      "attendees_refused",
    ],
    ["series update", { ...update, args: { ...update.args, span: "future" } }, "series_refused"],
    ["unknown event", { ...update, args: { id: "e-404", location: "x" } }, "event_gone"],
  ];
  it.each(REFUSED)("refuses %s", async (_n, call, reason) => {
    const { adapter } = setup();
    expect(await adapter.capture(call)).toEqual({ ok: false, reason });
  });

  it("refuses an update of an event that already has other attendees", async () => {
    const { reg, adapter } = setup();
    reg.events.set("e-1", event({ attendees: ["ann@x.com"] }));
    expect(await adapter.capture(update)).toEqual({ ok: false, reason: "attendees_refused" });
  });

  it("refuses a create that is already a duplicate, and an unreadable registry", async () => {
    const { reg, adapter } = setup();
    reg.events.set("e-2", event({ id: "e-2", title: "Plan", start: "2026-11-26T09:00:00Z" }));
    expect(await adapter.capture(create)).toEqual({ ok: false, reason: "duplicate" });
    reg.failing = true;
    expect(await adapter.capture(update)).toEqual({ ok: false, reason: "calendar_unreadable" });
  });

  it("inverse restores the snapshot for an update and deletes for a create", async () => {
    const { adapter } = setup();
    const cap = (await adapter.capture(update)) as CaptureOk;
    expect(adapter.inverse?.(update, cap)).toEqual({
      tool: "calendar_update_event",
      args: { id: "e-1", location: "Desk" },
    });
    const ccap = (await adapter.capture(create)) as CaptureOk;
    expect(adapter.inverse?.(create, ccap)).toBeUndefined();
    expect(adapter.inverse?.(create, ccap, { id: "e-new" })).toEqual({
      tool: "calendar_delete_event",
      args: { id: "e-new" },
      destructive: true,
    });
  });

  it("inverse is refused when the event changed since apply", async () => {
    const { reg, adapter } = setup();
    const cap = (await adapter.capture(update)) as CaptureOk;
    const post = await adapter.postState?.(update, cap);
    expect(await adapter.checkInverse?.(update, cap, post ?? null)).toEqual({ fresh: true });
    reg.events.set("e-1", event({ etag: "v3" }));
    expect(await adapter.checkInverse?.(update, cap, post ?? null)).toEqual({
      fresh: false,
      reason: "changed_since_apply",
    });
  });

  it("previews as plain data", async () => {
    const { adapter } = setup();
    const call = { ...create, args: { ...create.args, title: "<b>Plan</b>\u0085x" } };
    const p = adapter.preview(call, (await adapter.capture(call)) as CaptureOk);
    expect(p.rows[0]?.value).toBe("<b>Plan</b> x");
  });
});

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
