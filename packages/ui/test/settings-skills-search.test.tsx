import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { MockGateway } from "../src/data/mock-gateway.ts";
import { FIXTURE_NOW } from "../src/fixtures/index.ts";
import { SettingsScreen } from "../src/screens/settings/SettingsScreen.tsx";
import { StoryWorld } from "../src/stories/harness.tsx";

/** Settings → Skills: search (`skills.search`, debounced) and the read-only detail view (`skills.get`). */

function setup(): () => MockGateway {
  let gw: MockGateway | null = null;
  render(
    <StoryWorld onGateway={(g) => (gw = g)}>
      <SettingsScreen now={Date.parse(FIXTURE_NOW)} defaultSection="skills" />
    </StoryWorld>,
  );
  return () => {
    if (gw === null) throw new Error("gateway not ready");
    return gw;
  };
}

/** The queries `skills.search` was called with, in order. */
const searches = (g: MockGateway): string[] =>
  g.calls
    .filter((c) => c.method === "skills.search")
    .map((c) => (c.params as { query: string }).query);

async function field(): Promise<HTMLElement> {
  return screen.findByRole("searchbox", { name: "Search skills" });
}

describe("Settings → Skills search", () => {
  it("debounces typing into one search and shows the matching skills", async () => {
    const gateway = setup();
    const input = await field();
    await userEvent.type(input, "receipt");
    expect(await screen.findByTestId("skill-hit-receipt-filer")).toBeTruthy();
    expect(screen.queryByTestId("skill-hit-crypto-helper")).toBeNull();
    // Typed quickly: one call for the settled query, not one per keystroke.
    expect(searches(gateway())).toEqual(["receipt"]);
  });

  it("shows a short empty state when nothing matches", async () => {
    setup();
    const input = await field();
    await userEvent.type(input, "zzqx");
    expect(await screen.findByText("No skills match zzqx.")).toBeTruthy();
    expect(screen.queryByTestId("skill-results")).toBeNull();
  });

  it("shows the normal list again when the field is cleared", async () => {
    const gateway = setup();
    const input = await field();
    await userEvent.type(input, "receipt");
    await screen.findByTestId("skill-hit-receipt-filer");
    await userEvent.clear(input);
    expect(await screen.findByTestId("skill-receipt-filer")).toBeTruthy();
    expect(screen.queryByTestId("skill-results")).toBeNull();
    // An empty field searches for nothing.
    expect(searches(gateway())).toEqual(["receipt"]);
  });
});

describe("Settings → Skills detail view", () => {
  it("opens a skill with its details and read-only SKILL.md text", async () => {
    const gateway = setup();
    const row = await screen.findByTestId("skill-receipt-filer");
    await userEvent.click(within(row).getByRole("button", { name: "receipt-filer" }));
    const dialog = await screen.findByTestId("skill-detail");
    expect(
      within(dialog).getByText("Fixture instructions for receipt-filer.", { exact: false }),
    ).toBeTruthy();
    expect(within(dialog).getByText("Status")).toBeTruthy();
    const call = gateway().calls.find((c) => c.method === "skills.get");
    expect(call?.params).toEqual({ name: "receipt-filer", source: "home" });
  });

  it("says so when the skill's file cannot be read", async () => {
    const gateway = setup();
    const skill = gateway().world.skills.find((s) => s.name === "weekly-review");
    if (skill === undefined) throw new Error("fixture skill missing");
    skill.hash = "";
    const row = await screen.findByTestId("skill-weekly-review");
    await userEvent.click(within(row).getByRole("button", { name: "weekly-review" }));
    const dialog = await screen.findByTestId("skill-detail");
    await waitFor(() =>
      expect(within(dialog).getByText("This skill's file can't be read.")).toBeTruthy(),
    );
  });
});
