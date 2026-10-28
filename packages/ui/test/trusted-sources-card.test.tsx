import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { GatewayProvider, GatewayStore } from "../src/data/index.ts";
import { MockGateway } from "../src/data/mock-gateway.ts";
import { appleConnectors, createFixtureWorld, FIXTURE_NOW, IDS } from "../src/fixtures/index.ts";
import { ConnectorsSection } from "../src/screens/settings/ConnectorsSection.tsx";
import { UiSlotsProvider } from "../src/slots.tsx";

const NOW = Date.parse(FIXTURE_NOW);

function setup(config: Record<string, unknown> = {}) {
  const world = createFixtureWorld();
  world.connectors = appleConnectors().map((c) =>
    c.type === "apple:reminders" ? { ...c, config } : c,
  );
  const gateway = new MockGateway(world, { now: () => FIXTURE_NOW });
  const store = new GatewayStore(gateway, { now: () => FIXTURE_NOW });
  render(
    <GatewayProvider client={gateway} store={store}>
      <UiSlotsProvider value={{ persona: { name: "Wren", creature: "moth" } }}>
        <ConnectorsSection now={NOW} />
      </UiSlotsProvider>
    </GatewayProvider>,
  );
  const params = (method: string) =>
    gateway.calls.filter((c) => c.method === method).map((c) => c.params);
  return { params };
}

describe("Mine — treat as trusted (security §3.6)", () => {
  it("lists the Reminders lists from the helper with a default-off toggle and the explanation", async () => {
    const { params } = setup();
    const list = await screen.findByRole("list", { name: "Your Reminders lists" });
    expect(params("nodes.invoke")).toContainEqual({
      nodeId: IDS.nodes.macHelper,
      capability: "reminders.list_lists",
      params: {},
    });
    const home = within(within(list).getByRole("group", { name: "Home" }));
    expect(
      home.getByRole("switch", { name: "Mine — treat as trusted" }).getAttribute("aria-checked"),
    ).toBe("false");
    expect(
      screen.getAllByText(
        "Reading from it won't make the chat ask again. Only turn this on for lists no one else can edit.",
      ).length,
    ).toBeGreaterThan(0);
  });

  it("saves the owner's choice on the connector", async () => {
    const { params } = setup();
    const list = await screen.findByRole("list", { name: "Your Reminders lists" });
    await userEvent.click(
      within(within(list).getByRole("group", { name: "Home" })).getByRole("switch"),
    );
    await waitFor(() =>
      expect(params("connectors.configure")).toContainEqual({
        connectorId: IDS.connectors.appleReminders,
        config: { trustedSources: ["L-HOME"] },
      }),
    );
  });

  it("shows a shared list as Shared and cannot turn it on", async () => {
    const { params } = setup({ trustedSources: ["L-FAMILY"] });
    const list = await screen.findByRole("list", { name: "Your Reminders lists" });
    const family = within(list).getByRole("group", { name: "Family (shared)" });
    expect(within(family).getByText("Shared")).toBeTruthy();
    const toggle = within(family).getByRole("switch");
    expect(toggle.hasAttribute("disabled") || toggle.getAttribute("aria-disabled") === "true").toBe(
      true,
    );
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    await userEvent.click(toggle);
    expect(params("connectors.configure")).toEqual([]);
  });

  it("lists the calendars too", async () => {
    setup();
    expect(await screen.findByRole("list", { name: "Your calendars" })).toBeTruthy();
  });
});
