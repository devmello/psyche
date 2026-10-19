import { describe, expect, it } from "vitest";
import {
  BridgeEvents,
  BridgeMethods,
  type ErrorCode,
  PsycheError,
  validateBridgeEventPayload,
  validateBridgeParams,
} from "../src/index.ts";

function codeOf(fn: () => unknown): ErrorCode | undefined {
  try {
    fn();
  } catch (err) {
    if (err instanceof PsycheError) return err.code;
    throw err;
  }
  return undefined;
}

describe("browser bridge registry", () => {
  it("prefixes every method and event with bridge.", () => {
    for (const name of [...Object.keys(BridgeMethods), ...Object.keys(BridgeEvents)]) {
      expect(name.startsWith("bridge."), name).toBe(true);
    }
    expect(Object.keys(BridgeMethods)).toEqual(
      expect.arrayContaining([
        "bridge.hello",
        "bridge.tabs.list",
        "bridge.tab.open",
        "bridge.tab.close",
        "bridge.attach",
        "bridge.detach",
        "bridge.cdp.send",
      ]),
    );
    expect(Object.keys(BridgeEvents)).toEqual(
      expect.arrayContaining([
        "bridge.cdp.event",
        "bridge.tab.created",
        "bridge.tab.updated",
        "bridge.tab.closed",
        "bridge.control.changed",
        "bridge.download",
      ]),
    );
  });

  it("validates CDP forwarding", () => {
    expect(
      validateBridgeParams("bridge.cdp.send", {
        tabId: "tab_1",
        method: "Accessibility.getFullAXTree",
        params: { depth: 4 },
      }),
    ).toBeTruthy();
    expect(
      codeOf(() =>
        validateBridgeParams("bridge.cdp.send", { tabId: "tab_1", method: "not a method" }),
      ),
    ).toBe("invalid_params");
    expect(codeOf(() => validateBridgeParams("bridge.cdp.send", { method: "Page.navigate" }))).toBe(
      "invalid_params",
    );
    expect(
      validateBridgeEventPayload("bridge.cdp.event", {
        tabId: "tab_1",
        method: "Page.loadEventFired",
        params: {},
      }),
    ).toBeTruthy();
  });

  it("opens only http(s) tabs", () => {
    expect(
      validateBridgeParams("bridge.tab.open", { url: "https://example.com", profile: "clean" }),
    ).toBeTruthy();
    for (const url of [
      "file:///etc/passwd",
      "chrome://settings",
      "about:blank",
      "javascript:alert(1)",
    ]) {
      expect(
        codeOf(() => validateBridgeParams("bridge.tab.open", { url })),
        url,
      ).toBe("invalid_params");
    }
  });

  it("validates take-control and tab lifecycle events", () => {
    expect(
      validateBridgeEventPayload("bridge.control.changed", { tabId: "t", state: "user" }),
    ).toBeTruthy();
    expect(
      codeOf(() =>
        validateBridgeEventPayload("bridge.control.changed", { tabId: "t", state: "robot" }),
      ),
    ).toBe("invalid_params");
    const tab = {
      tabId: "t",
      url: "https://example.com",
      title: "Example",
      partition: "persist:psyche",
      profile: "logged-in",
      attached: false,
    };
    expect(validateBridgeEventPayload("bridge.tab.created", { tab })).toBeTruthy();
    expect(validateBridgeEventPayload("bridge.tab.closed", { tabId: "t" })).toBeTruthy();
    expect(
      validateBridgeEventPayload("bridge.download", {
        tabId: "t",
        downloadId: "d1",
        url: "https://example.com/a.pdf",
        filename: "a.pdf",
        mime: "application/pdf",
        state: "completed",
        bytes: 1024,
        quarantinePath: "/tmp/q/a.pdf",
        at: "2026-10-18T20:11:05Z",
      }),
    ).toBeTruthy();
  });

  it("requires the handshake secret in bridge.hello and rejects unknown names", () => {
    expect(
      codeOf(() =>
        validateBridgeParams("bridge.hello", { protocolVersion: 1, desktopVersion: "0.1.0" }),
      ),
    ).toBe("invalid_params");
    expect(codeOf(() => validateBridgeParams("bridge.eval", {}))).toBe("unknown_method");
    expect(codeOf(() => validateBridgeEventPayload("bridge.nope", {}))).toBe("invalid_params");
  });
});
