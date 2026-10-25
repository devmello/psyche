import { describe, expect, it, vi } from "vitest";
import { VIBRANCY_KEY, VibrancyController, type VibrancyTarget } from "../src/lib/vibrancy.ts";

function target() {
  const t = {
    win: { setVibrancy: vi.fn(), setBackgroundColor: vi.fn(), isDestroyed: () => false },
    view: { setBackgroundColor: vi.fn() },
  } satisfies VibrancyTarget;
  return t;
}

function controller(supported = true, call = vi.fn()) {
  const targets = [target()];
  const c = new VibrancyController({
    targets: () => targets,
    call,
    canvas: () => "#fcfcfe",
    supported,
  });
  return { c, t: targets[0] as ReturnType<typeof target>, call };
}

describe("sidebar vibrancy (docs/design/redesign-2026.md §3.4, §4)", () => {
  it("is off by default: the window and view paint the opaque canvas", () => {
    const { c, t } = controller();
    c.refresh();
    expect(c.on).toBe(false);
    expect(t.win.setVibrancy).toHaveBeenCalledWith(null);
    expect(t.view.setBackgroundColor).toHaveBeenCalledWith("#fcfcfe");
  });

  it("turns the sidebar material on with a transparent view when the setting is on", async () => {
    const call = vi.fn().mockResolvedValue({ settings: { [VIBRANCY_KEY]: true } });
    const { c, t } = controller(true, call);
    await c.load();
    expect(call).toHaveBeenCalledWith("settings.get", { keys: [VIBRANCY_KEY] });
    expect(t.win.setVibrancy).toHaveBeenLastCalledWith("sidebar");
    expect(t.view.setBackgroundColor).toHaveBeenLastCalledWith("#00000000");
    c.onSettingsChanged([{ key: VIBRANCY_KEY, value: false }]);
    expect(t.win.setVibrancy).toHaveBeenLastCalledWith(null);
    expect(t.view.setBackgroundColor).toHaveBeenLastCalledWith("#fcfcfe");
  });

  it("ignores the setting where the platform has no material", () => {
    const { c, t } = controller(false);
    c.apply(true);
    expect(c.on).toBe(false);
    expect(t.win.setVibrancy).not.toHaveBeenCalled();
    expect(t.view.setBackgroundColor).toHaveBeenCalledWith("#fcfcfe");
  });

  it("ignores unrelated settings and keeps the canvas when unpaired", async () => {
    const call = vi.fn().mockRejectedValue(new Error("unpaired"));
    const { c, t } = controller(true, call);
    await c.load();
    c.onSettingsChanged([{ key: "appearance.zoom", value: 110 }]);
    expect(t.win.setVibrancy).not.toHaveBeenCalledWith("sidebar");
  });
});
