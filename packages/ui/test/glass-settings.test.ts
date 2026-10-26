import { describe, expect, it } from "vitest";
import {
  GLASS_BLUR_SETTING,
  GLASS_PRESET_SETTING,
  GLASS_REFRACTION_SETTING,
  GLASS_TINT_SETTING,
  glassCssVariables,
  glassIsPreset,
  glassPreset,
  glassValues,
} from "../src/lib/glass-settings.ts";

describe("Translucency settings (#597)", () => {
  it("defaults to Regular, whose variables reproduce styles/design.css", () => {
    expect(glassPreset({})).toBe("regular");
    expect(glassCssVariables(glassValues({}))).toEqual({
      "--glass-tint": "72%",
      "--glass-tint-refraction": "50%",
      "--glass-tint-clear": "14.4%",
      "--glass-blur": "20px",
      "--glass-blur-refraction": "10px",
      "--glass-blur-clear": "4px",
      "--glass-refraction": "1",
    });
  });

  it("takes the preset's values, overridden by Advanced ones, clamped to the limits", () => {
    expect(glassValues({ [GLASS_PRESET_SETTING]: "clear" })).toEqual({
      tint: 38,
      blur: 10,
      refraction: 130,
    });
    expect(
      glassValues({
        [GLASS_PRESET_SETTING]: "clear",
        [GLASS_TINT_SETTING]: 200,
        [GLASS_BLUR_SETTING]: -4,
        [GLASS_REFRACTION_SETTING]: "a lot",
      }),
    ).toEqual({ tint: 95, blur: 0, refraction: 130 });
  });

  it("treats unknown presets as Regular and Opaque as Regular's values", () => {
    expect(glassPreset({ [GLASS_PRESET_SETTING]: "frosted" })).toBe("regular");
    expect(glassValues({ [GLASS_PRESET_SETTING]: "opaque" }).tint).toBe(72);
  });

  it("knows when the owner changed nothing from the preset", () => {
    expect(glassIsPreset({ [GLASS_PRESET_SETTING]: "clear" })).toBe(true);
    expect(glassIsPreset({ [GLASS_BLUR_SETTING]: 12 })).toBe(false);
  });
});
