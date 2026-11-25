import { describe, expect, it } from "vitest";
import { calendarAdapter } from "../../src/night-shift/adapters/calendar.ts";
import type { CaptureOk, StagedCall } from "../../src/night-shift/adapters/types.ts";
import { event, FakeRegistry } from "./adapters-registry.ts";

function setup() {
  const reg = new FakeRegistry();
  reg.events.set("e-1", event());
  const flavors: Record<string, "apple" | "google" | "microsoft"> = {
    apple: "apple",
    google: "google",
    microsoft: "microsoft",
  };
  return { reg, adapter: calendarAdapter(reg, { flavorOf: (id) => flavors[id] }) };
}

// Apple-shaped (flat) calls, as bare tool names.
const update: StagedCall = {
  tool: "calendar_update_event",
  args: { id: "e-1", location: "Room 4" },
};
const create: StagedCall = {
  tool: "calendar_create_event",
  args: { title: "Plan", start: "2026-11-26T09:00:00Z", end: "2026-11-26T10:00:00Z" },
};

// Google- and Microsoft-shaped calls, with the connector prefix W1 resolves.
const gCreate = (
  event: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): StagedCall => ({
  tool: "mcp__google__calendar_create_event",
  args: { event, ...extra },
});
const gEvent = {
  summary: "Plan",
  start: { dateTime: "2026-11-26T09:00:00Z" },
  end: { dateTime: "2026-11-26T10:00:00Z" },
};
const gUpdate = (extra: Record<string, unknown>): StagedCall => ({
  tool: "mcp__google__calendar_update_event",
  args: { eventId: "e-1", event: { location: "Room 4" }, ...extra },
});
const msUpdate = (extra: Record<string, unknown>): StagedCall => ({
  tool: "mcp__microsoft__calendar_update_event",
  args: { eventId: "e-1", event: { location: "Room 4" }, ...extra },
});

describe("calendar adapter (flat shape)", () => {
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
    reg.events.clear();
    reg.events.set("e-3", event({ id: "e-3", title: "Plan", start: "2026-11-27T09:00:00Z" }));
    expect(await adapter.check(create, cap)).toEqual({ fresh: true });
  });

  const REFUSED: Array<[string, StagedCall, string]> = [
    [
      "create with attendees",
      { ...create, args: { ...create.args, attendees: ["a@x.com"] } },
      "unknown_key:attendees",
    ],
    [
      "create with guests",
      { ...create, args: { ...create.args, guests: ["a@x.com"] } },
      "unknown_key:guests",
    ],
    [
      "update adding attendees",
      { ...update, args: { ...update.args, attendees: ["a@x.com"] } },
      "unknown_key:attendees",
    ],
    [
      "update with a second event id",
      { ...update, args: { ...update.args, eventId: "shared-9" } },
      "unknown_key:eventId",
    ],
    [
      "sendUpdates on a flat call",
      { ...create, args: { ...create.args, sendUpdates: "all" } },
      "unknown_key:sendUpdates",
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
    expect(p.rows.find((r) => r.label === "title")?.value).toBe("<b>Plan</b> x");
  });
});

