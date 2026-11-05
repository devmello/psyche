import { describe, expect, it } from "vitest";
import {
  fillText,
  LINUX_UNINSTALL_TEXT,
  linuxUninstallText,
} from "../../src/platform/linux-text.ts";

const LANGS = ["ar", "de", "es", "fr", "hi", "it", "ja", "ko", "pt", "zh"];
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
const en = LINUX_UNINSTALL_TEXT.en as unknown as Record<string, string>;

describe("Linux uninstall text", () => {
  it("has English and all ten languages", () => {
    expect(Object.keys(LINUX_UNINSTALL_TEXT).sort()).toEqual(["en", ...LANGS].sort());
  });

  for (const lang of LANGS) {
    it(`${lang}: same keys and placeholders as English, nothing left in English`, () => {
      const t = LINUX_UNINSTALL_TEXT[lang] as unknown as Record<string, string>;
      expect(Object.keys(t).sort()).toEqual(Object.keys(en).sort());
      for (const key of Object.keys(en)) {
        expect(typeof t[key]).toBe("string");
        expect((t[key] as string).trim(), `${lang}.${key}`).not.toBe("");
        expect(placeholders(t[key] as string), `${lang}.${key} placeholders`).toEqual(
          placeholders(en[key] as string),
        );
        // A command or a path may stay the same, but a sentence must be translated.
        if ((en[key] as string).split(" ").length > 3 && !(en[key] as string).includes("{")) {
          expect(t[key], `${lang}.${key} is still English`).not.toBe(en[key]);
        }
      }
    });
  }

  it("picks the language from the OS locale and falls back to English", () => {
    expect(linuxUninstallText("de_DE.UTF-8")).toBe(LINUX_UNINSTALL_TEXT.de);
    expect(linuxUninstallText("pt-BR")).toBe(LINUX_UNINSTALL_TEXT.pt);
    expect(linuxUninstallText("sv-SE")).toBe(LINUX_UNINSTALL_TEXT.en);
  });

  it("fills placeholders and leaves unknown ones as written", () => {
    expect(fillText("{count} of {x}", { count: 3 })).toBe("3 of {x}");
  });
});
