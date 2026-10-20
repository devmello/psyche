import { clampZoom, ZOOM_KEY, zoomStep } from "@psyche/web/compose";
import { describe, expect, it } from "vitest";
import { ZoomController, type ZoomTarget } from "../src/lib/zoom.ts";

function target(): ZoomTarget & { factors: number[]; destroyed: boolean } {
  const t = {
    factors: [] as number[],
    destroyed: false,
    setZoomFactor(f: number) {
      t.factors.push(f);
    },
    isDestroyed: () => t.destroyed,
  };
  return t;
}

function controller(settings: Record<string, unknown> = {}, failSet = false) {
  const targets = [target(), target()];
  const calls: { method: string; params: unknown }[] = [];
  const zoom = new ZoomController({
    targets: () => targets,
    call: async (method, params) => {
      calls.push({ method, params });
      if (method === "settings.get") return { settings, stateVersion: 1 };
      if (failSet) throw new Error("unpaired");
      return {
        entry: { key: ZOOM_KEY, value: (params as { value: number }).value },
        stateVersion: 2,
      };
    },
  });
  return { zoom, targets, calls };
}

describe("zoom ladder", () => {
  it("clamps stored values to 67–200 and defaults to 100", () => {
    expect(clampZoom(undefined)).toBe(100);
    expect(clampZoom("big")).toBe(100);
    expect(clampZoom(10)).toBe(67);
    expect(clampZoom(500)).toBe(200);
    expect(clampZoom(124.6)).toBe(125);
  });

  it("steps along Chrome's presets from any value", () => {
    expect(zoomStep(100, 1)).toBe(110);
    expect(zoomStep(100, -1)).toBe(90);
    expect(zoomStep(105, 1)).toBe(110);
    expect(zoomStep(105, -1)).toBe(100);
    expect(zoomStep(200, 1)).toBe(200);
    expect(zoomStep(67, -1)).toBe(67);
  });
});

describe("ZoomController", () => {
  it("applies the stored setting to every renderer on load, the default when unset", async () => {
    const { zoom, targets } = controller({ [ZOOM_KEY]: 150 });
    await zoom.load();
    expect(zoom.percent).toBe(150);
    expect(targets.map((t) => t.factors)).toEqual([[1.5], [1.5]]);
    const fresh = controller();
    await fresh.zoom.load();
    expect(fresh.targets[0]?.factors).toEqual([1]);
  });

  it("View → Zoom In persists the next step and a newly loaded renderer gets it", async () => {
    const { zoom, targets, calls } = controller();
    await zoom.zoomIn();
    expect(calls.at(-1)).toEqual({
      method: "settings.set",
      params: { key: ZOOM_KEY, value: 110 },
    });
    const late = target();
    zoom.applyTo(late);
    expect(late.factors).toEqual([1.1]);
    const second = targets[1];
    if (second) second.destroyed = true;
    await zoom.reset();
    expect(targets[1]?.factors).toEqual([1.1]); // destroyed renderers are skipped
    expect(targets[0]?.factors.at(-1)).toBe(1);
  });

  it("keeps the zoom for the session when the Gateway cannot store it", async () => {
    const { zoom, targets } = controller({}, true);
    await zoom.zoomOut();
    expect(zoom.percent).toBe(90);
    expect(targets[0]?.factors).toEqual([0.9]);
  });

  it("follows settings.changed from any device", () => {
    const { zoom, targets } = controller();
    zoom.onSettingsChanged([
      { key: "appearance.theme", value: "dark" },
      { key: ZOOM_KEY, value: 125 },
    ]);
    expect(zoom.percent).toBe(125);
    expect(targets[0]?.factors).toEqual([1.25]);
  });
});
