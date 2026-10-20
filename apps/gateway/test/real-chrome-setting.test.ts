import { describe, expect, it } from "vitest";
import { realChromeFromSetting } from "../src/compose/browser.ts";

describe("browser.realChrome setting (I13)", () => {
  it("is off unless enabled is true, and keeps only valid profile names", () => {
    expect(realChromeFromSetting(undefined)).toEqual({ enabled: false });
    expect(realChromeFromSetting("yes")).toEqual({ enabled: false });
    expect(realChromeFromSetting({ enabled: "true" })).toEqual({ enabled: false });
    expect(realChromeFromSetting({ enabled: true })).toEqual({ enabled: true });
    expect(realChromeFromSetting({ enabled: true, profile: "work" })).toEqual({
      enabled: true,
      profile: "work",
    });
    expect(realChromeFromSetting({ enabled: true, profile: "../Default" })).toEqual({
      enabled: true,
    });
  });
});
