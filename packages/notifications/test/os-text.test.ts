import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  localizeOsText,
  OS_TEXT,
  OS_TEXT_LANGUAGES,
  osLabel,
  osTextLanguage,
} from "../src/index.ts";
import { setup } from "./helpers.ts";

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe("OS notification catalogue", () => {
  it("covers the same languages as the UI catalogues", () => {
    const dir = new URL("../../ui/src/i18n/messages/locales/notices/", import.meta.url);
    const ui = readdirSync(dir)
      .filter((f) => f.endsWith(".ts"))
      .map((f) => f.slice(0, -3));
    expect([...OS_TEXT_LANGUAGES].filter((l) => l !== "en").sort()).toEqual(ui.sort());
  });

  it("has every key in every language, filled and with the same placeholders", () => {
    const keys = Object.keys(OS_TEXT.en);
    for (const lang of OS_TEXT_LANGUAGES) {
      expect(Object.keys(OS_TEXT[lang]).sort(), lang).toEqual([...keys].sort());
      for (const key of keys) {
        const text = (OS_TEXT[lang] as Record<string, string>)[key] as string;
        expect(text.trim().length, `${lang}.${key}`).toBeGreaterThan(0);
        expect(placeholders(text), `${lang}.${key}`).toEqual(
          placeholders((OS_TEXT.en as Record<string, string>)[key] as string),
        );
      }
    }
  });

  it("picks the owner's language, else English", () => {
    expect(osTextLanguage("de")).toBe("de");
    expect(osTextLanguage("pt-BR")).toBe("pt");
    expect(osTextLanguage(undefined)).toBe("en");
    expect(osTextLanguage("tlh")).toBe("en");
    expect(osTextLanguage(42)).toBe("en");
    expect(osTextLanguage("system", "ja-JP")).toBe("ja");
    expect(osTextLanguage("system")).toBe("en");
  });

  it("translates fixed sentences and inserts dynamic parts unchanged", () => {
    expect(localizeOsText("Approval pending", "de")).toBe("Freigabe ausstehend");
    expect(localizeOsText("Nightly backup failed", "de")).toBe("Nightly backup ist fehlgeschlagen");
    expect(localizeOsText("Open Psyche on your Mac to review.", "es")).toBe(
      "Abre Psyche en your Mac para revisarlo.",
    );
    expect(localizeOsText("Pay · external", "fr")).toBe("Payer · external");
    expect(localizeOsText("Pay · external · after reading untrusted content", "fr")).toBe(
      "Payer · external · after reading untrusted content",
    );
    expect(osLabel("deny", "ko")).toBe("거부");
  });

  it("leaves English, unknown text and look-alikes alone", () => {
    expect(localizeOsText("Approval pending", "en")).toBe("Approval pending");
    expect(localizeOsText("Weekly review", "de")).toBe("Weekly review");
    expect(localizeOsText("Pay", "de")).toBe("Pay");
    expect(localizeOsText("Approve", "de")).toBe("Approve");
    expect(localizeOsText("Pay the rent · tomorrow", "de")).toBe("Pay the rent · tomorrow");
  });
});

describe("notifier language", () => {
  it("stores the fixed sentences in the owner's language", async () => {
    let language: unknown = "de";
    const { notifier } = setup({ language: () => language });
    const n = await notifier.notify({
      kind: "approval",
      title: "Pay · external",
      body: "Approval pending",
    });
    expect(n.title).toBe("Bezahlen · external");
    expect(n.body).toBe("Freigabe ausstehend");
    language = undefined;
    const m = await notifier.notify({
      kind: "approval",
      title: "Pay · x",
      body: "Approval pending",
    });
    expect(m.body).toBe("Approval pending");
  });
});
