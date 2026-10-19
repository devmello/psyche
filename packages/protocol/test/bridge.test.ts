import { describe, expect, it } from "vitest";
import {
  BRIDGE_MAX_FRAME_BYTES,
  BridgeEvents,
  BridgeMethods,
  type ErrorCode,
  PsycheError,
  parseFrame,
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

describe("browser bridge amendments (spike 01, S11)", () => {
  it("accepts popup metadata and task ids on tabs", () => {
    const tab = {
      tabId: "t2",
      url: "https://accounts.example.com/oauth",
      title: "Sign in",
      partition: "persist:agent-default",
      profile: "logged-in",
      attached: true,
      openerTabId: "t1",
      disposition: "new-window",
      taskId: "01JBXY6Q8Z0000000000000000",
    };
    expect(validateBridgeEventPayload("bridge.tab.created", { tab })).toBeTruthy();
    expect(
      validateBridgeParams("bridge.tab.open", {
        url: "https://acme.com",
        taskId: "01JBXY6Q8Z0000000000000000",
        taskTitle: "Dentist booking",
      }),
    ).toBeTruthy();
  });

  it("validates status pill and highlight requests", () => {
    expect(
      validateBridgeParams("bridge.tab.status", {
        tabId: "t1",
        text: "Typing in Preferred date",
        highlight: { x: 10, y: 20, width: 100, height: 24 },
      }),
    ).toBeTruthy();
    expect(validateBridgeParams("bridge.tab.status", { tabId: "t1", text: null })).toBeTruthy();
    expect(
      codeOf(() =>
        validateBridgeParams("bridge.tab.status", {
          tabId: "t1",
          text: null,
          highlight: { x: 0, y: 0, width: -1, height: 1 },
        }),
      ),
    ).toBe("invalid_params");
  });

  it("carries control source and debugger detach events", () => {
    expect(
      validateBridgeEventPayload("bridge.control.changed", {
        tabId: "t1",
        state: "user",
        via: "keyboard",
      }),
    ).toBeTruthy();
    expect(
      codeOf(() =>
        validateBridgeEventPayload("bridge.control.changed", {
          tabId: "t1",
          state: "user",
          via: "x",
        }),
      ),
    ).toBe("invalid_params");
    expect(
      validateBridgeEventPayload("bridge.debugger.detached", {
        tabId: "t1",
        reason: "target closed",
      }),
    ).toBeTruthy();
  });

  it("allows 16 MiB frames on the bridge only when asked", () => {
    const big = JSON.stringify({
      type: "res",
      id: "r1",
      ok: true,
      payload: { result: "x".repeat(2 * 1_048_576) },
    });
    expect(codeOf(() => parseFrame(big))).toBe("invalid_frame");
    expect(parseFrame(big, { maxBytes: BRIDGE_MAX_FRAME_BYTES }).type).toBe("res");
    expect(BRIDGE_MAX_FRAME_BYTES).toBe(16 * 1_048_576);
  });

  it("has the bridge error codes", () => {
    for (const code of [
      "user_in_control",
      "debugger_detached",
      "tab_not_found",
      "method_not_allowed",
    ]) {
      expect(new PsycheError(code as ErrorCode, "x").toPayload().code).toBe(code);
    }
  });
});
