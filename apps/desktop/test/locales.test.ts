import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pruneLocales } from "../src/packaging/locales.ts";

describe("pruneLocales", () => {
  it("keeps only English (and Base) in the app's and Electron Framework's Resources", () => {
    const contents = mkdtempSync(join(tmpdir(), "psyche-locales-"));
    const fw = join(contents, "Frameworks/Electron Framework.framework/Versions/A/Resources");
    try {
      for (const dir of [join(contents, "Resources"), fw]) {
        for (const l of ["en", "en_GB", "de", "zh_TW", "Base"]) {
          mkdirSync(join(dir, `${l}.lproj`), { recursive: true });
        }
      }
      mkdirSync(join(contents, "Resources", "psyched"), { recursive: true });
      expect(pruneLocales(contents)).toBe(6);
      for (const dir of [join(contents, "Resources"), fw]) {
        expect(existsSync(join(dir, "en.lproj"))).toBe(true);
        expect(existsSync(join(dir, "Base.lproj"))).toBe(true);
        expect(existsSync(join(dir, "en_GB.lproj"))).toBe(false);
        expect(existsSync(join(dir, "de.lproj"))).toBe(false);
      }
      expect(existsSync(join(contents, "Resources", "psyched"))).toBe(true);
    } finally {
      rmSync(contents, { recursive: true, force: true });
    }
  });
});
