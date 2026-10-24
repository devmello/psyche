import { describe, expect, it } from "vitest";
import {
  MAIN_WINDOW_SIZE,
  mainWindowOptions,
  wantsAnyWindowSize,
} from "../../src/main/window-options.ts";

describe("the main window's size (#561)", () => {
  it("opens hidden at the app size with the inset title bar, whatever the splash does", () => {
    const o = mainWindowOptions();
    expect({ width: o.width, height: o.height }).toEqual(MAIN_WINDOW_SIZE);
    expect(o).toMatchObject({
      minWidth: 900,
      minHeight: 600,
      title: "Psyche",
      show: false,
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 18, y: 19 },
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
