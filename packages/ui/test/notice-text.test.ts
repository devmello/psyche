import { describe, expect, it } from "vitest";
import { CATALOGUES, createI18n, en, MESSAGE_LOCALES, noticeText } from "../src/i18n/index.ts";

const fallback = { title: "English title", body: "English body" };
const keyed = {
  ...fallback,
  message: {
    titleKey: "notice.attention.paused.title",
    bodyKey: "notice.attention.paused.body",
    params: { tool: "browser.click" },
  },
};

describe("noticeText", () => {
  it("words a keyed notice in the device's language", () => {
    const de = createI18n({ locale: "de-DE", language: "de" });
    const out = noticeText(keyed, de);
    expect(out.title).toBe("Eine Aufgabe wartet auf dich");
    expect(out.body).toContain("browser.click");
    expect(out.body).not.toBe(fallback.body);
  });

  it("shows the English text to a client that has no message (an old Gateway) or an unknown id", () => {
    const de = createI18n({ locale: "de-DE", language: "de" });
    expect(noticeText(fallback, de)).toEqual(fallback);
    expect(
      noticeText({ ...fallback, message: { titleKey: "notice.nope.title", bodyKey: "x.y" } }, de),
    ).toEqual(fallback);
  });

  it("shows values as plain text, never as markup or message syntax", () => {
    const e = createI18n({ locale: "en-US", language: "en" });
    const out = noticeText(
      {
        ...keyed,
        message: { ...keyed.message, params: { tool: "<b>{x}</b> {tool}" } },
      },
      e,
    );
    expect(out.body).toContain("<b>{x}</b> {tool}");
  });

  it("renders the security alert shapes the Gateway sends", () => {
    const fr = createI18n({ locale: "fr-FR", language: "fr" });
    const out = noticeText(
      {
        ...fallback,
        message: {
          titleKey: "notice.security.recovery.title",
          bodyKey: "notice.security.recovery.body",
          params: {
            state: "requested",
            op: "approve",
            device: "Phone",
            key: "none",
            scopes: "operator.read",
            when: "none",
            reason: "none",
          },
        },
      },
      fr,
    );
    expect(out.title).toContain("modification de sécurité");
    expect(out.body).toContain("Phone");
    expect(out.body).toContain("24 heures");
  });
});

describe("notice catalogue", () => {
  const ids = Object.keys(en).filter((k) => k.startsWith("notice."));
  it("has every notice id in all 10 languages", () => {
    expect(MESSAGE_LOCALES).toHaveLength(11); // English plus the 10 shipped translations
    expect(ids.length).toBeGreaterThan(20);
    for (const lang of MESSAGE_LOCALES.filter((l) => l !== "en")) {
      const cat = CATALOGUES[lang] as Record<string, string>;
      expect(
        ids.filter(
          (id) => cat[id] === undefined || cat[id] === "" || cat[id] === en[id as keyof typeof en],
        ),
        lang,
      ).toEqual([]);
    }
  });
});
