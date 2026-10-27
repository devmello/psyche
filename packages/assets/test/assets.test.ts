import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assetDir, assetPath, assetsRoot, entryUrl } from "../src/index.ts";

const repo = resolve(import.meta.dirname, "../../..");

afterEach(() => {
  vi.unstubAllEnvs();
  globalThis.__PSYCHE_BUNDLE_URL__ = undefined;
});

describe("assetsRoot", () => {
  it("is the repository root from source, where the assets live", () => {
    expect(assetsRoot()).toBe(repo);
    for (const p of [
      "packages/db/migrations",
      "packages/connectors/migrations",
      "packages/notifications/migrations",
      "templates",
      "skills",
      "deploy/sandbox-image",
      "packages/model-router/src/cli/mcp-stdio-bridge.mjs",
    ]) {
      expect(existsSync(assetPath(p)), p).toBe(true);
    }
  });

  it("is three directories above a bundle entry (<root>/apps/gateway/dist/main.mjs)", () => {
    const root = mkdtempSync(join(tmpdir(), "psyche-assets-"));
    try {
      globalThis.__PSYCHE_BUNDLE_URL__ = pathToFileURL(
        join(root, "apps/gateway/dist/main.mjs"),
      ).href;
      expect(assetsRoot()).toBe(resolve(root));
      expect(assetPath("skills")).toBe(join(resolve(root), "skills"));
      globalThis.__PSYCHE_BUNDLE_URL__ = pathToFileURL(join(root, "apps/cli/dist/main.mjs")).href;
      expect(assetsRoot()).toBe(resolve(root));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("lets PSYCHE_ASSETS_ROOT win over the bundle and the source tree", () => {
    globalThis.__PSYCHE_BUNDLE_URL__ = "file:///somewhere/apps/gateway/dist/main.mjs";
    vi.stubEnv("PSYCHE_ASSETS_ROOT", "/custom/root");
    expect(assetsRoot()).toBe(resolve("/custom/root"));
    expect(assetPath("templates")).toBe(join(resolve("/custom/root"), "templates"));
  });

  it("ignores an empty PSYCHE_ASSETS_ROOT", () => {
    vi.stubEnv("PSYCHE_ASSETS_ROOT", "");
    expect(assetsRoot()).toBe(repo);
  });
});

describe("assetPath", () => {
  it("joins segments and path-style arguments the same way", () => {
    expect(assetPath("packages", "db", "migrations")).toBe(assetPath("packages/db/migrations"));
  });

  it("refuses to leave the root", () => {
    expect(() => assetPath("..", "etc")).toThrow(/escapes/);
    expect(() => assetPath("skills/../../x")).toThrow(/escapes/);
    expect(() => assetPath("/etc/passwd")).toThrow(/escapes/);
  });

  it("assetDir keeps the trailing separator", () => {
    expect(assetDir("templates")).toBe(`${assetPath("templates")}${sep}`);
  });
});

describe("entryUrl", () => {
  const source = new URL("file:///repo/packages/files/src/extract/worker.ts");

  it("is the source URL when running from source", () => {
    expect(entryUrl(source, "extract-worker.mjs")).toBe(source);
  });

  it("is the named entry next to the bundle when bundled", () => {
    globalThis.__PSYCHE_BUNDLE_URL__ = "file:///app/apps/gateway/dist/main.mjs";
    expect(entryUrl(source, "extract-worker.mjs").href).toBe(
      "file:///app/apps/gateway/dist/extract-worker.mjs",
    );
  });
});
