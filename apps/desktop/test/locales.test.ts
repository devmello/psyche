import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MESSAGE_LOCALES } from "../../../packages/ui/src/i18n/messages/locales/index.ts";
import { pruneLocales, pruneWin32Locales, SHIPPED_LOCALES } from "../src/packaging/locales.ts";

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

describe("pruneWin32Locales", () => {
  it("keeps en-US and the shipped languages with their regions, drops the other .pak files", () => {
    const root = mkdtempSync(join(tmpdir(), "psyche-win-locales-"));
    const dir = join(root, "locales");
    mkdirSync(dir);
    const kept = ["en-US", "en-GB", "de", "pt-BR", "zh-TW", "es-419"];
    const dropped = ["fi", "sv", "tr", "vi", "nb"];
    try {
      for (const l of [...kept, ...dropped]) writeFileSync(join(dir, `${l}.pak`), "pak");
      expect(pruneWin32Locales(root)).toBe(dropped.length);
      expect(readdirSync(dir).sort()).toEqual(kept.map((l) => `${l}.pak`).sort());
      expect(pruneWin32Locales(join(root, "nowhere"))).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
