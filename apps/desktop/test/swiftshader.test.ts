import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pruneSwiftShader } from "../src/packaging/swiftshader.ts";

describe("pruneSwiftShader", () => {
  it("removes SwiftShader from Electron Framework and keeps the other libraries", () => {
    const contents = mkdtempSync(join(tmpdir(), "psyche-swiftshader-"));
    const libs = join(contents, "Frameworks/Electron Framework.framework/Versions/A/Libraries");
    try {
      mkdirSync(libs, { recursive: true });
      for (const f of ["libvk_swiftshader.dylib", "vk_swiftshader_icd.json", "libffmpeg.dylib"])
        writeFileSync(join(libs, f), "x");
      expect(pruneSwiftShader(contents)).toBe(2);
      expect(existsSync(join(libs, "libvk_swiftshader.dylib"))).toBe(false);
      expect(existsSync(join(libs, "vk_swiftshader_icd.json"))).toBe(false);
      expect(existsSync(join(libs, "libffmpeg.dylib"))).toBe(true);
      expect(pruneSwiftShader(contents)).toBe(0);
    } finally {
      rmSync(contents, { recursive: true, force: true });
    }
  });
});
