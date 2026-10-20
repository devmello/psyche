import { describe, expect, it } from "vitest";
import { appCap, effectiveTier } from "../src/index.ts";

/** #269: Psyche's approval banners and system authorization agents are Off, like the helper's caps. */
describe("locked-off apps (#269)", () => {
  it.each([
    "com.apple.notificationcenterui",
    "com.apple.UserNotificationCenter",
    "com.apple.SecurityAgent",
    "com.apple.LocalAuthentication.UIAgent",
    "com.apple.loginwindow",
    "com.psyche.desktop",
    "com.psyche.helper",
  ])("%s is off and cannot be raised", (id) => {
    expect(appCap(id).cap).toBe("off");
    expect(effectiveTier(id, "interact")).toMatchObject({ tier: "off", capped: true });
  });
});
