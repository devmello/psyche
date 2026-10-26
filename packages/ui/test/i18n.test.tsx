import { PsycheError } from "@psyche/protocol";
import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { IntlMessageFormat } from "intl-messageformat";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { CompactionMarker } from "../src/chat/context/CompactionMarker.tsx";
import { formatTokens } from "../src/chat/context/types.ts";
import { GatewayRequestError } from "../src/data/client.ts";
import type { MockGateway } from "../src/data/mock-gateway.ts";
import { FIXTURE_NOW } from "../src/fixtures/index.ts";
import {
  activeI18n,
  createI18n,
  describeError,
  directionOf,
  en,
  I18nProvider,
  messageLocaleFor,
  resolveDirection,
  resolveLocale,
  setActiveI18n,
  t,
} from "../src/i18n/index.ts";
import { formatDuration, formatRelative } from "../src/lib/format.ts";
import { SettingsScreen } from "../src/screens/settings/SettingsScreen.tsx";
import { AppearanceProvider } from "../src/shell/AppearanceProvider.tsx";
import { StoryWorld } from "../src/stories/harness.tsx";

const initial = activeI18n();
afterEach(() => setActiveI18n(initial));

/** Sample values for every argument a message's AST names, by kind. */
function sampleValues(source: string): Record<string, string | number | Date> {
  const values: Record<string, string | number | Date> = {};
  const walk = (els: ReturnType<IntlMessageFormat["getAst"]>) => {
    for (const el of els) {
      const e = el as { type: number; value?: string; options?: Record<string, { value: [] }> };
      if (e.value === undefined || e.type === 0) continue;
      // 1 argument, 2 number, 3 date, 4 time, 5 select, 6 plural (formatjs TYPE).
      values[e.value] =
        e.type === 2 || e.type === 6 ? 2 : e.type === 3 || e.type === 4 ? new Date(0) : "x";
      if (e.type === 5) values[e.value] = "other";
      for (const opt of Object.values(e.options ?? {})) walk(opt.value);
    }
  };
  walk(new IntlMessageFormat(source, "en", undefined, { ignoreTag: true }).getAst());
  return values;
}

describe("the English catalogue", () => {
  it("parses and formats every message as ICU MessageFormat", () => {
    for (const [id, source] of Object.entries(en)) {
      expect(() => t(id as keyof typeof en, sampleValues(source)), id).not.toThrow();
      expect(t(id as keyof typeof en, sampleValues(source)), id).not.toBe("");
    }
  });

  it("uses stable dotted ids grouped by area", () => {
    for (const id of Object.keys(en)) expect(id).toMatch(/^[a-z][a-zA-Z]*(\.[a-zA-Z0-9_]+)+$/);
  });

  it("keeps apostrophes literal and plurals in English", () => {
    expect(t("context.compact.busy")).toBe(
      "Can't compact while the agent is working or waiting on an approval.",
    );
    expect(t("time.days", { n: 1 })).toBe("1 day");
    expect(t("time.days", { n: 4 })).toBe("4 days");
  });
});

describe("locales", () => {
  it("resolves the format locale from the override, else the system", () => {
    expect(resolveLocale("system", "en_GB")).toBe("en-GB");
    expect(resolveLocale("fr-FR", "en-GB")).toBe("fr-FR");
    expect(resolveLocale("not a locale!", "de-DE")).toBe("de-DE");
    expect(resolveLocale(undefined, "ja-JP")).toBe("ja-JP");
  });

  it("falls back to the English catalogue and follows its direction", () => {
    expect(messageLocaleFor("fr-FR")).toBe("en");
    expect(directionOf("ar-EG")).toBe("rtl");
    expect(directionOf("en-GB")).toBe("ltr");
    // English text under an Arabic region stays left to right unless the owner overrides it.
    expect(resolveDirection("auto", messageLocaleFor("ar-EG"))).toBe("ltr");
    expect(resolveDirection("rtl", "en")).toBe("rtl");
  });

  it("writes numbers and dates in the format locale and plurals in the message's language", () => {
    const de = createI18n({ locale: "de-DE" });
    expect(de.number(1234567.5)).toBe("1.234.567,5");
    expect(de.t("context.meter.usage", { used: 141000, limit: 200000, pct: 71 })).toBe(
      "141.000 of 200.000 tokens (71%).",
    );
    // French plural rules would make 0 "one"; the English text keeps English rules.
    const fr = createI18n({ locale: "fr-FR" });
    expect(fr.t("time.days", { n: 0 })).toBe("0 days");
    setActiveI18n(de);
    expect(formatTokens(12_400)).toBe("12,4k");
    expect(formatDuration(65 * 60_000)).toBe("1 h 5 min");
  });

  it("keeps the relative-time wording of the copy voice", () => {
    const now = Date.parse(FIXTURE_NOW);
    expect(formatRelative(new Date(now - 10_000).toISOString(), now)).toBe("just now");
    expect(formatRelative(new Date(now - 41 * 60_000).toISOString(), now)).toBe("41 min ago");
    expect(formatRelative(new Date(now + 3 * 3_600_000).toISOString(), now)).toBe("in 3 h");
    expect(formatRelative(new Date(now - 26 * 3_600_000).toISOString(), now)).toBe("yesterday");
    expect(formatRelative(new Date(now + 4 * 86_400_000).toISOString(), now)).toBe("in 4 days");
  });
});

