import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { GatewayProvider, GatewayStore } from "../src/data/index.ts";
import { MockGateway } from "../src/data/mock-gateway.ts";
import {
  appleShortcuts,
  createFixtureWorld,
  FIXTURE_NOW,
  type FixtureWorld,
  IDS,
  shortcutsAndObsidian,
} from "../src/fixtures/index.ts";
import { ShortcutsCard } from "../src/screens/settings/ConnectorSettingsCards.tsx";
import { ConnectorsSection } from "../src/screens/settings/ConnectorsSection.tsx";
import { UiSlotsProvider } from "../src/slots.tsx";

const NOW = Date.parse(FIXTURE_NOW);

function setup(edit: (w: FixtureWorld) => void = () => {}) {
  const world = createFixtureWorld();
  world.connectors = shortcutsAndObsidian();
  edit(world);
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
  return { gateway, params };
}

describe("the Shortcuts card (docs/connectors/apple-apps-2026.md §7.1, #640)", () => {
  it("lists the owner's shortcuts from the helper, each off / ask / allow", async () => {
    const { params } = setup();
    const list = await screen.findByRole("list", { name: "Your shortcuts" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows.map((r) => r.getAttribute("data-rule"))).toEqual(["ask", "allow", "off"]);
    expect(params("nodes.invoke")).toContainEqual({
      nodeId: IDS.nodes.macHelper,
      capability: "shortcuts.list",
      params: {},
    });
    await userEvent.click(within(list).getByRole("radio", { name: "Arrive at office: Off" }));
    await waitFor(() =>
      expect(params("connectors.configure")).toContainEqual({
        connectorId: IDS.connectors.appleShortcuts,
        config: { shortcutRules: { "SC-ORDER": "off", "SC-LOG": "allow", "SC-ARRIVE": "off" } },
      }),
    );
    await waitFor(() =>
      expect(within(list).getAllByRole("listitem")[0]?.getAttribute("data-rule")).toBe("off"),
    );
    // No Psyche Actions ship yet: that section stays out.
    expect(screen.queryByText("Psyche Actions")).toBeNull();
  });

  it("says the helper is needed when no Mac is paired", async () => {
    setup((w) => {
      w.nodes = [];
    });
    expect(await screen.findByText(/Open Psyche on your Mac to list your shortcuts/)).toBeTruthy();
  });

  it("shows which Psyche Actions are installed and installs the rest", async () => {
    const onInstall = vi.fn();
    const [connector] = shortcutsAndObsidian();
    if (connector === undefined) throw new Error("fixture");
    render(
      <ShortcutsCard
        connector={connector}
        shortcuts={[
          ...appleShortcuts(),
          {
            id: "PA-1",
            name: "Psyche: Get Focus",
            folder: null,
            acceptsInput: false,
            actionCount: 1,
          },
        ]}
        psycheActions={[
          { id: "focus", name: "Psyche: Get Focus", installUrl: "https://example.test/focus" },
          { id: "timer", name: "Psyche: Start Timer", installUrl: "https://example.test/timer" },
        ]}
        onInstall={onInstall}
      />,
    );
    const actions = screen.getByRole("list", { name: "Psyche Actions" });
    expect(within(actions).getByText("Installed")).toBeTruthy();
    await userEvent.click(
      within(actions).getByRole("button", { name: "Install Psyche: Start Timer" }),
    );
    expect(onInstall).toHaveBeenCalledWith(expect.objectContaining({ id: "timer" }));
  });
});

describe("the Obsidian card (#640)", () => {
  it("shows the vault and saves the daily-note folder", async () => {
    const { params } = setup();
    const card = await screen.findByRole("article", { name: "Obsidian" });
    expect(within(card).getByText("/Users/you/Notes/Vault")).toBeTruthy();
    const daily = within(card).getByLabelText("Daily notes folder") as HTMLInputElement;
    expect(daily.value).toBe("Daily");
    await userEvent.clear(daily);
    await userEvent.type(daily, "Journal{Enter}");
    await waitFor(() =>
      expect(params("connectors.configure")).toContainEqual({
        connectorId: IDS.connectors.obsidian,
        config: { dailyFolder: "Journal" },
      }),
    );
  });

  it("changes the vault through File access: share the folder, then use it", async () => {
    const { params } = setup();
    const card = await screen.findByRole("article", { name: "Obsidian" });
    await userEvent.click(within(card).getByRole("button", { name: "Change vault…" }));
    await userEvent.type(within(card).getByLabelText("New vault folder"), "/Users/you/Work Vault");
    const use = within(card).getByRole("button", { name: "Use this vault" }) as HTMLButtonElement;
    expect(use.disabled).toBe(true);
    await userEvent.click(within(card).getByRole("button", { name: "Share this folder" }));
    await waitFor(() =>
      expect(params("settings.set")).toContainEqual({
        key: "permissions.policy",
        value: expect.objectContaining({
          folders: expect.arrayContaining([{ path: "/Users/you/Work Vault", mode: "rw" }]),
        }),
      }),
    );
    await waitFor(() => expect(use.disabled).toBe(false));
    await userEvent.click(use);
    await waitFor(() =>
      expect(params("connectors.configure")).toContainEqual({
        connectorId: IDS.connectors.obsidian,
        config: { vaultPath: "/Users/you/Work Vault" },
      }),
    );
  });

  it("connects only once a shared vault folder is given", async () => {
    const { params } = setup((w) => {
      w.connectors = [];
    });
    await waitFor(async () => {
      await userEvent.click(
        screen.getAllByRole("button", { name: "Add connector" })[0] as HTMLElement,
      );
      expect(screen.getByRole("searchbox", { name: "Search connectors" })).toBeTruthy();
    });
    await userEvent.click(screen.getByRole("button", { name: /Obsidian/ }));
    const go = screen.getByRole("button", { name: "Continue to sign in" }) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    await userEvent.type(screen.getByLabelText("Vault folder"), "/Users/you/Vault");
    await userEvent.click(screen.getByRole("button", { name: "Share this folder" }));
    await waitFor(() => expect(go.disabled).toBe(false));
    await userEvent.click(go);
    await waitFor(() =>
      expect(params("connectors.connect")).toContainEqual(
        expect.objectContaining({ scopeMode: "read", config: { vaultPath: "/Users/you/Vault" } }),
      ),
    );
    // Read only: the vault is shared read-only.
    expect(params("settings.set")).toContainEqual({
      key: "permissions.policy",
      value: expect.objectContaining({
        folders: expect.arrayContaining([{ path: "/Users/you/Vault", mode: "ro" }]),
      }),
    });
  });
});
