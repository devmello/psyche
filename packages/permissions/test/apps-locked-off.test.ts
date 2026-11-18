import { FINANCIAL_APP_PREFIXES, venueOfApp } from "@psyche/protocol/financial-block";
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

/** #1321: the venue list of the hard block on trades and transfers and the locked-off list are one. */
describe("trading, banking and wallet apps are locked off with the hard block's own list", () => {
  it.each(FINANCIAL_APP_PREFIXES)("%s and anything under it is off", (prefix) => {
    expect(appCap(prefix).cap).toBe("off");
    expect(appCap(`${prefix}.macos`).cap).toBe("off");
    expect(venueOfApp(`${prefix}.macos`)).toBeDefined();
  });

  it.each([
    "com.robinhood.macos",
    "io.metamask.desktop",
    "com.ledger.live",
    "com.venmo.mac",
    "com.revolut.ios",
  ])("%s is off", (id) => {
    expect(effectiveTier(id, "interact")).toMatchObject({ tier: "off", capped: true });
  });

  it("an app that merely shares a word is not", () => {
    expect(appCap("com.apple.mail").cap).not.toBe("off");
    expect(appCap("com.chaseplanner.app").cap).not.toBe("off");
  });
});
