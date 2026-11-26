import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { MockGateway } from "../src/data/mock-gateway.ts";
import { paneForKey, SETTINGS_PAGES } from "../src/screens/settings/SettingsScreen.tsx";
import { SpecialistsSection } from "../src/screens/settings/SpecialistsSection.tsx";
import { settingLabel } from "../src/screens/settings/setting-labels.ts";
import { StoryWorld } from "../src/stories/harness.tsx";

function renderSection() {
  const ref: { gateway?: MockGateway } = {};
  render(
    <StoryWorld
      onGateway={(g) => {
        ref.gateway = g;
      }}
    >
      <SpecialistsSection />
    </StoryWorld>,
  );
  const gateway = ref.gateway as MockGateway;
  return vi.spyOn(gateway, "request");
}

/** The `settings.set` calls made so far, as `[key, value]`. */
function writes(spy: ReturnType<typeof renderSection>): [string, unknown][] {
  return spy.mock.calls
    .filter(([method]) => method === "settings.set")
    .map(([, params]) => {
      const p = params as { key: string; value: unknown };
      return [p.key, p.value];
    });
}

describe("Settings → Specialists (specialists §6.4)", () => {
  it("lives on Routines & skills next to Skills, and finds its keys", () => {
    const panes = SETTINGS_PAGES.find((p) => p.id === "daily")?.panes ?? [];
    expect(panes.indexOf("specialists")).toBe(panes.indexOf("skills") + 1);
    expect(paneForKey("specialists.enabled.researcher")).toBe("specialists");
    expect(settingLabel("specialists.model.coder")).toBe("coder model");
    expect(settingLabel("specialists.maxConcurrent")).toBe("Specialists at once");
  });

  it("turns roles on, sets how many run at once, and shows results in Feed", async () => {
    const spy = renderSection();
    const planner = await screen.findByRole("switch", { name: "Planner on" });
    expect(planner.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByRole("switch", { name: "Researcher on" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    await userEvent.click(planner);
    fireEvent.change(screen.getByLabelText("Specialists at once"), { target: { value: "5" } });
    await userEvent.click(screen.getByRole("switch", { name: "Show results in Feed" }));
    await waitFor(() =>
      expect(writes(spy)).toEqual([
        ["specialists.enabled.planner", true],
        ["specialists.maxConcurrent", 5],
        ["specialists.showInFeed", true],
      ]),
    );
  });

  it("edits a role's model, and offers no budget, cap or mode control nothing reads", async () => {
    const spy = renderSection();
    await userEvent.click(await screen.findByRole("button", { name: "Edit Researcher" }));
    const row = screen.getByTestId("specialist-role-researcher");
    const model = within(row).getByLabelText("Model") as HTMLSelectElement;
    expect(model.options[0]?.textContent).toBe("Default: primary model");
    fireEvent.change(model, { target: { value: model.options[1]?.value ?? "" } });
    await waitFor(() => expect(writes(spy)).toHaveLength(1));
    expect(writes(spy)[0]?.[0]).toBe("specialists.model.researcher");
    expect(within(row).queryByLabelText("Tokens")).toBeNull();
    expect(within(row).queryByRole("radio", { name: "Manual" })).toBeNull();
    expect(screen.queryByText("Monthly specialist spend")).toBeNull();
  });
});
