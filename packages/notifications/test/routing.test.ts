import type { NotificationKind } from "@psyche/protocol";
import { describe, expect, it } from "vitest";
import {
  interruptionFor,
  isInterruptive,
  NOTIFICATION_KINDS,
  normalizeSurface,
  planDelivery,
  type RoutingConfig,
  resolveSurfaces,
  surfaceClass,
} from "../src/index.ts";
import { RecordingAdapter, setup } from "./helpers.ts";

/** The routing matrix (UI §3.20): which kinds reach the OS by default. */
const MATRIX: Record<NotificationKind, { os: boolean; interruption: string }> = {
  approval: { os: true, interruption: "timeSensitive" },
  input_needed: { os: true, interruption: "active" },
  task_done: { os: true, interruption: "active" },
  task_failed: { os: true, interruption: "active" },
  proactive: { os: false, interruption: "passive" },
  briefing: { os: false, interruption: "passive" },
  reminder: { os: true, interruption: "passive" },
  system: { os: false, interruption: "passive" },
  specialist_result: { os: true, interruption: "active" },
  promise_due: { os: true, interruption: "active" },
};

const config: RoutingConfig = {};
// 2026-10-19T06:00Z is 23:00 in Los Angeles: inside 22:00–07:00.
const QUIET_NOW = Date.UTC(2026, 9, 19, 6);
const quietConfig: RoutingConfig = {
  ...config,
  quietHours: { start: "22:00", end: "07:00", timezone: "America/Los_Angeles" },
};

describe("routing matrix", () => {
  for (const kind of NOTIFICATION_KINDS) {
    const row = MATRIX[kind];
    it(`${kind}: default surfaces`, () => {
      const expected = ["desktop", "offMac"];
      if (row.os) expected.push("notification");
      expect(resolveSurfaces(config, kind)).toEqual(expected);
    });

    it(`${kind}: OS interruption level is ${row.interruption}`, () => {
      expect(interruptionFor(config, kind)).toBe(row.interruption);
    });

    it(`${kind}: outside quiet hours external surfaces deliver now`, () => {
      const plan = planDelivery(
        quietConfig,
        kind,
        resolveSurfaces(config, kind),
        Date.UTC(2026, 9, 18, 20),
      );
      for (const p of plan) {
        expect(p.action).toBe(p.surface === "desktop" || p.surface === "offMac" ? "in_app" : "now");
      }
    });

    it(`${kind}: inside quiet hours only breakthrough kinds interrupt`, () => {
      const plan = planDelivery(quietConfig, kind, resolveSurfaces(config, kind), QUIET_NOW);
      for (const p of plan) {
        if (p.surface === "desktop" || p.surface === "offMac") expect(p.action).toBe("in_app");
        else if (kind === "approval") expect(p.action).toBe("now");
        else
          expect(p).toEqual({
            surface: p.surface,
            action: "defer",
            until: Date.UTC(2026, 9, 19, 14),
          });
      }
    });

    it(`${kind}: end-to-end through the notifier`, async () => {
      const { notifier, os, device } = setup({ routing: config });
      const n = await notifier.notify({ kind, title: kind, body: "…" });
      expect(os.calls.length).toBe(row.os ? 1 : 0);
      expect(device.calls.length).toBe(0);
      expect(Object.keys(n.delivered).sort()).toEqual(resolveSurfaces(config, kind).sort());
    });
  }

  it("explicit surfaces replace the defaults, normalized and de-duplicated", () => {
    expect(
      resolveSurfaces(config, "proactive", ["os", "notification", "desktop", " offMac "]),
    ).toEqual(["notification", "desktop", "offMac"]);
  });

  it("a stored legacy web still routes, as offMac (in-app, never an unknown surface)", () => {
    expect(normalizeSurface("web")).toBe("offMac");
    expect(surfaceClass("web")).toBe("offMac");
    expect(resolveSurfaces(config, "proactive", ["desktop", "web"])).toEqual(["desktop", "offMac"]);
    // Settings stored before the rename name it too.
    const stored: RoutingConfig = { surfaces: { briefing: ["desktop", "web", "notification"] } };
    expect(resolveSurfaces(stored, "briefing")).toEqual(["desktop", "offMac", "notification"]);
    expect(planDelivery(config, "briefing", ["web"], Date.UTC(2026, 9, 18, 20))).toEqual([
      { surface: "web", action: "in_app" },
    ]);
    // Control: a removed chat channel is still dropped.
    expect(resolveSurfaces(config, "briefing", ["desktop", "telegram:1"])).toEqual(["desktop"]);
  });

  it("per-kind overrides come from settings", () => {
    const custom: RoutingConfig = { surfaces: { briefing: ["desktop", "notification"] } };
    expect(resolveSurfaces(custom, "briefing")).toEqual(["desktop", "notification"]);
    expect(resolveSurfaces(custom, "task_done")).toEqual(["desktop", "offMac", "notification"]);
  });

  it("parses surfaces", () => {
    expect(normalizeSurface("os")).toBe("notification");
    expect(surfaceClass("notification")).toBe("notification");
    expect(surfaceClass("device:dev_a")).toBe("device");
  });
});

