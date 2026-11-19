import { describe, expect, it, vi } from "vitest";
import type { useCall } from "../src/data/hooks.ts";
import {
  automationWrite,
  fromGateway,
  initialValues,
  nextRuns,
  type ScheduleChoice,
  saveAutomation,
  toDelivery,
  toGateway,
  validateForm,
} from "../src/screens/scheduled/schedule-form.ts";

// Wednesday 28 Oct 2026, 09:00 in Los Angeles (PDT). DST ends on 1 Nov.
const ZONE = "America/Los_Angeles";
const NOW = Date.parse("2026-10-28T16:00:00Z");
const ctx = { zone: ZONE, now: NOW };
const iso = (ms: number | undefined) => new Date(ms ?? Number.NaN).toISOString();

describe("each schedule option maps to the Gateway format", () => {
  it("once: a reminder with the instant as an ISO-8601 string with an offset", () => {
    const got = toGateway({ type: "once", date: "2026-11-20", time: "09:30" }, ctx);
    expect(got).toEqual({ kind: "reminder", schedule: "2026-11-20T09:30:00-08:00" });
  });

  it("daily: a 5-field cron at the time", () => {
    expect(toGateway({ type: "daily", time: "07:15" }, ctx)).toEqual({
      kind: "cron",
      schedule: "15 7 * * *",
    });
  });

  it("weekdays: cron on Monday to Friday", () => {
    expect(toGateway({ type: "weekdays", time: "07:30" }, ctx)).toEqual({
      kind: "cron",
      schedule: "30 7 * * 1-5",
    });
  });

  it("weekly: cron on the chosen days, sorted and without repeats", () => {
    expect(toGateway({ type: "weekly", days: [5, 1, 3, 3], time: "18:00" }, ctx)).toEqual({
      kind: "cron",
      schedule: "0 18 * * 1,3,5",
    });
  });

  it("every N hours: an ISO-8601 duration interval", () => {
    expect(toGateway({ type: "interval", hours: 6 }, ctx)).toEqual({
      kind: "interval",
      schedule: "PT6H",
    });
  });

  it("a custom schedule is kept exactly as stored", () => {
    expect(
      toGateway({ type: "custom", schedule: "*/5 * * * *" }, { ...ctx, editing: { kind: "cron" } }),
    ).toEqual({ kind: "cron", schedule: "*/5 * * * *" });
  });
});

describe("validation errors", () => {
  it("names the first problem with the schedule", () => {
    expect(toGateway({ type: "daily", time: "25:00" }, ctx)).toBe("time");
    expect(toGateway({ type: "once", date: "2026-02-30", time: "09:00" }, ctx)).toBe("date");
    expect(toGateway({ type: "once", date: "2026-10-01", time: "09:00" }, ctx)).toBe("past");
    expect(toGateway({ type: "weekly", days: [], time: "09:00" }, ctx)).toBe("days");
    expect(toGateway({ type: "interval", hours: 0 }, ctx)).toBe("hours");
    expect(toGateway({ type: "interval", hours: 169 }, ctx)).toBe("hours");
    expect(toGateway({ type: "interval", hours: 1.5 }, ctx)).toBe("hours");
  });

  it("refuses to turn a one-time automation repeating, or the other way round", () => {
    expect(
      toGateway({ type: "daily", time: "09:00" }, { ...ctx, editing: { kind: "reminder" } }),
    ).toBe("switch");
    expect(
      toGateway(
        { type: "once", date: "2026-11-20", time: "09:00" },
        { ...ctx, editing: { kind: "cron" } },
      ),
    ).toBe("switch");
  });

  it("a non-empty instruction is required, and a chat must be picked", () => {
    const base = {
      title: "",
      prompt: "   ",
      schedule: { type: "daily", time: "09:00" } as ScheduleChoice,
      delivery: { type: "inbox" as const },
      enabled: true,
    };
    const blank = validateForm(base, ctx);
    expect(blank.ok).toBe(false);
    if (!blank.ok) expect(blank.errors.prompt).toBe(true);

    const noChat = validateForm(
      { ...base, prompt: "Check", delivery: { type: "thread", threadId: "" } },
      ctx,
    );
    if (noChat.ok) throw new Error("expected errors");
    expect(noChat.errors.delivery).toBe(true);
  });
});

