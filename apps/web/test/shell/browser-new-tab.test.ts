import { describe, expect, it, vi } from "vitest";
import { normalizeTabUrl, openNewTab } from "../../src/shell/components/browser-new-tab.ts";

describe("normalizeTabUrl", () => {
  it("assumes https when no scheme is typed", () => {
    expect(normalizeTabUrl("example.com")).toBe("https://example.com/");
    expect(normalizeTabUrl("  example.com/a?b=1 ")).toBe("https://example.com/a?b=1");
  });
  it("keeps http and https as typed", () => {
    expect(normalizeTabUrl("http://localhost:3000")).toBe("http://localhost:3000/");
  });
  it("refuses empty input and other schemes", () => {
    expect(normalizeTabUrl("   ")).toBeNull();
    expect(normalizeTabUrl("file:///etc/passwd")).toBeNull();
    expect(normalizeTabUrl("javascript://x")).toBeNull();
  });
});

describe("openNewTab", () => {
  it("opens the address in a new tab and activates it", async () => {
    const openTab = vi.fn(async () => "tab-7");
    const activateTab = vi.fn(async () => {});
    const r = await openNewTab({ openTab, activateTab }, "example.com");
    expect(r).toEqual({ ok: true, tabId: "tab-7" });
    expect(openTab).toHaveBeenCalledWith("https://example.com/");
    expect(activateTab).toHaveBeenCalledWith("tab-7");
  });
  it("does not call the host for an address it would refuse", async () => {
    const openTab = vi.fn(async () => "x");
    const activateTab = vi.fn(async () => {});
    expect(await openNewTab({ openTab, activateTab }, "ftp://x")).toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(openTab).not.toHaveBeenCalled();
  });
  it("reports a host failure", async () => {
    const openTab = vi.fn(async () => {
      throw new Error("nope");
    });
    expect(await openNewTab({ openTab, activateTab: vi.fn() }, "example.com")).toEqual({
      ok: false,
      reason: "failed",
    });
  });
});
