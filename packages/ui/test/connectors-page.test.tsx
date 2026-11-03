import { render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { createFixtureWorld, FIXTURE_NOW, IDS } from "../src/fixtures/index.ts";
import { ConnectorsPanel } from "../src/screens/settings/ConnectorsSection.tsx";
import type { McpState } from "../src/screens/settings/use-mcp.tsx";
import { StoryWorld } from "../src/stories/harness.tsx";

/** The Connectors page: what works, what needs the owner, what is on this Mac, what can be added. */

const NOW = Date.parse(FIXTURE_NOW);
const noop = () => {};

const servers: McpState["servers"] = [
  {
    id: "files",
    name: "Files",
    trust: "unknown",
    transport: "stdio",
    network: false,
    connected: true,
  },
  {
    id: "linear",
    name: "Linear",
    trust: "verified",
    transport: "http",
    network: true,
    connected: false,
  },
];

const mcp = (list: McpState["servers"]): McpState => ({
  servers: list,
  launcher: "srt",
  loading: false,
  error: null,
  reload: noop,
  checking: false,
  actionError: null,
  actionFailure: null,
  notice: null,
  review: null,
  check: noop,
  remove: noop,
  setEnabled: noop,
});

function renderPage(props: Partial<Parameters<typeof ConnectorsPanel>[0]> = {}) {
  const world = createFixtureWorld();
  render(
    <StoryWorld>
      <ConnectorsPanel
        persona="Wren"
        now={NOW}
        connectors={world.connectors}
        mcp={mcp(servers)}
        onConnect={noop}
        onReconnect={noop}
        onDisconnect={noop}
        onRemove={noop}
        policy={{ values: {}, onChange: noop }}
        onOpenSection={noop}
        {...props}
      />
    </StoryWorld>,
  );
}

const group = (name: string) => screen.getByRole("region", { name });

describe("Connectors page", () => {
  it("sorts rows into what needs you, what is connected and what is on this Mac", () => {
    renderPage();
    const needs = within(group("Needs you"));
    // A sign-in that ran out and a server that did not start, each with its one fix.
    expect(needs.getByRole("article", { name: /^Outlook/ })).toBeTruthy();
    expect(needs.getByRole("button", { name: /^Sign in again/ })).toBeTruthy();
    expect(needs.getByRole("article", { name: "Linear" })).toBeTruthy();
    expect(needs.getByRole("button", { name: /^See why/ })).toBeTruthy();

    const connected = within(group("Connected"));
    expect(connected.getByRole("article", { name: "Gmail" })).toBeTruthy();
    expect(connected.getByRole("article", { name: "Files" })).toBeTruthy();
    expect(connected.queryByRole("article", { name: "Linear" })).toBeNull();

    const mac = within(group("On this Mac"));
    expect(mac.getByRole("article", { name: "Files on this Mac" })).toBeTruthy();
    expect(mac.getByRole("article", { name: "Terminal" })).toBeTruthy();
  });

  it("keeps protocol words off the list and your own servers under Advanced", () => {
    renderPage();
    expect(screen.queryByText("MCP")).toBeNull();
    const advanced = screen.getByText("Advanced").closest("details") as HTMLDetailsElement;
    expect(advanced.open).toBe(false);
  });

  it("opens a row's detail with the reason it failed, and goes back to the list", async () => {
    renderPage();
    await userEvent.click(screen.getByRole("button", { name: "Open Linear" }));
    const view = screen.getByRole("region", { name: "Linear" });
    expect(within(view).getByText(/Linear didn't start/)).toBeTruthy();
    expect(within(view).getByText(/Check its command or address/)).toBeTruthy();
    // Technical details stay closed until asked for.
    expect(within(view).queryByText("linear")).toBeNull();
    await userEvent.click(within(view).getByRole("button", { name: "Technical details" }));
    expect(within(view).getByText("linear")).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "All connectors" }));
    expect(group("Needs you")).toBeTruthy();
  });

  it("shows the sign-in notice in the detail, and Sign in again reconnects", async () => {
    const onReconnect = vi.fn();
    renderPage({ onReconnect });
    await userEvent.click(screen.getByRole("button", { name: /^Open Outlook/ }));
    const view = screen.getByRole("region", { name: /^Outlook/ });
    expect(within(view).getByText(/sign-in with Outlook.* ran out/)).toBeTruthy();
    await userEvent.click(within(view).getByRole("button", { name: "Sign in again" }));
    expect(onReconnect).toHaveBeenCalledWith(
      expect.objectContaining({ id: IDS.connectors.outlook }),
    );
  });

  it("opens Files and Terminal from the Mac rows", async () => {
    const onOpenSection = vi.fn();
    renderPage({ onOpenSection });
    await userEvent.click(screen.getByRole("button", { name: "Open Terminal" }));
    await userEvent.click(screen.getByRole("button", { name: "Open Access" }));
    expect(onOpenSection).toHaveBeenCalledWith("files");
  });

  it("offers a few things to add, and the whole gallery separately", async () => {
    renderPage();
    const more = within(group("Add more"));
    expect(more.getAllByRole("button").length).toBeGreaterThan(1);
    await userEvent.click(more.getByRole("button", { name: "Browse all" }));
    expect(screen.getByRole("searchbox", { name: "Search connectors" })).toBeTruthy();
    // The gallery replaces the list.
    expect(screen.queryByRole("region", { name: "Needs you" })).toBeNull();
  });

  it("gives an empty page one primary action", () => {
    renderPage({ connectors: [], mcp: mcp([]) });
    expect(screen.getAllByRole("button", { name: "Add connector" })).toHaveLength(1);
    expect(screen.queryByRole("region", { name: "Needs you" })).toBeNull();
  });
});
