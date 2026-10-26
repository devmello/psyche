import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { MockGateway } from "../src/data/mock-gateway.ts";

// A shipped German catalogue for these tests only: two ids, one of them broken on purpose.
vi.mock("../src/i18n/messages/locales/index.ts", async () => {
  const { en } = await vi.importActual<typeof import("../src/i18n/messages/index.ts")>(
    "../src/i18n/messages/index.ts",
  );
  const de = {
    "common.on": "Ein",
    "onboarding.language.label": "Sprache",
    "time.days": "{n, plural, one {# Tag} other {# Tage}}",
    "time.justNow": "{broken",
  };
  return { CATALOGUES: { en, de }, MESSAGE_LOCALES: ["en", "de"] };
});

// The setup file loaded the i18n with the real registry; load this file's modules afresh so they
// see the mock.
vi.resetModules();
const { createI18n, setActiveI18n } = await import("../src/i18n/core.ts");
const { localeName, resolveMessageLocale } = await import("../src/i18n/locale.ts");
const { MeetStep } = await import("../src/screens/onboarding/OnboardingSteps.tsx");
const { AppearanceProvider } = await import("../src/shell/AppearanceProvider.tsx");
const { StoryWorld } = await import("../src/stories/harness.tsx");
setActiveI18n(createI18n({ locale: "en-US" }));

describe("the text's language (A12, #621)", () => {
  it("is ui.language when it names a catalogue, else the region's catalogue, else English", () => {
    expect(resolveMessageLocale("de", "en-US")).toBe("de");
    expect(resolveMessageLocale("de-CH", "en-US")).toBe("de");
    expect(resolveMessageLocale("system", "de-AT")).toBe("de");
    expect(resolveMessageLocale(undefined, "de-DE")).toBe("de");
    expect(resolveMessageLocale("en", "de-DE")).toBe("en");
    // Not shipped: the region decides.
    expect(resolveMessageLocale("fr", "de-DE")).toBe("de");
    expect(resolveMessageLocale("system", "fr-FR")).toBe("en");
  });

  it("falls back to English per id, and for a message that does not parse", () => {
    const i18n = createI18n({ locale: "en-US", language: "de" });
    expect(i18n.messageLocale).toBe("de");
    expect(i18n.t("common.on")).toBe("Ein");
    expect(i18n.t("common.off")).toBe("Off");
    expect(i18n.t("time.days", { n: 3 })).toBe("3 Tage");
    expect(i18n.t("time.justNow")).toBe("just now");
    // The format locale stays the region's.
    expect(i18n.number(1234.5)).toBe("1,234.5");
  });

  it("names languages in their own language for the pickers", () => {
    expect(localeName("de", "de")).toBe("Deutsch");
    expect(localeName("es", "es")).toBe("Español");
    expect(localeName("ja", "ja")).toBe("日本語");
  });
});

describe("the onboarding language select (A12, #621)", () => {
  it("defaults to the system language, persists ui.language and remounts in it", async () => {
    let gw: MockGateway | null = null;
    render(
      <StoryWorld onGateway={(g) => (gw = g)}>
        <AppearanceProvider systemLocale="en-GB">
          <MeetStep
            value={{
              name: "",
              creatureId: "moth",
              creatureMode: "bundled",
              creatureDescription: "",
              tagline: "",
            }}
            onChange={() => {}}
          />
        </AppearanceProvider>
      </StoryWorld>,
    );
    const select = (await screen.findByLabelText("Language")) as HTMLSelectElement;
    expect(select.value).toBe("system");
    expect(screen.getByRole("option", { name: "Match system (English)" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Deutsch" })).toBeTruthy();

    await userEvent.selectOptions(select, "de");
    await waitFor(() =>
      expect(
        (gw as unknown as MockGateway).calls
          .filter((c) => c.method === "settings.set")
          .map((c) => c.params),
      ).toContainEqual({ key: "ui.language", value: "de" }),
    );
    // The flow remounts in German: the label is the German one, and <html lang> follows.
    const german = (await screen.findByLabelText("Sprache")) as HTMLSelectElement;
    expect(german.value).toBe("de");
    await waitFor(() => expect(document.documentElement.lang).toBe("de"));
  });
});
