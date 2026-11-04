import { FakeClock } from "@psyche/testing";
import { describe, expect, it } from "vitest";
import {
  createDeviceSurface,
  createNotifier,
  type DeviceToast,
  MemoryNotificationStore,
  parseChannelSurface,
  parseDeviceSurface,
  resolveSurfaces,
  surfaceClass,
} from "../src/index.ts";

/** The `device:<deviceId>` surface (remote Gateway design §4.2, R2): a remote client's own OS. */

const NIGHT = { start: "22:00", end: "07:00", timezone: "America/Los_Angeles" };

function setup(options: { quiet?: boolean; connected?: Set<string> } = {}) {
  const clock = new FakeClock();
  const sent: { deviceId: string; toast: DeviceToast }[] = [];
  const connected = options.connected ?? new Set(["dev_a"]);
  const notifier = createNotifier({
    clock,
    store: new MemoryNotificationStore(),
    delivery: "await",
    routing: () => ({
      ...(options.quiet ? { quietHours: NIGHT } : {}),
      deviceTargets: [...connected].map((id) => `device:${id}`),
    }),
    adapters: [
      createDeviceSurface({
        send: (deviceId, toast) => {
          if (!connected.has(deviceId)) return false;
          sent.push({ deviceId, toast });
          return true;
        },
      }),
    ],
  });
  return { clock, notifier, sent, connected };
}

describe("device surface names", () => {
  it("is its own class, never a chat channel", () => {
    expect(surfaceClass("device:dev_a")).toBe("device");
    expect(parseDeviceSurface("device:dev_a")).toBe("dev_a");
    expect(parseDeviceSurface("device:")).toBeUndefined();
    expect(parseDeviceSurface("telegram:12")).toBeUndefined();
    expect(parseChannelSurface("device:dev_a")).toBeUndefined();
  });

  it("is added next to the OS surface only", () => {
    const config = { deviceTargets: ["device:dev_a"] };
    expect(resolveSurfaces(config, "approval")).toContain("device:dev_a");
    // Proactive output stays in the app by default, so it stays off the client's OS too.
    expect(resolveSurfaces(config, "proactive")).not.toContain("device:dev_a");
    expect(resolveSurfaces(config, "proactive", ["desktop", "os"])).toContain("device:dev_a");
    expect(resolveSurfaces({}, "approval").some((s) => s.startsWith("device:"))).toBe(false);
  });
});

describe("device notifications", () => {
  it("send title, body and route, and no action buttons", async () => {
    const { notifier, sent } = setup();
    await notifier.notify({
      kind: "approval",
      title: "Buy a flight",
      body: "$412 on Delta",
      approvalId: "apr_1",
      route: "/agent/approvals",
      actions: [
        { id: "approve", label: "Approve", authenticationRequired: true },
        { id: "deny", label: "Deny", destructive: true },
      ],
    });
    expect(sent).toHaveLength(1);
    const toast = sent[0]?.toast as DeviceToast;
    expect(toast).toMatchObject({
      kind: "approval",
      title: "Buy a flight",
      body: "$412 on Delta",
      route: "/agent/approvals",
      interruption: "timeSensitive",
    });
    expect(Object.keys(toast).sort()).toEqual([
      "body",
      "createdAt",
      "id",
      "interruption",
      "kind",
      "route",
      "title",
    ]);
    expect(JSON.stringify(toast)).not.toMatch(/"actions"|"Approve"|"Deny"/);
  });

  it("defer a passive toast during quiet hours and deliver it after", async () => {
    const { notifier, sent, clock } = setup({ quiet: true });
    clock.set(Date.UTC(2026, 9, 19, 6)); // 23:00 local
    await notifier.notify({ kind: "reminder", title: "Stretch", body: "" });
    expect(sent).toHaveLength(0);
    clock.set(Date.UTC(2026, 9, 19, 14)); // 07:00 local
    await notifier.flushDue();
    expect(sent.map((s) => s.toast.title)).toEqual(["Stretch"]);
    expect(sent[0]?.toast.interruption).toBe("passive");
  });

  it("let a time-sensitive approval through during quiet hours", async () => {
    const { notifier, sent, clock } = setup({ quiet: true });
    clock.set(Date.UTC(2026, 9, 19, 6));
    await notifier.notify({ kind: "approval", title: "Buy", body: "", approvalId: "apr_1" });
    expect(sent).toHaveLength(1);
  });

  it("are not kept for a client that is gone when the deferral ends", async () => {
    const { notifier, sent, clock, connected } = setup({ quiet: true });
    clock.set(Date.UTC(2026, 9, 19, 6));
    const n = await notifier.notify({ kind: "reminder", title: "Stretch", body: "" });
    connected.delete("dev_a");
    clock.set(Date.UTC(2026, 9, 19, 14));
    await notifier.flushDue();
    expect(sent).toHaveLength(0);
    const record = (await notifier.deliveries(n.id)).find((d) => d.surface === "device:dev_a");
    expect(record).toMatchObject({ status: "suppressed", detail: "device not connected" });
  });

  it("go only to the clients connected when the notification is made", async () => {
    const { notifier, sent } = setup({ connected: new Set(["dev_a", "dev_b"]) });
    await notifier.notify({ kind: "task_done", title: "Done", body: "" });
    expect(sent.map((s) => s.deviceId).sort()).toEqual(["dev_a", "dev_b"]);
  });
});
