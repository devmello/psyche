import { describe, expect, it } from "vitest";
import { deepLinkFromArgv, isAppRoute, parseDeepLink } from "../src/lib/deep-link.ts";

describe("psyche:// deep links", () => {
  it("maps links to app routes", () => {
    expect(parseDeepLink("psyche://chat")).toBe("/chat");
    expect(parseDeepLink("psyche://chat/01JBX")).toBe("/chat/01JBX");
    expect(parseDeepLink("psyche://chat/t1/pane/p_browser_1")).toBe("/chat/t1/pane/p_browser_1");
    expect(parseDeepLink("psyche://agent/approvals")).toBe("/agent/approvals");
    expect(parseDeepLink("psyche://settings/permissions/")).toBe("/settings/permissions");
    expect(parseDeepLink("psyche://search?q=dentist%20tuesday")).toBe(
      "/search?q=dentist%20tuesday",
    );
  });

  it("never accepts a Gateway address, token or answer", () => {
    for (const bad of [
      "psyche://chat?gatewayUrl=ws://evil.example:7979",
      "psyche://chat?token=abc",
      "psyche://agent/approvals?approve=ap_1",
      "psyche://search?q=x&gatewayUrl=ws://e",
      "psyche://user:pw@chat",
      "psyche://chat:7979",
      "psyche://chat#frag",
      "psyche://chat/../settings/permissions",
      "psyche://approve/ap_1",
      "https://chat",
      "psyche://chat/<script>",
      `psyche://search?q=${"x".repeat(600)}`,
      "not a url",
    ]) {
      expect(parseDeepLink(bad), bad).toBeNull();
    }
  });

  it("finds the link in a second instance's argv", () => {
    expect(deepLinkFromArgv(["/Applications/Psyche.app", "--flag", "psyche://feed"])).toBe("/feed");
    expect(deepLinkFromArgv(["/Applications/Psyche.app"])).toBeNull();
  });

  it("accepts a notification's durable links, and nothing looser", () => {
    for (const ok of [
      "/chat/th_1?message=m_1",
      "/chat/th_1?approval=ap_1",
      "/overview/run/run_1",
      "/scheduled?tab=runs",
    ])
      expect(isAppRoute(ok), ok).toBe(true);
    for (const bad of [
      "/chat/th_1?message=",
      "/chat/th_1?other=x",
      "/scheduled?tab=x",
      "/overview/run",
    ])
      expect(isAppRoute(bad), bad).toBe(false);
  });
});
