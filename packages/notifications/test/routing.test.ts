import type { NotificationKind } from "@psyche/protocol";
import { describe, expect, it } from "vitest";
import {
  interruptionFor,
  NOTIFICATION_KINDS,
  normalizeSurface,
  parseChannelSurface,
  planDelivery,
  type RoutingConfig,
  resolveSurfaces,
} from "../src/index.ts";
import { setup } from "./helpers.ts";

/** The routing matrix (UI §3.20): which kinds reach the OS and the owner's chat by default. */
const MATRIX: Record<NotificationKind, { os: boolean; chat: boolean; interruption: string }> = {
  approval: { os: true, chat: true, interruption: "timeSensitive" },
  input_needed: { os: true, chat: true, interruption: "active" },
  task_done: { os: true, chat: true, interruption: "active" },
  task_failed: { os: true, chat: true, interruption: "active" },
  proactive: { os: false, chat: false, interruption: "passive" },
  briefing: { os: false, chat: false, interruption: "passive" },
  reminder: { os: true, chat: true, interruption: "passive" },
  system: { os: false, chat: false, interruption: "passive" },
  specialist_result: { os: true, chat: true, interruption: "active" },
};

const config: RoutingConfig = { channelTargets: ["telegram:42"] };
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
      const expected = ["desktop", "web"];
      if (row.os) expected.push("notification");
      if (row.chat) expected.push("telegram:42");
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
        expect(p.action).toBe(p.surface === "desktop" || p.surface === "web" ? "in_app" : "now");
      }
    });

    it(`${kind}: inside quiet hours only breakthrough kinds interrupt`, () => {
      const plan = planDelivery(quietConfig, kind, resolveSurfaces(config, kind), QUIET_NOW);
      for (const p of plan) {
        if (p.surface === "desktop" || p.surface === "web") expect(p.action).toBe("in_app");
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
      const { notifier, os, chat } = setup({ routing: config });
      const n = await notifier.notify({ kind, title: kind, body: "…" });
      expect(os.calls.length).toBe(row.os ? 1 : 0);
      expect(chat.calls.length).toBe(row.chat ? 1 : 0);
      expect(Object.keys(n.delivered).sort()).toEqual(resolveSurfaces(config, kind).sort());
    });
  }

  it("explicit surfaces replace the defaults, normalized and de-duplicated", () => {
    expect(
      resolveSurfaces(config, "proactive", ["os", "notification", "desktop", " web "]),
    ).toEqual(["notification", "desktop", "web"]);
  });

  it("per-kind overrides and channel kinds come from settings", () => {
    const custom: RoutingConfig = {
      surfaces: { briefing: ["desktop", "notification"] },
      channelTargets: ["slack:U1"],
      channelKinds: ["briefing"],
    };
    expect(resolveSurfaces(custom, "briefing")).toEqual(["desktop", "notification", "slack:U1"]);
    expect(resolveSurfaces(custom, "task_done")).toEqual(["desktop", "web", "notification"]);
  });

  it("parses surfaces", () => {
    expect(normalizeSurface("os")).toBe("notification");
    expect(parseChannelSurface("telegram:42")).toEqual({ channel: "telegram", peerId: "42" });
    expect(parseChannelSurface("whatsapp:+1:555")).toEqual({
      channel: "whatsapp",
      peerId: "+1:555",
    });
    expect(parseChannelSurface("desktop")).toBeUndefined();
    expect(parseChannelSurface("telegram:")).toBeUndefined();
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
