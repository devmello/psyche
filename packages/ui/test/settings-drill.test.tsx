import { render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { FIXTURE_NOW } from "../src/fixtures/index.ts";
import {
  SETTINGS_PAGES,
  SETTINGS_PANES,
  type SettingsPaneId,
  SettingsScreen,
  type SettingsSectionId,
  searchSettings,
} from "../src/screens/settings/SettingsScreen.tsx";
import {
  sampleEndpointProbes,
  sampleModelProviders,
  sampleModelRoles,
  sampleSettings,
} from "../src/screens/settings/sample-data.ts";
import { StoryWorld } from "../src/stories/harness.tsx";

/** Settings pages are lists of rows that open a pane one level deeper (wave C). */

function setup(section?: SettingsSectionId) {
  const navigate = vi.fn();
  render(
    <StoryWorld
      edit={(w) => {
        Object.assign(w.settings, sampleSettings());
        w.modelProviders = sampleModelProviders();
        w.modelRoles = sampleModelRoles();
        w.modelProbes = sampleEndpointProbes();
      }}
      slots={{ navigate }}
    >
      <SettingsScreen
        now={Date.parse(FIXTURE_NOW)}
        {...(section === undefined ? {} : { defaultSection: section })}
      />
    </StoryWorld>,
  );
  return { navigate };
}

/** The back link above a drilled-in pane (the sidebar has a button of the same name). */
const backTo = (name: string) =>
  screen
    .getAllByRole("button", { name })
    .find((b) => !b.closest('nav[aria-label="Settings sections"]'));

describe("old pane labels still find their pane", () => {
  const drillable = SETTINGS_PANES.filter((pane) =>
    SETTINGS_PAGES.some((p) => p.panes.includes(pane.id) && p.main !== pane.id && p.id !== pane.id),
  );

  it("covers every pane that moved one level deeper", () => {
    expect(drillable.map((p) => p.id)).toEqual(
      expect.arrayContaining(["computer-use", "browser", "files", "credentials", "vm", "usage"]),
    );
  });

  it.each(drillable.map((p) => [p.id, p.label] as const))(
    "searching %s (%s) lands on that pane",
    (id, label) => {
      const hit = searchSettings(label).find((h) => h.kind === "pane" && h.pane === id);
      expect(hit, `search finds ${label}`).toBeTruthy();
    },
  );

  it("opens the drill-in with a way back when a search result is chosen", async () => {
    const { navigate } = setup("essentials");
    await userEvent.type(
      screen.getByRole("searchbox", { name: "Search settings" }),
      "Computer use",
    );
    const nav = screen.getByRole("navigation", { name: "Settings sections" });
    await userEvent.click(within(nav).getByRole("button", { name: /^Computer use/ }));
    expect(navigate).toHaveBeenCalledWith("/settings/computer-use");
    expect(await screen.findByRole("heading", { level: 2, name: "Computer use" })).toBeTruthy();
    expect(backTo("Permissions")).toBeTruthy();
  });

  it("keeps the page and its own body for a page-id route", async () => {
    setup("permissions");
    expect(await screen.findByRole("heading", { level: 2, name: "Permissions" })).toBeTruthy();
    // A page-id route is the page itself, not a drilled-in pane: no way back.
    expect(screen.getAllByRole("button", { name: "Permissions" })).toHaveLength(1);
  });
});

describe("Permissions page", () => {
  it("shows Asking, an Access list of rows and a Credentials row", async () => {
    const { navigate } = setup("permissions");
    expect(await screen.findByRole("heading", { name: "Asking" })).toBeTruthy();
    const access = screen.getByRole("region", { name: "Access" });
    expect(
      within(access)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Files and folders", "Browser", "Computer use", "VM mode"]);
    expect(screen.getByRole("button", { name: "Credentials" })).toBeTruthy();
    // The three modes and the Allowed list are still on the page.
    expect(screen.getByRole("radio", { name: /Manual/ })).toBeTruthy();
    expect(screen.getByRole("radio", { name: /Auto/ })).toBeTruthy();

    await userEvent.click(within(access).getByRole("button", { name: "Browser" }));
    expect(navigate).toHaveBeenCalledWith("/settings/browser");
    expect(await screen.findByRole("heading", { level: 2, name: "Browser" })).toBeTruthy();
    await userEvent.click(backTo("Permissions") as HTMLElement);
    expect(await screen.findByRole("heading", { name: "Asking" })).toBeTruthy();
  });

  it("opens Credentials one level deeper", async () => {
    const { navigate } = setup("permissions");
    await userEvent.click(await screen.findByRole("button", { name: "Credentials" }));
    expect(navigate).toHaveBeenCalledWith("/settings/credentials");
  });
});

describe("Pages that listed several panes", () => {
  it.each([
    ["general", ["Appearance", "Persona", "Notifications", "Voice & dictation"]],
    ["connectors", ["Search", "Mail & meetings"]],
    ["model", ["Usage"]],
  ] as const)("%s opens its other panes from rows", async (section, rows) => {
    setup(section);
    for (const name of rows) {
      const found = await screen.findAllByRole("button", { name: new RegExp(`^${name}`) });
      expect(found.length).toBeGreaterThan(0);
    }
  });

  it("does not stack the panes of a page any more", async () => {
    setup("general");
    await screen.findByRole("button", { name: "Persona" });
    // Appearance's own controls are one row away, not on the page.
    expect(screen.queryByRole("switch", { name: /High contrast/ })).toBeNull();
  });
});

describe("Appearance accessibility row", () => {
  it("keeps motion, contrast and translucency under an Accessibility row", async () => {
    setup("appearance");
    const summary = await screen.findByText("Accessibility");
    const details = summary.closest("details");
    expect(details).toBeTruthy();
    expect(
      within(details as HTMLElement).getByRole("switch", { name: /High contrast/ }),
    ).toBeTruthy();
    expect((details as HTMLDetailsElement).open).toBe(false);
  });
});

describe("Models page", () => {
  it("shows the five keys as rows, with no key field on the page", async () => {
    setup("model");
    const names = ["Anthropic", "OpenAI", "Google Gemini", "OpenRouter", "Brave Search"];
    for (const id of ["anthropic", "openai", "google", "openrouter", "brave"]) {
      expect(await screen.findByTestId(`api-key-row-${id}`)).toBeTruthy();
    }
    for (const name of names) expect(screen.queryByLabelText(`${name} API key`)).toBeNull();
  });
});

describe("Every pane is reachable", () => {
  it("each pane id resolves to a page that shows it inline or as a row", () => {
    for (const pane of SETTINGS_PANES) {
      const page = SETTINGS_PAGES.find((p) => p.panes.includes(pane.id as SettingsPaneId));
      expect(page, pane.id).toBeTruthy();
    }
  });
});
