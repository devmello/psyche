import { describe, expect, it } from "vitest";
import {
  isQuietAt,
  type QuietHoursConfig,
  quietHoursFromSettings,
  type RoutingConfig,
} from "../src/index.ts";
import { setup } from "./helpers.ts";

/** Settings → Notifications → Quiet hours (#953): the settings mapping and what it does. */

const LA = "America/Los_Angeles";
const reader =
  (values: Record<string, unknown>) =>
  (key: string): unknown =>
    values[key];

describe("quietHoursFromSettings", () => {
  it("is off until the owner turns it on", () => {
    expect(quietHoursFromSettings(reader({}), LA)).toBeNull();
    expect(
      quietHoursFromSettings(
        reader({
          "notifications.quietHours.enabled": false,
          "notifications.quietHours.start": "20:00",
        }),
        LA,
      ),
    ).toBeNull();
    // Only a real boolean counts.
    expect(
      quietHoursFromSettings(reader({ "notifications.quietHours.enabled": "true" }), LA),
    ).toBeNull();
  });

  it("defaults to 22:00 to 08:00 in the given zone", () => {
    expect(
      quietHoursFromSettings(reader({ "notifications.quietHours.enabled": true }), LA),
    ).toEqual({ start: "22:00", end: "08:00", timezone: LA });
  });

  it("reads the owner's start and end", () => {
    expect(
      quietHoursFromSettings(
        reader({
          "notifications.quietHours.enabled": true,
          "notifications.quietHours.start": "23:30",
          "notifications.quietHours.end": " 6:15 ",
        }),
        "UTC",
      ),
    ).toEqual({ start: "23:30", end: "06:15", timezone: "UTC" });
  });

  it("falls back to the default for a time it cannot read", () => {
    expect(
      quietHoursFromSettings(
        reader({
          "notifications.quietHours.enabled": true,
          "notifications.quietHours.start": "25:00",
          "notifications.quietHours.end": 8,
        }),
        LA,
      ),
    ).toEqual({ start: "22:00", end: "08:00", timezone: LA });
  });
});

describe("PsycheNotifier with the owner's quiet hours", () => {
  // 2026-10-19T06:00Z is 23:00 in Los Angeles (PDT); 2026-10-19T20:00Z is 13:00.
  const NIGHT = Date.UTC(2026, 9, 19, 6);
  const DAY = Date.UTC(2026, 9, 19, 20);
  const settings: Record<string, unknown> = { "notifications.quietHours.enabled": true };
  // A getter, like the Gateway's: it follows the setting's current value.
  const routing = (): RoutingConfig => ({
    quietHours: quietHoursFromSettings(reader(settings), LA),
  });

  it("isQuiet follows the window", () => {
    const qh = quietHoursFromSettings(reader(settings), LA) as QuietHoursConfig;
    expect(isQuietAt(qh, NIGHT)).toBe(true);
    expect(isQuietAt(qh, DAY)).toBe(false);
    expect(isQuietAt(qh, Date.UTC(2026, 9, 19, 14, 59))).toBe(true); // 07:59
    expect(isQuietAt(qh, Date.UTC(2026, 9, 19, 15))).toBe(false); // 08:00, exclusive end
  });

  it("holds an ordinary interruptive notification and keeps the inbox row", async () => {
    const { notifier, os, clock } = setup({ routing });
    clock.set(NIGHT);
    const n = await notifier.notify({ kind: "task_done", title: "Done", body: "" });
    expect(os.calls).toHaveLength(0);
    expect(n.delivered.desktop).toBeTypeOf("string");
    expect(notifier.nextDueAt()).toBe(Date.UTC(2026, 9, 19, 15)); // 08:00 local
    clock.set(Date.UTC(2026, 9, 19, 15));
    expect(await notifier.flushDue()).toBe(1);
    expect(os.calls).toHaveLength(1);
  });

  it("delivers an approval inside quiet hours", async () => {
    const { notifier, os, clock } = setup({ routing });
    clock.set(NIGHT);
    await notifier.notify({ kind: "approval", title: "Approve?", body: "", approvalId: "a1" });
    expect(os.calls).toHaveLength(1);
  });

  it("delivers a kind marked time-sensitive even when it is not a breakthrough kind", async () => {
    const timeSensitive = (): RoutingConfig => ({
      ...routing(),
      interruption: { task_failed: "timeSensitive" },
    });
    const { notifier, os, clock } = setup({ routing: timeSensitive });
    clock.set(NIGHT);
    await notifier.notify({ kind: "task_failed", title: "Failed", body: "" });
    await notifier.notify({ kind: "task_done", title: "Done", body: "" });
    expect(os.calls.map((c) => c.title)).toEqual(["Failed"]);
  });

  it("delivers everything outside the window", async () => {
    const { notifier, os, clock } = setup({ routing });
    clock.set(DAY);
    await notifier.notify({ kind: "task_done", title: "Done", body: "" });
    expect(os.calls).toHaveLength(1);
  });

  it("applies a setting changed after the notifier was built", async () => {
    const live: Record<string, unknown> = { "notifications.quietHours.enabled": false };
    const { notifier, os, clock } = setup({
      routing: () => ({ quietHours: quietHoursFromSettings(reader(live), LA) }),
    });
    clock.set(NIGHT);
    await notifier.notify({ kind: "task_done", title: "One", body: "" });
    expect(os.calls).toHaveLength(1);
    live["notifications.quietHours.enabled"] = true;
    await notifier.notify({ kind: "task_done", title: "Two", body: "" });
    expect(os.calls).toHaveLength(1);
  });
});
