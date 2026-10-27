import { openDb, setSetting } from "@psyche/db";
import { PsycheNotifier } from "@psyche/notifications";
import { FakeClock } from "@psyche/testing";
import { describe, expect, it } from "vitest";
import { isOwnerQuietAt, notifierRouting, ownerQuietHours } from "../src/compose/quiet-hours.ts";

/** Settings → Notifications → Quiet hours (#953) as the Gateway reads them. */

const LA = () => "America/Los_Angeles";
// 2026-10-19T06:00Z is 23:00 in Los Angeles (PDT); 20:00Z is 13:00.
const NIGHT = Date.UTC(2026, 9, 19, 6);
const DAY = Date.UTC(2026, 9, 19, 20);

describe("owner quiet hours", () => {
  it("is off by default", () => {
    const db = openDb(":memory:");
    expect(ownerQuietHours(db, LA)).toBeNull();
    expect(isOwnerQuietAt(db, NIGHT, LA)).toBe(false);
    expect(notifierRouting(db, LA)()).toEqual({ quietHours: null });
  });

  it("maps the settings, defaulting to 22:00 to 08:00", () => {
    const db = openDb(":memory:");
    setSetting(db, "notifications.quietHours.enabled", true);
    expect(ownerQuietHours(db, LA)).toEqual({
      start: "22:00",
      end: "08:00",
      timezone: "America/Los_Angeles",
    });
    setSetting(db, "notifications.quietHours.start", "21:00");
    setSetting(db, "notifications.quietHours.end", "07:30");
    expect(ownerQuietHours(db, LA)).toMatchObject({ start: "21:00", end: "07:30" });
  });

  it("isQuiet (meeting prep) is true inside the window and false outside", () => {
    const db = openDb(":memory:");
    setSetting(db, "notifications.quietHours.enabled", true);
    expect(isOwnerQuietAt(db, NIGHT, LA)).toBe(true);
    expect(isOwnerQuietAt(db, DAY, LA)).toBe(false);
    setSetting(db, "notifications.quietHours.enabled", false);
    expect(isOwnerQuietAt(db, NIGHT, LA)).toBe(false);
  });

  it("the notifier follows the setting without a restart", async () => {
    const db = openDb(":memory:");
    const clock = new FakeClock();
    clock.set(NIGHT);
    const delivered: string[] = [];
    const notifier = new PsycheNotifier({
      clock,
      delivery: "await",
      routing: notifierRouting(db, LA),
      adapters: [
        {
          name: "os",
          handles: (s) => s === "notification",
          deliver: async (n) => {
            delivered.push(n.title);
            return { status: "delivered" };
          },
        },
      ],
    });
    await notifier.notify({ kind: "task_done", title: "off", body: "" });
    setSetting(db, "notifications.quietHours.enabled", true);
    await notifier.notify({ kind: "task_done", title: "held", body: "" });
    await notifier.notify({ kind: "approval", title: "approval", body: "", approvalId: "a1" });
    expect(delivered).toEqual(["off", "approval"]);
    clock.set(Date.UTC(2026, 9, 19, 15)); // 08:00 local
    await notifier.flushDue();
    expect(delivered).toEqual(["off", "approval", "held"]);
  });
});