/** Chat channels were removed (2026-11-25): an old `telegram:42` must never reach the OS or a device. */
describe("old chat channel surfaces", () => {
  const OLD = ["telegram:42", "whatsapp:+1:555", "slack:U1", "imessage:+15550100", "oldchat:1"];

  it.each(OLD)("%s is an unknown, non-interruptive class", (surface) => {
    expect(surfaceClass(surface)).toBe("unknown");
    expect(isInterruptive(surface)).toBe(false);
  });

  it("is dropped from explicit surfaces and from stored per-kind settings", () => {
    expect(resolveSurfaces({}, "approval", ["telegram:42", "desktop"])).toEqual(["desktop"]);
    expect(resolveSurfaces({}, "approval", ["telegram:42"])).toEqual([]);
    const stored: RoutingConfig = { surfaces: { task_done: ["desktop", ...OLD] } };
    expect(resolveSurfaces(stored, "task_done")).toEqual(["desktop"]);
  });

  it("with device targets connected, never fans out to them", () => {
    const withDevice: RoutingConfig = { deviceTargets: ["device:dev_a"] };
    expect(resolveSurfaces(withDevice, "proactive", ["telegram:42", "desktop"])).toEqual([
      "desktop",
    ]);
  });

  it("an old pending delivery is suppressed, even with an adapter that matches anything", async () => {
    const any = new RecordingAdapter("any", () => true);
    const { notifier, store } = setup({ routing: config, adapters: [any] });
    const n = await notifier.notify({ kind: "proactive", title: "Old", body: "" });
    store.upsertDelivery({
      notificationId: n.id,
      surface: "telegram:42",
      status: "pending",
      attempts: 0,
      dueAt: new Date(0).toISOString(),
      deliveredAt: null,
      detail: null,
    });
    await notifier.flushDue();
    const old = (await notifier.deliveries(n.id)).find((d) => d.surface === "telegram:42");
    expect(old).toMatchObject({ status: "suppressed", dueAt: null });
    expect(any.calls).toEqual([]);
  });
});

describe("breakQuietHours", () => {
  it("delivers one notification through quiet hours; the kind's default is unchanged", () => {
    const surfaces = resolveSurfaces(config, "reminder");
    const held = planDelivery(quietConfig, "reminder", surfaces, QUIET_NOW);
    const through = planDelivery(quietConfig, "reminder", surfaces, QUIET_NOW, {
      breakQuietHours: true,
    });
    expect(held.some((p) => p.action === "defer")).toBe(true);
    expect(through.some((p) => p.action === "defer")).toBe(false);
  });
});
