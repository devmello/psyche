import { act, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { MockGateway } from "../src/data/mock-gateway.ts";
import { ConnectorsSection } from "../src/screens/settings/ConnectorsSection.tsx";
import { StoryWorld } from "../src/stories/harness.tsx";

/** #549: Apple connectors wait on the macOS grant, and one-per-machine types are offered once. */

function setup(grant: "granted" | "denied" | "notDetermined") {
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
      screen.getAllByRole("button", { name: "Add connector" })[0] as HTMLElement,
    );
    expect(screen.getByLabelText("Connector type")).toBeTruthy();
  });
  await userEvent.selectOptions(screen.getByLabelText("Connector type"), label);
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

  it("when macOS has not asked yet: no System Settings, the helper's reason, and Check again asks (#570)", async () => {
    const gateway = setup("notDetermined");
    await connect("Apple Mail");
    const card = await screen.findByTestId("connect-needs-permission");
    expect(within(card).getByText(/macOS has not asked you yet/)).toBeTruthy();
    expect(
      within(card).getByText('macOS did not show a prompt: macOS answered "denied"'),
    ).toBeTruthy();
    expect(within(card).queryByRole("button", { name: "Open System Settings" })).toBeNull();

    act(() => {
      gateway().world.appleGrant = "granted";
    });
    await userEvent.click(within(card).getByRole("button", { name: "Check again" }));
    expect(await screen.findByText(/Apple Mail is connected as This Mac\./)).toBeTruthy();
    // Check again went through connect with the check action, which is what asks macOS.
    const retry = gateway()
      .calls.filter((c) => c.method === "connectors.connect")
      .at(-1)?.params as { config?: unknown; connectorId?: string };
    expect(retry.config).toEqual({ permissionAction: "check" });
    expect(retry.connectorId).toBeTruthy();
  });

  it("offers a one-per-machine connector once: then it is listed as connected and disabled", async () => {
    setup("granted");
    await connect("Apple Notes");
    expect(await screen.findByText(/Apple Notes is connected/)).toBeTruthy();
    await userEvent.click(await screen.findByRole("button", { name: "Add connector" }));
    const option = within(screen.getByLabelText("Connector type")).getByRole("option", {
      name: "Apple Notes (connected)",
    }) as HTMLOptionElement;
    expect(option.disabled).toBe(true);
  });
});
