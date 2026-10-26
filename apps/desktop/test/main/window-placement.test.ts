import { describe, expect, it } from "vitest";
import { settingsWindowBounds, storedBounds } from "../../src/main/window-placement.ts";

const size = { width: 920, height: 640 };
const min = { width: 760, height: 520 };
const primary = { x: 0, y: 25, width: 1512, height: 920 };
const right = { x: 1512, y: 0, width: 2560, height: 1415 };

describe("Settings window placement (#596)", () => {
  it("centres on the main window the first time", () => {
    const main = { x: 100, y: 60, width: 1280, height: 860 };
    expect(
      settingsWindowBounds({ saved: undefined, main, workAreas: [primary], size, min }),
    ).toEqual({ x: 280, y: 170, width: 920, height: 640 });
  });

  it("centres on the primary screen when there is no main window", () => {
    expect(settingsWindowBounds({ saved: null, workAreas: [primary], size, min })).toEqual({
      x: 296,
      y: 165,
      width: 920,
      height: 640,
    });
  });

  it("stays inside the main window's screen", () => {
    const main = { x: 1300, y: 700, width: 900, height: 600 };
    const b = settingsWindowBounds({
      saved: undefined,
      main,
      workAreas: [primary, right],
      size,
      min,
    });
    expect(b.x).toBeGreaterThanOrEqual(right.x);
    const near = { x: -200, y: 30, width: 900, height: 600 };
    const c = settingsWindowBounds({
      saved: undefined,
      main: near,
      workAreas: [primary],
      size,
      min,
    });
    expect(c.x).toBe(0);
  });

  it("reopens where it was left while that is still on a screen", () => {
    const saved = { x: 1700, y: 200, width: 1000, height: 700 };
    expect(settingsWindowBounds({ saved, workAreas: [primary, right], size, min })).toEqual(saved);
    // That display is gone: back to centred.
    const b = settingsWindowBounds({ saved, workAreas: [primary], size, min });
    expect(b).toEqual({ x: 296, y: 165, width: 920, height: 640 });
  });

  it("ignores malformed or too-small stored bounds", () => {
    expect(storedBounds({ x: 1, y: 2, width: 800, height: "600" }, min)).toBeNull();
    expect(storedBounds({ x: 1, y: 2, width: 500, height: 600 }, min)).toBeNull();
    expect(storedBounds("nope", min)).toBeNull();
    expect(storedBounds({ x: 1.4, y: 2, width: 800, height: 600 }, min)).toEqual({
      x: 1,
      y: 2,
      width: 800,
      height: 600,
    });
  });
});
