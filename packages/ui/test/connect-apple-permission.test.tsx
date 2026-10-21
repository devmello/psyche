import { act, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { MockGateway } from "../src/data/mock-gateway.ts";
import { ConnectorsSection } from "../src/screens/settings/ConnectorsSection.tsx";
import { StoryWorld } from "../src/stories/harness.tsx";

/** #549: Apple connectors wait on the macOS grant, and one-per-machine types are offered once. */

function setup(grant: "granted" | "denied") {
  let gw: MockGateway | null = null;
  render(
    <StoryWorld
      edit={(w) => {
        w.connectors = [];
        w.appleGrant = grant;
      }}
      onGateway={(g) => (gw = g)}
    >
      <ConnectorsSection />
    </StoryWorld>,
  );
  return () => gw as unknown as MockGateway;
}

async function connect(label: string) {
  await waitFor(async () => {
    await userEvent.click(
      screen.getAllByRole("button", { name: "Connect an account" })[0] as HTMLElement,
    );
    expect(screen.getByLabelText("Account type")).toBeTruthy();
  });
  await userEvent.selectOptions(screen.getByLabelText("Account type"), label);
  await userEvent.click(screen.getByRole("button", { name: "Continue to sign in" }));
}

describe("Apple connectors and macOS permission (#549)", () => {
  it("shows Needs permission with where to allow it, and flips to connected on Check again", async () => {
    const gateway = setup("denied");
    await connect("Apple Mail");
    const card = await screen.findByTestId("connect-needs-permission");
    expect(within(card).getByText(/macOS has not allowed it yet/)).toBeTruthy();
    expect(
      within(card).getByText(
        "System Settings → Privacy & Security → Automation → Psyche (Helper) → Mail",
      ),
    ).toBeTruthy();
    expect(within(card).getByRole("button", { name: "Open System Settings" })).toBeTruthy();
    // The row says so too, never "Connected".
    const row = await screen.findByRole("article", { name: "Apple Mail" });
    expect(within(row).getByText("Needs permission")).toBeTruthy();

    act(() => {
      gateway().world.appleGrant = "granted";
    });
    await userEvent.click(within(card).getByRole("button", { name: "Check again" }));
    expect(await screen.findByText(/Apple Mail is connected as This Mac\./)).toBeTruthy();
    await waitFor(() =>
      expect(
        within(screen.getByRole("article", { name: "Apple Mail" })).getByText("Connected"),
      ).toBeTruthy(),
    );
  });

  it("offers a one-per-machine connector once: then it is listed as connected and disabled", async () => {
    setup("granted");
    await connect("Apple Notes");
    expect(await screen.findByText(/Apple Notes is connected/)).toBeTruthy();
    await userEvent.click(await screen.findByRole("button", { name: "Connect an account" }));
    const option = within(screen.getByLabelText("Account type")).getByRole("option", {
      name: "Apple Notes (connected)",
    }) as HTMLOptionElement;
    expect(option.disabled).toBe(true);
  });
});
