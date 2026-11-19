import { describe, expect, it } from "vitest";
import {
  APPLE_CALENDAR_MAX_SPAN_MS,
  APPLE_LIMIT_MAX,
  clampAppleParams,
} from "../../src/apple/connector.ts";

describe("clampAppleParams", () => {
  it("clamps a limit above the helper's 500 and below 1", () => {
    expect(clampAppleParams("calendar.list_events", { limit: 2000 })).toEqual({
      limit: APPLE_LIMIT_MAX,
    });
    expect(clampAppleParams("reminders.list", { limit: 0 })).toEqual({ limit: 1 });
    expect(clampAppleParams("reminders.list", { limit: 37.9 })).toEqual({ limit: 37 });
  });

  it("leaves a valid limit and parameters without one untouched", () => {
    const p = { limit: 250, completed: false };
    expect(clampAppleParams("reminders.list", p)).toBe(p);
    expect(clampAppleParams("notes.list", { folder: "x" })).toEqual({ folder: "x" });
  });

  it("caps a calendar window at 366 days from its start", () => {
    const from = "2026-01-01T00:00:00.000Z";
    const to = "2028-01-01T00:00:00.000Z";
    const out = clampAppleParams("calendar.list_events", { from, to });
    expect(Date.parse(out.to as string) - Date.parse(from)).toBe(APPLE_CALENDAR_MAX_SPAN_MS);
    expect(out.from).toBe(from);
  });

  it("keeps a window already inside the limit", () => {
    const p = { from: "2026-01-01T00:00:00.000Z", to: "2026-02-01T00:00:00.000Z" };
    expect(clampAppleParams("calendar.list_events", p)).toBe(p);
  });

  it("leaves a window that ends before it starts for the helper to refuse", () => {
    const p = { from: "2026-02-01T00:00:00.000Z", to: "2026-01-01T00:00:00.000Z" };
    expect(clampAppleParams("calendar.list_events", p)).toBe(p);
  });

  it("does not change the range of other capabilities", () => {
    const p = { from: "2020-01-01T00:00:00.000Z", to: "2030-01-01T00:00:00.000Z" };
    expect(clampAppleParams("calendar.free_busy", p)).toBe(p);
  });
});
