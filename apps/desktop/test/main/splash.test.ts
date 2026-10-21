import { describe, expect, it } from "vitest";
import { shouldShowSplash } from "../../src/main/splash.ts";

describe("when the main window opens on the splash (#539)", () => {
  it("skips in dev with PSYCHE_NO_SPLASH=1, in attach mode, for an external Gateway and the probe", () => {
    const show = (o: Partial<Parameters<typeof shouldShowSplash>[0]>) =>
      shouldShowSplash({ packaged: true, env: {}, mode: "launchd", healthyAtLaunch: false, ...o });
    expect(show({})).toBe(true);
    expect(show({ packaged: false, env: { PSYCHE_NO_SPLASH: "1" }, mode: "dev" })).toBe(false);
    // The variable is a dev switch: a packaged build ignores it.
    expect(show({ env: { PSYCHE_NO_SPLASH: "1" } })).toBe(true);
    expect(show({ healthyAtLaunch: true })).toBe(false);
    expect(show({ mode: "external" })).toBe(false);
    expect(show({ probing: true })).toBe(false);
  });
});