describe("editing maps back to the same choice", () => {
  const cases: [string, string, string, ScheduleChoice][] = [
    ["cron", "15 7 * * *", ZONE, { type: "daily", time: "07:15" }],
    ["cron", "30 7 * * 1-5", ZONE, { type: "weekdays", time: "07:30" }],
    ["cron", "0 18 * * 1,3,5", ZONE, { type: "weekly", days: [1, 3, 5], time: "18:00" }],
    ["interval", "PT6H", ZONE, { type: "interval", hours: 6 }],
    [
      "reminder",
      "2026-11-20T09:30:00-08:00",
      ZONE,
      { type: "once", date: "2026-11-20", time: "09:30" },
    ],
  ];
  for (const [kind, schedule, zone, choice] of cases) {
    it(`${kind} ${schedule}`, () => {
      expect(fromGateway(kind as never, schedule, zone)).toEqual(choice);
      const back = toGateway(choice, { zone, now: NOW });
      expect(back).toEqual({ kind, schedule });
    });
  }

  it("reads a one-time instant in the automation's own zone", () => {
    // 17:30 UTC on 20 Nov is 09:30 in Los Angeles (PST).
    expect(fromGateway("reminder", "2026-11-20T17:30:00Z", ZONE)).toEqual({
      type: "once",
      date: "2026-11-20",
      time: "09:30",
    });
  });

  it("keeps a schedule the picker cannot express as custom", () => {
    expect(fromGateway("cron", "*/5 * * * *", ZONE)).toEqual({
      type: "custom",
      schedule: "*/5 * * * *",
    });
    expect(fromGateway("interval", "PT30M", ZONE)).toEqual({ type: "custom", schedule: "PT30M" });
  });
});

describe("the next-runs preview", () => {
  it("daily: the next three fire times in the zone, across the coming days", () => {
    const runs = nextRuns({ type: "daily", time: "07:15" }, ZONE, NOW);
    expect(runs?.map(iso)).toEqual([
      "2026-10-29T14:15:00.000Z",
      "2026-10-30T14:15:00.000Z",
      "2026-10-31T14:15:00.000Z",
    ]);
  });

  it("weekdays: skips the weekend and keeps the time through the DST change", () => {
    const runs = nextRuns({ type: "weekdays", time: "07:30" }, ZONE, NOW);
    expect(runs?.map(iso)).toEqual([
      "2026-10-29T14:30:00.000Z",
      "2026-10-30T14:30:00.000Z",
      // Monday 2 Nov is on standard time, so 07:30 local is 15:30 UTC.
      "2026-11-02T15:30:00.000Z",
    ]);
  });

  it("weekly: counts today when its time is still ahead", () => {
    const runs = nextRuns({ type: "weekly", days: [1, 3, 5], time: "18:00" }, ZONE, NOW);
    expect(runs?.map(iso)).toEqual([
      "2026-10-29T01:00:00.000Z", // Wednesday 18:00
      "2026-10-31T01:00:00.000Z", // Friday 18:00
      "2026-11-03T02:00:00.000Z", // Monday 18:00
    ]);
  });

  it("every N hours: counted from now", () => {
    expect(nextRuns({ type: "interval", hours: 6 }, ZONE, NOW)).toEqual([
      NOW + 6 * 3_600_000,
      NOW + 12 * 3_600_000,
      NOW + 18 * 3_600_000,
    ]);
  });

  it("one time: the instant once, nothing when it has passed, nothing for a bad date", () => {
    expect(
      nextRuns({ type: "once", date: "2026-11-20", time: "09:30" }, ZONE, NOW)?.map(iso),
    ).toEqual(["2026-11-20T17:30:00.000Z"]);
    expect(nextRuns({ type: "once", date: "2026-10-01", time: "09:30" }, ZONE, NOW)).toEqual([]);
    expect(nextRuns({ type: "once", date: "nope", time: "09:30" }, ZONE, NOW)).toBeNull();
  });

  it("has no preview for an invalid or custom choice", () => {
    expect(nextRuns({ type: "daily", time: "" }, ZONE, NOW)).toBeNull();
    expect(nextRuns({ type: "weekly", days: [], time: "09:00" }, ZONE, NOW)).toBeNull();
    expect(nextRuns({ type: "custom", schedule: "*/5 * * * *" }, ZONE, NOW)).toBeNull();
  });
});

