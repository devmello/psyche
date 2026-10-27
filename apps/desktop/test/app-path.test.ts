import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { contentType, PANEL_ROUTES, resolveAppPath } from "../src/lib/app-path.ts";
import { HUD_ROUTE } from "../src/main/dictation/hud.ts";
import { SCREEN_ASK_REGION_ROUTE, SCREEN_ASK_ROUTE } from "../src/main/screen-ask/panel.ts";

const root = resolve("/opt/Psyche/renderer");

describe("app:// paths", () => {
  it("serves files under the root and index.html for routes", () => {
    expect(resolveAppPath(root, "app://psyche/assets/index-abc.js")).toBe(
      join(root, "assets/index-abc.js"),
    );
    expect(resolveAppPath(root, "app://psyche/")).toBe(join(root, "index.html"));
    expect(resolveAppPath(root, "app://psyche/chat/t1/pane/p1")).toBe(join(root, "index.html"));
  });

  it("serves panel.html for the small windows' routes", () => {
    expect([...PANEL_ROUTES].sort()).toEqual(
      [SCREEN_ASK_ROUTE, SCREEN_ASK_REGION_ROUTE, HUD_ROUTE].sort(),
    );
    for (const route of PANEL_ROUTES) {
      expect(resolveAppPath(root, `app://psyche${route}`)).toBe(join(root, "panel.html"));
    }
    expect(resolveAppPath(root, "app://psyche/screen-ask/x")).toBe(join(root, "index.html"));
  });

  it("refuses traversal, other hosts and schemes", () => {
    expect(resolveAppPath(root, "app://psyche/..%2F..%2Fetc%2Fpasswd.txt")).toBeNull();
    // The URL parser already folds %2e%2e segments, so this stays inside the root.
    expect(resolveAppPath(root, "app://psyche/%2e%2e/secret.js")).toBe(join(root, "secret.js"));
    expect(resolveAppPath(root, "app://evil/index.html")).toBeNull();
    expect(resolveAppPath(root, "file:///etc/passwd")).toBeNull();
    expect(resolveAppPath(root, "app://psyche/a%00.js")).toBeNull();
  });

  it("knows content types", () => {
    expect(contentType("x/index.html")).toMatch(/^text\/html/);
    expect(contentType("a.WASM")).toBe("application/wasm");
    expect(contentType("a.bin")).toBe("application/octet-stream");
  });
});

describe("isSameApp", () => {
  it("accepts only the renderer's scheme and host", async () => {
    const { isSameApp } = await import("../src/lib/app-path.ts");
    const app = "app://psyche/";
    expect(isSameApp("app://psyche/chat/t1", app)).toBe(true);
    for (const bad of [
      "file:///Users/x/evil.html",
      "data:text/html,<script>1</script>",
      "about:blank",
      "javascript:alert(1)",
      "psyche://chat",
      "app://evil/index.html",
      "app://user@psyche/",
      undefined,
    ])
      expect(isSameApp(bad, app), String(bad)).toBe(false);
    const dev = "http://localhost:5173/";
    expect(isSameApp("http://localhost:5173/chat", dev)).toBe(true);
    expect(isSameApp("http://localhost:5174/chat", dev)).toBe(false);
    expect(isSameApp("https://localhost:5173/chat", dev)).toBe(false);
  });
});
