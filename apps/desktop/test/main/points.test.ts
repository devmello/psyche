import type { PointsWindow } from "@psyche/protocol";
import type { MenuItemConstructorOptions } from "electron";
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { name: "Psyche", isPackaged: true, quit: () => {} },
  Menu: { buildFromTemplate: (t: MenuItemConstructorOptions[]) => t },
  nativeImage: { createEmpty: () => ({}) },
  Tray: class {},
}));

const { POINTS_SETTING_KEY, PointsSetting } = await import("../../src/main/points/setting.ts");
const { targetBehind } = await import("../../src/main/points/target-behind.ts");
const { POINTS_TRAY_LABEL, trayTemplate } = await import("../../src/main/tray.ts");

/**
 * Psyche points on the desktop (docs/design/psyche-points-2026.md §6.2): the menu-bar row, the
 * "hide Psyche, then target the window behind" step, and the `points.enabled` switch behind both.
 */

const win = (over: Partial<PointsWindow> & Pick<PointsWindow, "ref">): PointsWindow => ({
  app: { bundleId: "com.apple.Safari", name: "Safari" },
  title: "Tax return",
  frontmost: false,
  ...over,
});

describe("targetBehind", () => {
  it("hides Psyche first, waits, and only then asks which window is in front", async () => {
    const order: string[] = [];
    const ref = await targetBehind({
      hide: () => order.push("hide"),
      sleep: async (ms) => {
        order.push(`sleep ${ms}`);
      },
      windows: async () => {
        order.push("windows");
        return { windows: [win({ ref: "w9" }), win({ ref: "w1", frontmost: true })] };
      },
    });
    expect(order).toEqual(["hide", "sleep 250", "windows"]);
    expect(ref).toBe("w1");
  });

  it("never targets a window the helper refuses, even in front", async () => {
    const ref = await targetBehind({
      hide: () => {},
      sleep: async () => {},
      windows: async () => ({
        windows: [
          win({ ref: "t1", frontmost: true, refusal: "terminal_or_ide" }),
          win({ ref: "w2" }),
        ],
      }),
    });
    expect(ref).toBeUndefined();
  });

  it("answers nothing, and still hid Psyche, when the helper can't say", async () => {
    const hide = vi.fn();
    const ref = await targetBehind({
      hide,
      sleep: async () => {},
      windows: async () => {
        throw new Error("helper offline");
      },
    });
    expect(hide).toHaveBeenCalledOnce();
    expect(ref).toBeUndefined();
  });
});

describe("the menu-bar row", () => {
  const noop = () => {};
  const model = {
    status: { phase: "paired" } as never,
    run: { kind: "running", mode: "launchd" } as const,
    pendingApprovals: 0,
    usagePercentRemaining: null,
  };
  const actions = {
    open: noop,
    newSideChat: noop,
    quickEntry: noop,
    askScreen: noop,
    openApprovals: noop,
    closeWindow: noop,
    quitApp: noop,
    quitEntirely: noop,
  };
  const labels = (items: MenuItemConstructorOptions[]) => items.map((i) => i.label);

  it("sits beside Ask about screen when Points is on", () => {
    const pointsStart = vi.fn();
    const items = trayTemplate({ ...model, pointsEnabled: true }, { ...actions, pointsStart });
    const all = labels(items);
    expect(all).toContain(POINTS_TRAY_LABEL);
    expect(all.indexOf(POINTS_TRAY_LABEL)).toBe(all.indexOf("Ask about screen") + 1);
    items.find((i) => i.label === POINTS_TRAY_LABEL)?.click?.({} as never, undefined, {} as never);
    expect(pointsStart).toHaveBeenCalledOnce();
  });

  it("is absent while the setting is off, and where the desktop offers no action", () => {
    const pointsStart = vi.fn();
    expect(labels(trayTemplate(model, { ...actions, pointsStart }))).not.toContain(
      POINTS_TRAY_LABEL,
    );
    expect(
      labels(trayTemplate({ ...model, pointsEnabled: false }, { ...actions, pointsStart })),
    ).not.toContain(POINTS_TRAY_LABEL);
    expect(labels(trayTemplate({ ...model, pointsEnabled: true }, actions))).not.toContain(
      POINTS_TRAY_LABEL,
    );
  });
});

describe("the points.enabled setting", () => {
  const make = (values: Record<string, unknown>, disabled = false) => {
    const changes: boolean[] = [];
    const call = vi.fn(async () => ({ settings: values }));
    const s = new PointsSetting({ call, onChange: (on) => changes.push(on), disabled });
    return { s, changes, call };
  };

  it("is off until the owner turns it on", async () => {
    const { s, changes } = make({});
    await s.load();
    expect(s.enabled).toBe(false);
    expect(changes).toEqual([]);
  });

  it("follows the setting, on load and on settings.changed", async () => {
    const values: Record<string, unknown> = { [POINTS_SETTING_KEY]: true };
    const { s, changes } = make(values);
    await s.load();
    expect(s.enabled).toBe(true);
    values[POINTS_SETTING_KEY] = false;
    s.onEvent("settings.changed", { entries: [{ key: POINTS_SETTING_KEY }] });
    await vi.waitFor(() => expect(s.enabled).toBe(false));
    expect(changes).toEqual([true, false]);
  });

  it("ignores other settings and other events", async () => {
    const { s, call } = make({ [POINTS_SETTING_KEY]: true });
    s.onEvent("settings.changed", { entries: [{ key: "screenAsk.enabled" }] });
    s.onEvent("device.updated", { entries: [{ key: POINTS_SETTING_KEY }] });
    expect(call).not.toHaveBeenCalled();
  });

  it("stays off for a client of another computer's Gateway, and reads nothing", async () => {
    const { s, call } = make({ [POINTS_SETTING_KEY]: true }, true);
    await s.load();
    s.onEvent("settings.changed", { entries: [{ key: POINTS_SETTING_KEY }] });
    expect(s.enabled).toBe(false);
    expect(call).not.toHaveBeenCalled();
  });

  it("falls back to off when the Gateway can't be read", async () => {
    const s = new PointsSetting({
      call: async () => {
        throw new Error("down");
      },
      onChange: () => {},
    });
    await s.load();
    expect(s.enabled).toBe(false);
  });
});
