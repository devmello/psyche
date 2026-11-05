import { describe, expect, it } from "vitest";
import {
  confirmReplaceKey,
  REPLACE_KEY_TEXT,
  replaceKeyText,
} from "../../src/main/replace-key-dialog.ts";

describe("the native replace-key confirmation", () => {
  it("ships all ten languages plus English, each with both key placeholders", () => {
    expect(Object.keys(REPLACE_KEY_TEXT).sort()).toEqual(
      ["ar", "de", "en", "es", "fr", "hi", "it", "ja", "ko", "pt", "zh"].sort(),
    );
    for (const text of Object.values(REPLACE_KEY_TEXT)) {
      expect(text.message).toContain("{previous}");
      expect(text.message).toContain("{next}");
      expect(text.replace.length).toBeGreaterThan(0);
    }
  });

  it("picks the language of the OS locale and falls back to English", () => {
    expect(replaceKeyText("de-DE").replace).toBe("Schlüssel ersetzen");
    expect(replaceKeyText("pt_BR").cancel).toBe("Cancelar");
    expect(replaceKeyText("sv").cancel).toBe("Cancel");
  });

  it("names both keys and returns true only for the Replace button", async () => {
    const seen: { detail: string; buttons: string[] }[] = [];
    const answer = (response: number) => async (o: { detail: string; buttons: string[] }) => {
      seen.push(o);
      return { response };
    };
    const prev = "a".repeat(64);
    const next = "b".repeat(64);
    expect(await confirmReplaceKey(answer(1) as never, "en-US", prev, next)).toBe(true);
    expect(await confirmReplaceKey(answer(0) as never, "en-US", prev, next)).toBe(false);
    expect(seen[0]?.detail).toContain("aaaa aaaa aaaa aaaa");
    expect(seen[0]?.detail).toContain("bbbb bbbb bbbb bbbb");
    expect(seen[0]?.buttons).toEqual(["Cancel", "Replace key"]);
  });
});