describe("Gateway errors", () => {
  const conflict = new GatewayRequestError("threads.compact", "conflict", "the thread is running");

  it("keeps the Gateway's English message in English and maps the code otherwise", () => {
    setActiveI18n(createI18n({ locale: "en-US" }));
    expect(describeError(conflict)).toBe("the thread is running");
    expect(describeError(new PsycheError("policy_denied", ""))).toBe(
      "Your permission settings don't allow this.",
    );
    // A message locale without the Gateway's language gets the catalogue sentence by code.
    const i18n = { ...createI18n({ locale: "en-US" }), messageLocale: "xx" };
    setActiveI18n(i18n);
    expect(describeError(conflict)).toBe("Something else changed it first; try again.");
    expect(describeError(new Error("socket hang up"))).toBe("Something went wrong.");
  });
});

/** Reads the active i18n while rendering, inside the provider. */
const ShowLocale = () => <p>{activeI18n().locale}</p>;
const Dir = ({ children }: { children: ReactNode }) => <div dir={activeI18n().dir}>{children}</div>;

describe("I18nProvider", () => {
  it("sets lang and dir on the document and remounts on a change", () => {
    const { rerender } = render(
      <I18nProvider locale="en-GB" direction="rtl" applyToDocument>
        <ShowLocale />
      </I18nProvider>,
    );
    expect(document.documentElement.lang).toBe("en");
    expect(document.documentElement.dir).toBe("rtl");
    expect(screen.getByText("en-GB")).toBeTruthy();
    rerender(
      <I18nProvider locale="de-DE" applyToDocument>
        <ShowLocale />
      </I18nProvider>,
    );
    expect(screen.getByText("de-DE")).toBeTruthy();
    expect(document.documentElement.dir).toBe("ltr");
  });

  it("renders the compaction marker right to left with mirrored chevrons", async () => {
    render(
      <I18nProvider direction="rtl">
        <Dir>
          <CompactionMarker
            compaction={{
              id: "c1",
              trigger: "manual",
              tokensBefore: 9_000,
              tokensAfter: 700,
              replacedTurns: 3,
              summary: { facts: ["A fact."], decisions: [], openTasks: [], pinnedInstructions: [] },
              createdAt: FIXTURE_NOW,
            }}
          />
        </Dir>
      </I18nProvider>,
    );
    const toggle = screen.getByRole("button", {
      name: "3 earlier turns were compacted on request, 9k → 700 tokens",
    });
    expect(toggle.closest("[dir]")?.getAttribute("dir")).toBe("rtl");
    expect(toggle.querySelector("svg")?.getAttribute("class")).toContain("rtl:rotate-180");
    await userEvent.click(toggle);
    expect(screen.getByRole("list", { name: "Facts" }).className).toContain("ms-4");
  });
});

describe("Settings → Appearance → Language and region", () => {
  it("shows the system region, saves an override and the direction", async () => {
    let gw: MockGateway | null = null;
    render(
      <StoryWorld onGateway={(g) => (gw = g)}>
        <AppearanceProvider systemLocale="en-GB">
          <SettingsScreen now={Date.parse(FIXTURE_NOW)} defaultSection="appearance" />
        </AppearanceProvider>
      </StoryWorld>,
    );
    const region = (await screen.findByLabelText("Region format")) as HTMLSelectElement;
    expect(region.value).toBe("system");
    expect(screen.getByRole("option", { name: "Match system (British English)" })).toBeTruthy();
    // The language is its own select: shipped catalogues only, by native name.
    const language = screen.getByLabelText("Language") as HTMLSelectElement;
    expect(language.value).toBe("system");
    expect(screen.getByRole("option", { name: "Match system (English)" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "English" })).toBeTruthy();
    expect(screen.getByText("Tue, 27 Oct 2026 · 14:05 · 1,234.5 · US$4.20")).toBeTruthy();
    await userEvent.selectOptions(region, "de-DE");
    const calls = () =>
      (gw as unknown as MockGateway).calls.filter((c) => c.method === "settings.set");
    await waitFor(() =>
      expect(calls().map((c) => c.params)).toContainEqual({ key: "ui.locale", value: "de-DE" }),
    );
    // The app remounts in the new locale: the example follows it.
    expect(
      await screen.findByText(/Di\., 27\. Okt\. 2026 · 14:05 · 1\.234,5 · 4,20\s\$/),
    ).toBeTruthy();
    await userEvent.click(screen.getByRole("radio", { name: "Right to left" }));
    await waitFor(() =>
      expect(calls().map((c) => c.params)).toContainEqual({ key: "ui.direction", value: "rtl" }),
    );
    await waitFor(() => expect(document.documentElement.dir).toBe("rtl"));
  });
});
