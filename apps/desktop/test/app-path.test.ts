import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { contentType, resolveAppPath } from "../src/lib/app-path.ts";

const root = resolve("/opt/Psyche/renderer");

describe("app:// paths", () => {
  it("serves files under the root and index.html for routes", () => {
    expect(resolveAppPath(root, "app://psyche/assets/index-abc.js")).toBe(
      join(root, "assets/index-abc.js"),
    );
    expect(resolveAppPath(root, "app://psyche/")).toBe(join(root, "index.html"));
    expect(resolveAppPath(root, "app://psyche/chat/t1/pane/p1")).toBe(join(root, "index.html"));
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
