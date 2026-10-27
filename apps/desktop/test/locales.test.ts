import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MESSAGE_LOCALES } from "../../../packages/ui/src/i18n/messages/locales/index.ts";
import { pruneLocales, SHIPPED_LOCALES } from "../src/packaging/locales.ts";

describe("pruneLocales", () => {
  it("ships Chromium strings for exactly the languages the UI has catalogues for", () => {
    expect([...SHIPPED_LOCALES].filter((l) => l !== "Base").sort()).toEqual(
      [...MESSAGE_LOCALES].sort(),
    );
  });

  it("keeps the shipped languages and their regions, drops the rest and the gender copies", () => {
    const contents = mkdtempSync(join(tmpdir(), "psyche-locales-"));
    const fw = join(contents, "Frameworks/Electron Framework.framework/Versions/A/Resources");
    const kept = ["en", "Base", "de", "pt_BR", "zh_TW", "en_GB"];
    const dropped = ["fi", "sv", "tr", "de_FEMININE", "pt_BR_NEUTER", "vi"];
    try {
      for (const dir of [join(contents, "Resources"), fw]) {
        for (const l of [...kept, ...dropped])
          mkdirSync(join(dir, `${l}.lproj`), { recursive: true });
      }
      mkdirSync(join(contents, "Resources", "psyched"), { recursive: true });
      expect(pruneLocales(contents)).toBe(dropped.length * 2);
      for (const dir of [join(contents, "Resources"), fw]) {
        for (const l of kept) expect(existsSync(join(dir, `${l}.lproj`)), l).toBe(true);
        for (const l of dropped) expect(existsSync(join(dir, `${l}.lproj`)), l).toBe(false);
      }
      expect(existsSync(join(contents, "Resources", "psyched"))).toBe(true);
    } finally {
      rmSync(contents, { recursive: true, force: true });
    }
  });
});