describe("create and edit call the right methods", () => {
  const callMock = () => vi.fn(async () => ({}));
  const asCall = (m: ReturnType<typeof callMock>) => m as unknown as ReturnType<typeof useCall>;

  const values = {
    title: "",
    prompt: "  Add the usual groceries to the cart.  ",
    schedule: { type: "daily", time: "09:00" } as ScheduleChoice,
    delivery: { type: "inbox" as const },
    enabled: true,
  };

  it("create: automations.create with the Gateway kind, schedule and the system zone", async () => {
    const call = callMock();
    await saveAutomation(asCall(call), values, ctx);
    expect(call).toHaveBeenCalledWith("automations.create", {
      kind: "cron",
      title: "Add the usual groceries to the cart.",
      schedule: "0 9 * * *",
      prompt: "Add the usual groceries to the cart.",
      timezone: ZONE,
      delivery: {},
      enabled: true,
    });
  });

  it("create: a one-time schedule is a reminder, and a chat delivery names the thread", async () => {
    const call = callMock();
    await saveAutomation(
      asCall(call),
      {
        ...values,
        title: "Dentist",
        schedule: { type: "once", date: "2026-11-20", time: "09:30" },
        delivery: { type: "thread", threadId: "thread_7" },
      },
      ctx,
    );
    expect(call).toHaveBeenCalledWith(
      "automations.create",
      expect.objectContaining({
        kind: "reminder",
        title: "Dentist",
        schedule: "2026-11-20T09:30:00-08:00",
        delivery: { thread: "thread_7" },
      }),
    );
  });

  it("create: 'nowhere' sends no notification", () => {
    expect(automationWrite({ ...values, delivery: { type: "none" } }, ctx)).toMatchObject({
      method: "automations.create",
      params: { delivery: { none: true } },
    });
  });

  it("edit: automations.update with the automation's id, keeping its zone and channel target", async () => {
    const call = callMock();
    const automation = {
      id: "auto_recap",
      delivery: { channel: "chan_1", thread: "thread_old" },
    };
    await saveAutomation(
      asCall(call),
      {
        title: "Friday recap",
        prompt: "Summarise what I shipped this week.",
        schedule: { type: "weekly", days: [5], time: "18:00" },
        delivery: { type: "inbox" },
        enabled: false,
      },
      { zone: ZONE, now: NOW, editing: { kind: "cron" } },
      automation,
    );
    expect(call).toHaveBeenCalledWith("automations.update", {
      automationId: "auto_recap",
      title: "Friday recap",
      schedule: "0 18 * * 5",
      prompt: "Summarise what I shipped this week.",
      delivery: { channel: "chan_1" },
      enabled: false,
    });
  });

  it("refuses to save a form with errors instead of sending a bad schedule", async () => {
    const call = callMock();
    await expect(saveAutomation(asCall(call), { ...values, prompt: "" }, ctx)).rejects.toThrow(
      RangeError,
    );
    expect(call).not.toHaveBeenCalled();
  });
});

describe("delivery and starting values", () => {
  it("keeps a channel or webhook target the form does not show", () => {
    expect(toDelivery({ type: "inbox" }, { webhook: "https://example.test/hook" })).toEqual({
      webhook: "https://example.test/hook",
    });
    expect(toDelivery({ type: "none" }, { channel: "c" })).toEqual({ none: true });
  });

  it("starts an existing automation from its own values", () => {
    const values = initialValues(
      {
        id: "a",
        kind: "interval",
        title: "Check tracking",
        schedule: "PT3H",
        timezone: ZONE,
        prompt: "Check the parcels.",
        enabled: true,
        delivery: { thread: "t1" },
      } as never,
      undefined,
    );
    expect(values).toEqual({
      title: "Check tracking",
      prompt: "Check the parcels.",
      schedule: { type: "interval", hours: 3 },
      delivery: { type: "thread", threadId: "t1" },
      enabled: true,
    });
  });

  it("a new automation starts daily at 09:00, in the inbox, enabled", () => {
    expect(initialValues(undefined, "Example")).toEqual({
      title: "",
      prompt: "Example",
      schedule: { type: "daily", time: "09:00" },
      delivery: { type: "inbox" },
      enabled: true,
    });
  });
});
