import { describe, expect, it } from "vitest";
import {
  checkAudioChunk,
  checkCallable,
  checkClipboardText,
  checkComposerText,
  checkExternalUrl,
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

  it("clipboard writes take one non-empty string up to 64 KiB (#507)", () => {
    expect(checkClipboardText({ text: "ABCD-EFGH" })).toBe("ABCD-EFGH");
    for (const bad of [null, "x", {}, { text: "" }, { text: 3 }, { text: "a".repeat(65_537) }])
      expect(() => checkClipboardText(bad), JSON.stringify(bad)?.slice(0, 40)).toThrow();
  });

  it("open-external takes https pages only (#505)", () => {
    expect(checkExternalUrl({ url: "https://accounts.google.com/o/oauth2/v2/auth?x=1" })).toContain(
      "https://accounts.google.com/",
    );
    for (const bad of [
      { url: "http://accounts.google.com/" },
      { url: "javascript:alert(1)" },
      { url: "file:///etc/passwd" },
      { url: "https://u:p@evil.com" },
      { url: "" },
      null,
    ])
      expect(() => checkExternalUrl(bad), JSON.stringify(bad)).toThrow();
  });
});

describe("composer text from another window (#677)", () => {
  it("is a non-empty string of at most 4,000 characters", () => {
    expect(checkComposerText({ text: "Summarise my unread mail" })).toBe(
      "Summarise my unread mail",
    );
    for (const bad of [null, "text", {}, { text: "" }, { text: 42 }, { text: "x".repeat(4_001) }])
      expect(() => checkComposerText(bad), JSON.stringify(bad)?.slice(0, 40)).toThrow();
  });
});
