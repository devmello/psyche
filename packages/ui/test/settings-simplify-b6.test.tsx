import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FIXTURE_NOW } from "../src/fixtures/index.ts";
import {
  SETTINGS_PAGES,
  SettingsScreen,
  type SettingsSectionId,
} from "../src/screens/settings/SettingsScreen.tsx";
import {
  sampleEndpointProbes,
  sampleModelProviders,
  sampleModelRoles,
  sampleSettings,
} from "../src/screens/settings/sample-data.ts";
import { paneById, resolveSection } from "../src/screens/settings/settings-pages.ts";
import { parseSettingsRoute } from "../src/screens/settings/settings-route.ts";
import { StoryWorld } from "../src/stories/harness.tsx";

/** Simplify batch B6: Memory has one body and one deeper pane, VM mode and Specialists are folded. */

function setup(section: SettingsSectionId) {
  render(
    <StoryWorld
      edit={(w) => {
        Object.assign(w.settings, sampleSettings());
        w.modelProviders = sampleModelProviders();
        w.modelRoles = sampleModelRoles();
        w.modelProbes = sampleEndpointProbes();
      }}
    >
      <SettingsScreen now={Date.parse(FIXTURE_NOW)} defaultSection={section} />
    </StoryWorld>,
  );
}

describe("Memory: merged panes keep their old deep links", () => {
  it.each(["memory", "everything", "work", "surfaces"] as const)(
    "/settings/%s opens the Memory page at the top",
    (id) => {
      expect(resolveSection(id)).toEqual({ page: "memory" });
      expect(parseSettingsRoute(`/settings/${id}`)?.section).toBe(id);
    },
  );

  it("has one row left under Memory: People and privacy", () => {
    const memory = SETTINGS_PAGES.find((p) => p.id === "memory");
    const rows = memory?.panes.filter((id) => id !== memory.main && !memory.hidden?.includes(id));
    expect(rows).toEqual(["people"]);
    expect(resolveSection("people")).toEqual({ page: "memory", pane: "people" });
  });

  it("shows Where memory shows on the Memory page itself, not as a row", async () => {
    setup("memory");
    expect(await screen.findByText("Where memory shows")).toBeTruthy();
  });
});

describe("Specialists is folded into Skills", () => {
  it("redirects its old route to Skills, where it sits inside a closed Advanced fold", async () => {
    expect(resolveSection("specialists")).toEqual({ page: "daily", pane: "skills" });
    setup("skills");
    const summary = (await screen.findAllByText("Specialists")).find(
      (el) => el.closest("summary") !== null,
    );
    expect(summary).toBeTruthy();
    expect(summary?.closest("details")?.open).toBe(false);
  });
});

describe("VM mode is folded away inside Computer use", () => {
  it("sits in a closed Advanced fold; its old route still lands on Computer use", async () => {
    expect(resolveSection("vm")).toEqual({ page: "permissions", pane: "computer-use" });
    setup("computer-use");
    const heading = await screen.findByRole("heading", { level: 3, name: "VM mode" });
    const fold = heading.closest("details");
    expect(fold).not.toBeNull();
    expect(fold?.open).toBe(false);
    expect(fold?.querySelector("summary")?.textContent).toContain("VM mode");
  });
});

describe("Server pane label", () => {
  it("reads Network & remote access", () => {
    expect(paneById("server")?.label).toBe("Network & remote access");
  });
});