describe("calendar adapter (Google and Microsoft shapes)", () => {
  it("captures a Google create and checks the duplicate on summary and start", async () => {
    const { reg, adapter } = setup();
    const call = gCreate(gEvent, { calendarId: "work", sendUpdates: "none" });
    const cap = (await adapter.capture(call)) as CaptureOk;
    expect(cap.ok).toBe(true);
    reg.events.set("e-2", event({ id: "e-2", title: "Plan", start: "2026-11-26T09:00:00Z" }));
    expect(await adapter.check(call, cap)).toEqual({ fresh: false, reason: "duplicate" });
  });

  const REFUSED: Array<[string, StagedCall, string]> = [
    [
      "event.attendees on create",
      gCreate({ ...gEvent, attendees: [{ email: "eve@evil.com" }] }),
      "attendees_refused",
    ],
    [
      "event.attendees on update",
      gUpdate({ event: { attendees: [{ email: "eve@evil.com" }] } }),
      "attendees_refused",
    ],
    ["sendUpdates all (create)", gCreate(gEvent, { sendUpdates: "all" }), "send_updates_refused"],
    ["sendUpdates all (update)", gUpdate({ sendUpdates: "all" }), "send_updates_refused"],
    ["sendUpdates externalOnly", gUpdate({ sendUpdates: "externalOnly" }), "send_updates_refused"],
    ["unknown top-level key", gCreate(gEvent, { notify: true }), "unknown_key:notify"],
    [
      "unknown event key",
      gCreate({ ...gEvent, guestsCanInviteOthers: true }),
      "unknown_key:event.guestsCanInviteOthers",
    ],
    [
      "conferenceData smuggled in",
      gCreate({ ...gEvent, conferenceData: {} }),
      "unknown_key:event.conferenceData",
    ],
    [
      "flat call to a Google connector",
      { tool: "mcp__google__calendar_create_event", args: create.args },
      "shape_mismatch",
    ],
    [
      "event-shaped call to Apple",
      { tool: "mcp__apple__calendar_create_event", args: { event: gEvent } },
      "shape_mismatch",
    ],
    ["Microsoft has no sendUpdates", msUpdate({ sendUpdates: "none" }), "unknown_key:sendUpdates"],
    ["update with both id and eventId", gUpdate({ id: "solo" }), "unknown_key:id"],
  ];
  it.each(REFUSED)("refuses %s", async (_n, call, reason) => {
    const { adapter } = setup();
    expect(await adapter.capture(call)).toEqual({ ok: false, reason });
  });

  it("accepts empty attendees and sendUpdates none", async () => {
    const { adapter } = setup();
    const call = gCreate({ ...gEvent, attendees: [] }, { sendUpdates: "none" });
    expect((await adapter.capture(call)).ok).toBe(true);
  });

  it("judges the event the connector will write: eventId in calendarId", async () => {
    const { reg, adapter } = setup();
    // The registry answers for `shared-9` too: a shared event the model did not name in `id`.
    reg.events.set("shared-9", event({ id: "shared-9", attendees: ["ann@x.com"] }));
    const call = gUpdate({ eventId: "shared-9", calendarId: "work" });
    expect(await adapter.capture(call)).toEqual({ ok: false, reason: "attendees_refused" });
    // A registry that returns another event than the one asked for is refused.
    reg.events.set("e-1", event({ id: "other" }));
    expect(await adapter.capture(gUpdate({}))).toEqual({ ok: false, reason: "event_mismatch" });
  });

  it("Microsoft update captures, checks and restores in the event shape", async () => {
    const { reg, adapter } = setup();
    const call = msUpdate({ calendarId: "work" });
    const cap = (await adapter.capture(call)) as CaptureOk;
    expect(cap).toMatchObject({ ok: true, target: "work/e-1", before: { location: "Desk" } });
    expect(await adapter.check(call, cap)).toEqual({ fresh: true });
    expect(adapter.inverse?.(call, cap)).toEqual({
      tool: "mcp__microsoft__calendar_update_event",
      args: { calendarId: "work", eventId: "e-1", event: { location: "Desk" } },
    });
    reg.events.set("e-1", event({ attendees: ["eve@evil.com"] }));
    expect(await adapter.check(call, cap)).toEqual({ fresh: false, reason: "attendee_added" });
  });

  it("the preview lists every written field: calendarId, recurrence, url, alarms", async () => {
    const { adapter } = setup();
    const call = gCreate(
      { ...gEvent, location: "HQ", description: "d", recurrence: ["RRULE:FREQ=DAILY"] },
      { calendarId: "work" },
    );
    const p = adapter.preview(call, (await adapter.capture(call)) as CaptureOk);
    const labels = p.rows.map((r) => r.label);
    for (const l of [
      "Calendar",
      "summary",
      "start",
      "end",
      "location",
      "description",
      "recurrence",
    ]) {
      expect(labels).toContain(l);
    }
    expect(p.rows.find((r) => r.label === "Calendar")?.value).toBe("work");
    const flat = {
      ...create,
      args: {
        ...create.args,
        url: "https://x.example/join",
        alarms: [{ relativeMinutes: -10 }],
        recurrence: { frequency: "daily" },
      },
    };
    const fp = adapter.preview(flat, (await adapter.capture(flat)) as CaptureOk);
    for (const l of ["url", "alarms", "recurrence"])
      expect(fp.rows.map((r) => r.label)).toContain(l);
  });
});
