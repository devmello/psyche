import { describe, expect, it } from "vitest";
import {
  checkAudioChunk,
  checkCallable,
  checkHttpUrl,
  checkRoute,
  checkViewport,
} from "../src/lib/ipc.ts";

describe("IPC validators", () => {
  it("routes are single-origin app paths", () => {
    expect(checkRoute("c", "/chat/t1/pane/p_browser_1")).toBe("/chat/t1/pane/p_browser_1");
    for (const bad of ["//evil.com/x", "/a//b", "/../x", "chat", "https://evil.com", "/a b"])
      expect(() => checkRoute("c", bad), bad).toThrow();
  });

  it("URLs for agent tabs are http(s) without userinfo", () => {
    expect(checkHttpUrl("c", "https://acme.com/a")).toBe("https://acme.com/a");
    for (const bad of [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "https://u:p@acme.com",
      "acme.com",
    ])
      expect(() => checkHttpUrl("c", bad), bad).toThrow();
  });

  it("the renderer cannot call the handshake or node methods", () => {
    const known = (m: unknown) =>
      typeof m === "string" &&
      [
        "connect",
        "connect.verify",
        "node.invoke",
        "devices.bootstrapAdmin",
        "threads.list",
      ].includes(m);
    expect(checkCallable("threads.list", known)).toBe("threads.list");
    for (const m of [
      "connect",
      "connect.verify",
      "node.invoke",
      "devices.bootstrapAdmin",
      "made.up",
    ])
      expect(() => checkCallable(m, known)).toThrow();
  });

  it("only main calls dictation.* (it types into other apps); HUD audio is base64 only", () => {
    const known = (m: unknown) => typeof m === "string" && m.startsWith("dictation.");
    for (const m of ["dictation.insert", "dictation.watch", "dictation.target"])
      expect(() => checkCallable(m, known)).toThrow(/not callable/);
    expect(checkAudioChunk("AAEC/+8=")).toBe("AAEC/+8=");
    for (const bad of ["", "not base64!", "A".repeat(64_001), 42])
      expect(() => checkAudioChunk(bad)).toThrow();
  });

  it("viewports are finite, rounded rectangles or null", () => {
    expect(checkViewport(null)).toBeNull();
    expect(checkViewport({ x: 1.4, y: 2, width: 300.6, height: 200 })).toEqual({
      x: 1,
      y: 2,
      width: 301,
      height: 200,
    });
    expect(() => checkViewport({ x: Number.NaN, y: 0, width: 1, height: 1 })).toThrow();
  });
});
