import { describe, expect, it } from "vitest";
import { findFreeSlots, zonedTime } from "../../src/index.ts";

/** #639: the free-time finder over busy blocks, in the owner's time zone. */

const LA = "America/Los_Angeles";

describe("findFreeSlots", () => {
  it("finds free stretches inside working hours around busy blocks, earliest first", () => {
    // Monday 2026-10-26 in Los Angeles (PDT, UTC-7): busy 10:00–11:00 and 13:00–16:30.
    const busy = [
      { start: "2026-10-26T17:00:00Z", end: "2026-10-26T18:00:00Z" },
      { start: "2026-10-26T20:00:00Z", end: "2026-10-26T23:30:00Z" },
    ];
    const slots = findFreeSlots(busy, {
      from: "2026-10-26T07:00:00Z",
      to: "2026-10-27T07:00:00Z",
      durationMinutes: 60,
      timeZone: LA,
    });
    expect(slots).toEqual([
      // 09:00–10:00 local, then 11:00–13:00 local; 16:30–17:00 is too short.
      { start: "2026-10-26T16:00:00.000Z", end: "2026-10-26T17:00:00.000Z", freeMinutes: 60 },
      { start: "2026-10-26T18:00:00.000Z", end: "2026-10-26T19:00:00.000Z", freeMinutes: 120 },
    ]);
  });

  it("skips weekends by default, honours buffers, custom hours and the limit", () => {
    // Saturday and Sunday are skipped; Monday 09:00 local is the first slot.
    const slots = findFreeSlots([], {
      from: "2026-10-24T07:00:00Z",
      to: "2026-10-27T07:00:00Z",
      durationMinutes: 30,
      timeZone: LA,
      limit: 1,
    });
    expect(slots).toEqual([
      { start: "2026-10-26T16:00:00.000Z", end: "2026-10-26T16:30:00.000Z", freeMinutes: 480 },
    ]);
    const buffered = findFreeSlots(
      [{ start: "2026-10-26T16:00:00Z", end: "2026-10-26T17:00:00Z" }],
      {
        from: "2026-10-26T07:00:00Z",
        to: "2026-10-27T07:00:00Z",
        durationMinutes: 30,
        bufferMinutes: 15,
        workStart: "09:00",
        workEnd: "12:00",
        timeZone: LA,
      },
    );
    // Busy 09:00–10:00 plus 15 minutes: free from 10:15 to 12:00.
    expect(buffered[0]).toEqual({
      start: "2026-10-26T17:15:00.000Z",
      end: "2026-10-26T17:45:00.000Z",
      freeMinutes: 105,
    });
  });

  it("is right across a DST change and refuses bad input", () => {
    // Monday 2026-11-02 is after the switch to PST (UTC-8): 09:00 local is 17:00Z.
    expect(new Date(zonedTime(2026, 11, 2, 9 * 60, LA)).toISOString()).toBe(
      "2026-11-02T17:00:00.000Z",
    );
    expect(new Date(zonedTime(2026, 10, 30, 9 * 60, LA)).toISOString()).toBe(
      "2026-10-30T16:00:00.000Z",
    );
    const base = { from: "2026-10-26T07:00:00Z", to: "2026-10-27T07:00:00Z", timeZone: LA };
    expect(() => findFreeSlots([], { ...base, durationMinutes: 2 })).toThrow(/durationMinutes/);
    expect(() => findFreeSlots([], { ...base, durationMinutes: 30, workStart: "9am" })).toThrow(
      /HH:MM/,
    );
    expect(() =>
      findFreeSlots([], { ...base, to: "2027-06-01T00:00:00Z", durationMinutes: 30 }),
    ).toThrow(/at most 62 days/);
  });
});
