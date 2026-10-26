import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { MockGateway } from "../src/data/mock-gateway.ts";
import { SETTINGS_GROUPS, sectionForKey } from "../src/screens/settings/SettingsScreen.tsx";
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
  it("lives in Access next to Skills, and finds its keys", () => {
    const access = SETTINGS_GROUPS.find((g) => g.id === "access")?.sections ?? [];
    expect(access.indexOf("specialists")).toBe(access.indexOf("skills") + 1);
    expect(sectionForKey("specialists.budget.researcher")).toBe("specialists");
    expect(settingLabel("specialists.maxMode.coder")).toBe("coder permission mode");
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

  it("edits a role's model, budget (capped) and permission mode", async () => {
    const spy = renderSection();
    await userEvent.click(await screen.findByRole("button", { name: "Edit Researcher" }));
    const row = screen.getByTestId("specialist-role-researcher");
    const model = within(row).getByLabelText("Model") as HTMLSelectElement;
    expect(model.options[0]?.textContent).toBe("Default: primary model");
    const tokens = within(row).getByLabelText("Tokens");
    await userEvent.clear(tokens);
    await userEvent.type(tokens, "3000000{Enter}");
    // The skill caps the researcher at 2M tokens.
    expect((tokens as HTMLInputElement).value).toBe("2000000");
    await userEvent.click(within(row).getByRole("radio", { name: "Manual" }));
    await waitFor(() =>
      expect(writes(spy)).toEqual([
        ["specialists.budget.researcher", { tokens: 2_000_000, costUsd: 2, minutes: 30 }],
        ["specialists.maxMode.researcher", "manual"],
      ]),
    );
  });
});
