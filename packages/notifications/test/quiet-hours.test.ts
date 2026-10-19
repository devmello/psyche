import { describe, expect, it } from "vitest";
import {
  breaksThrough,
  isQuietAt,
  type QuietHoursConfig,
  quietEndsAt,
  validateQuietHours,
} from "../src/index.ts";

const LA = "America/Los_Angeles";
const night: QuietHoursConfig = { start: "22:00", end: "07:00", timezone: LA };
const utc = (y: number, mo: number, d: number, h: number, mi = 0) => Date.UTC(y, mo - 1, d, h, mi);

describe("quiet hours", () => {
  it("crosses midnight in the configured zone", () => {
    // 2026-10-18 is PDT (UTC-7).
    expect(isQuietAt(night, utc(2026, 10, 18, 20))).toBe(false); // 13:00
    expect(isQuietAt(night, utc(2026, 10, 19, 5))).toBe(true); // 22:00, inclusive start
    expect(isQuietAt(night, utc(2026, 10, 19, 13, 59))).toBe(true); // 06:59
    expect(isQuietAt(night, utc(2026, 10, 19, 14))).toBe(false); // 07:00, exclusive end
  });

  it("ends at the next local end time", () => {
    expect(quietEndsAt(night, utc(2026, 10, 19, 6))).toBe(utc(2026, 10, 19, 14));
    expect(quietEndsAt(night, utc(2026, 10, 19, 6, 30) + 15_000)).toBe(utc(2026, 10, 19, 14));
    const notQuiet = utc(2026, 10, 18, 20);
    expect(quietEndsAt(night, notQuiet)).toBe(notQuiet);
  });

  it("supports same-day windows", () => {
    const lunch: QuietHoursConfig = { start: "12:00", end: "13:30", timezone: "UTC" };
    expect(isQuietAt(lunch, utc(2026, 10, 18, 12, 15))).toBe(true);
    expect(isQuietAt(lunch, utc(2026, 10, 18, 13, 30))).toBe(false);
    expect(quietEndsAt(lunch, utc(2026, 10, 18, 12, 15))).toBe(utc(2026, 10, 18, 13, 30));
  });

  it("assigns the morning part to the day the window started", () => {
    // Windows start only on Fridays (5). 2026-10-23 is a Friday.
    const fri: QuietHoursConfig = { ...night, timezone: "UTC", days: [5] };
    expect(isQuietAt(fri, utc(2026, 10, 23, 23))).toBe(true); // Fri 23:00
    expect(isQuietAt(fri, utc(2026, 10, 24, 1))).toBe(true); // Sat 01:00, Friday's window
    expect(isQuietAt(fri, utc(2026, 10, 24, 23))).toBe(false); // Sat 23:00
    expect(isQuietAt(fri, utc(2026, 10, 23, 1))).toBe(false); // Fri 01:00, Thursday's window
  });

  it("handles the autumn DST fall-back", () => {
    // 2026-11-01 02:00 PDT → 01:00 PST. 23:00 PDT on Oct 31 = 06:00Z; 07:00 PST = 15:00Z.
    expect(quietEndsAt(night, utc(2026, 11, 1, 6))).toBe(utc(2026, 11, 1, 15));
  });

  it("handles a spring-forward that skips the local end time", () => {
    // 2026-03-08 02:00 PST → 03:00 PDT; a 02:30 end never happens, so the window ends at 03:00.
    const cfg: QuietHoursConfig = { start: "23:00", end: "02:30", timezone: LA };
    expect(quietEndsAt(cfg, utc(2026, 3, 8, 7, 30))).toBe(utc(2026, 3, 8, 10));
  });

  it("chains all-day windows and never ends one that covers every day", () => {
    const weekend: QuietHoursConfig = {
      start: "00:00",
      end: "00:00",
      timezone: "UTC",
      days: [6, 0],
    };
    // Sat 2026-10-24 10:00 → Mon 00:00.
    expect(quietEndsAt(weekend, utc(2026, 10, 24, 10))).toBe(utc(2026, 10, 26, 0));
    const always: QuietHoursConfig = { start: "00:00", end: "00:00", timezone: "UTC" };
    expect(quietEndsAt(always, utc(2026, 10, 24, 10))).toBeUndefined();
  });

  it("lets approvals break through by default", () => {
    expect(breaksThrough(night, "approval")).toBe(true);
    expect(breaksThrough(night, "task_done")).toBe(false);
    expect(breaksThrough({ ...night, breakthrough: [] }, "approval")).toBe(false);
  });

  it("rejects bad configs eagerly", () => {
    expect(() => validateQuietHours({ ...night, start: "25:00" })).toThrow(/HH:MM/);
    expect(() => validateQuietHours({ ...night, timezone: "Mars/Olympus" })).toThrow(/timezone/);
    expect(() => validateQuietHours({ ...night, days: [7] })).toThrow(/0–6/);
    expect(() => validateQuietHours(night)).not.toThrow();
  });
});
