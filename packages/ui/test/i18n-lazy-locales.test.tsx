import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CATALOGUES } from "../src/i18n/messages/locales/index.ts";
import { MESSAGE_LOCALES } from "../src/i18n/messages/locales/list.ts";

// The test setup registers every language; these tests need the real, on-demand store, so each one
// loads the i18n modules afresh (a store that holds English only, like a renderer at start).
async function fresh() {
  vi.resetModules();
  const catalogues = await import("../src/i18n/catalogues.ts");
  const core = await import("../src/i18n/core.ts");
  const provider = await import("../src/i18n/I18nProvider.tsx");
  const platform = await import("../src/lib/platform.ts");
  const variants = await import("../src/i18n/messages/variants/index.ts");
  return { ...catalogues, ...core, ...provider, ...platform, ...variants };
}

const ID = "common.on" as const;
const german = CATALOGUES.de[ID] as string;
const spanish = CATALOGUES.es[ID] as string;

type UseI18n = () => { t: (id: typeof ID) => string };
let useFreshI18n: UseI18n | undefined;

// A module-level component (biome noComponentHookFactories) reading the fresh module's context.
function Probe() {
  return <span data-testid="probe">{useFreshI18n?.().t(ID)}</span>;
}

describe("the catalogue registries", () => {
  it("lists, loads and checks the same languages", async () => {
    const { LOADABLE_LOCALES } = await fresh();
    expect([...LOADABLE_LOCALES].sort()).toEqual([...MESSAGE_LOCALES].sort());
    expect(Object.keys(CATALOGUES).sort()).toEqual([...MESSAGE_LOCALES].sort());
  });
});

describe("loading a language on demand", () => {
  it("reads English until the language's chunk is in, then the language", async () => {
    const { createI18n, loadLocale, isLocaleLoaded } = await fresh();
    expect(german).not.toBe("On");
    expect(isLocaleLoaded("de")).toBe(false);
    expect(createI18n({ locale: "de-DE", language: "de" }).t(ID)).toBe("On");
    expect(await loadLocale("de")).toBe(true);
    expect(isLocaleLoaded("de")).toBe(true);
    expect(createI18n({ locale: "de-DE", language: "de" }).t(ID)).toBe(german);
    // Only English and German are in memory: Spanish was never asked for.
    expect(isLocaleLoaded("es")).toBe(false);
  });

  it("createLoadedI18n renders the language on its first string", async () => {
    const { createLoadedI18n } = await fresh();
    const i18n = await createLoadedI18n({ locale: "ja-JP" });
    expect(i18n.messageLocale).toBe("ja");
    expect(i18n.t(ID)).toBe(CATALOGUES.ja[ID]);
  });

  it("a failed chunk load resolves false and leaves English, without throwing", async () => {
    vi.resetModules();
    vi.doMock("../src/i18n/messages/locales/fr.ts", () => {
      throw new Error("chunk failed");
    });
    const { loadLocale } = await import("../src/i18n/catalogues.ts");
    const { createI18n } = await import("../src/i18n/core.ts");
    expect(await loadLocale("fr")).toBe(false);
    expect(createI18n({ locale: "fr-FR", language: "fr" }).t(ID)).toBe("On");
    vi.doUnmock("../src/i18n/messages/locales/fr.ts");
  });
});

describe("platform variants load only for the running platform", () => {
  it("a Mac loads none, Linux loads its own and not Windows'", async () => {
    const m = await fresh();
    m.setUiPlatform("macos");
    await m.loadLocale("de");
    expect(m.hasPlatformVariants("linux")).toBe(false);
    expect(m.hasPlatformVariants("windows")).toBe(false);
    m.setUiPlatform("linux");
    expect(m.isLocaleLoaded("de")).toBe(false);
    await m.loadLocale("de");
    expect(m.isLocaleLoaded("de")).toBe(true);
    expect(m.hasPlatformVariants("linux")).toBe(true);
    expect(m.hasPlatformVariants("windows")).toBe(false);
    m.setUiPlatform(undefined);
  });
});

describe("I18nProvider", () => {
  it("paints the preloaded language on the first render, with no English flash", async () => {
    const m = await fresh();
    await m.loadLocale("de");
    useFreshI18n = m.useI18n as UseI18n;
    render(
      <m.I18nProvider locale="de-DE" language="de">
        <Probe />
      </m.I18nProvider>,
    );
    // Right after render: no effect or load has run yet.
    expect(screen.getByTestId("probe").textContent).toBe(german);
  });

  it("switching language loads the chunk, keeps the current text meanwhile, then re-renders", async () => {
    const m = await fresh();
    await m.loadLocale("de");
    useFreshI18n = m.useI18n as UseI18n;
    const view = (language: string) => (
      <m.I18nProvider locale="en-US" language={language}>
        <Probe />
      </m.I18nProvider>
    );
    const { rerender } = render(view("de"));
    expect(screen.getByTestId("probe").textContent).toBe(german);
    rerender(view("es"));
    // The Spanish chunk is not in yet: German stays, not English.
    expect(m.isLocaleLoaded("es")).toBe(false);
    expect(screen.getByTestId("probe").textContent).toBe(german);
    await act(async () => {
      await m.loadLocale("es");
    });
    expect(screen.getByTestId("probe").textContent).toBe(spanish);
  });

  it("falls back to English when the chunk fails to load, without crashing", async () => {
    vi.resetModules();
    vi.doMock("../src/i18n/messages/locales/fr.ts", () => {
      throw new Error("chunk failed");
    });
    const provider = await import("../src/i18n/I18nProvider.tsx");
    useFreshI18n = provider.useI18n as UseI18n;
    render(
      <provider.I18nProvider locale="en-US" language="fr">
        <Probe />
      </provider.I18nProvider>,
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(screen.getByTestId("probe").textContent).toBe("On");
    vi.doUnmock("../src/i18n/messages/locales/fr.ts");
  });
});
