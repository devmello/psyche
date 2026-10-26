import { describe, expect, it } from "vitest";
import { classifyLink, linkOpenMode, resolveLinkAction } from "../src/links/link-policy.ts";

describe("link scheme allowlist", () => {
  it("accepts http, https and mailto", () => {
    expect(classifyLink("https://example.com/a?b=1")?.host).toBe("example.com");
    expect(classifyLink("http://example.com")?.scheme).toBe("http:");
    expect(classifyLink("mailto:Ann@Example.com")).toMatchObject({
      scheme: "mailto:",
      host: "example.com",
    });
  });

  it("refuses file:, javascript:, data:, custom schemes, credentials and junk", () => {
    for (const bad of [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "data:text/html,hi",
      "psyche://open",
      "message://x",
      "https://bank.com@evil.test/",
      "mailto:nobody",
      "",
      "not a url",
    ])
      expect(classifyLink(bad), bad).toBeNull();
  });

  it("flags punycode lookalike hosts", () => {
    expect(classifyLink("https://аpple.com/")?.punycode).toBe(true);
    expect(classifyLink("https://apple.com/")?.punycode).toBe(false);
  });
});

describe("resolveLinkAction", () => {
  const web = classifyLink("https://example.com/");
  const mail = classifyLink("mailto:a@example.com");
  it("defaults to the menu and honours the setting", () => {
    expect(linkOpenMode(undefined)).toBe("ask");
    expect(linkOpenMode("bogus")).toBe("ask");
    expect(resolveLinkAction(web, "ask", false)).toBe("menu");
    expect(resolveLinkAction(web, "psyche", false)).toBe("psyche");
    expect(resolveLinkAction(web, "browser", false)).toBe("browser");
  });
  it("sends ⌘-click and mail links to the default browser, and blocks refused links", () => {
    expect(resolveLinkAction(web, "psyche", true)).toBe("browser");
    expect(resolveLinkAction(mail, "ask", false)).toBe("browser");
    expect(resolveLinkAction(null, "browser", true)).toBe("blocked");
  });
});
