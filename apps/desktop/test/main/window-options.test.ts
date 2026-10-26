import { describe, expect, it } from "vitest";
import {
  CANVAS_COLOR,
  canvasColor,
  MAIN_WINDOW_SIZE,
  mainWindowOptions,
  SETTINGS_WINDOW_SIZE,
  settingsWindowOptions,
  wantsAnyWindowSize,
} from "../../src/main/window-options.ts";
import { settingsRoute } from "../../src/main/windows.ts";

describe("the main window's size (#561)", () => {
  it("opens hidden at the app size with the hidden title bar, whatever the splash does", () => {
    const o = mainWindowOptions();
    expect({ width: o.width, height: o.height }).toEqual(MAIN_WINDOW_SIZE);
    expect(o).toMatchObject({
      minWidth: 900,
      minHeight: 600,
      title: "Psyche",
      show: false,
      titleBarStyle: "hidden",
      trafficLightPosition: { x: 20, y: 19 },
      visualEffectState: "followWindow",
      backgroundColor: CANVAS_COLOR.light,
    });
    expect(o).not.toHaveProperty("enableLargerThanScreen");
  });

  it("may be sized past the screen only for the unpackaged layout e2e", () => {
    expect(mainWindowOptions({ anySize: true }).enableLargerThanScreen).toBe(true);
    expect(wantsAnyWindowSize(false, { PSYCHE_E2E_ANY_WINDOW_SIZE: "1" })).toBe(true);
    expect(wantsAnyWindowSize(true, { PSYCHE_E2E_ANY_WINDOW_SIZE: "1" })).toBe(false);
    expect(wantsAnyWindowSize(false, {})).toBe(false);
  });
});

describe("window chrome (docs/design/redesign-2026.md §4)", () => {
  it("paints the canvas colour of the system appearance before the renderer loads", () => {
    expect(mainWindowOptions({ dark: true }).backgroundColor).toBe(CANVAS_COLOR.dark);
    expect(canvasColor(false)).toBe(CANVAS_COLOR.light);
  });

  it("gives Settings its own window with the same chrome", () => {
    const o = settingsWindowOptions({ dark: true });
    expect({ width: o.width, height: o.height }).toEqual({ width: 920, height: 640 });
    expect(SETTINGS_WINDOW_SIZE).toEqual({ width: 920, height: 640 });
    expect(o).toMatchObject({
      minWidth: 760,
      minHeight: 520,
      title: "Settings",
      show: false,
      titleBarStyle: "hidden",
      trafficLightPosition: { x: 20, y: 19 },
      backgroundColor: CANVAS_COLOR.dark,
    });
  });

  it("routes the Settings window to a slug section, never anything else", () => {
    expect(settingsRoute("computer-use")).toBe("/window/settings/computer-use");
    expect(settingsRoute(undefined)).toBe("/window/settings/model");
    expect(settingsRoute("../chat")).toBe("/window/settings/model");
    expect(settingsRoute("model?x=1")).toBe("/window/settings/model");
  });
});
