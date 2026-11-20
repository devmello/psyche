import { validateParams } from "@psyche/protocol";
import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { MockGateway } from "../src/data/mock-gateway.ts";
import { FIXTURE_NOW } from "../src/fixtures/index.ts";
import { type McpPreset, presetServer } from "../src/screens/settings/mcp-preset-build.ts";
import { MCP_PRESETS } from "../src/screens/settings/mcp-presets.ts";
import { SettingsScreen } from "../src/screens/settings/SettingsScreen.tsx";
import { StoryWorld } from "../src/stories/harness.tsx";

/** Service presets (Dropbox, Figma, Asana, Zoom, Notion, Linear, Shopify) and the directory. */

const SERVICE_PRESETS = {
  dropbox: "https://mcp.dropbox.com/mcp",
  figma: "https://mcp.figma.com/mcp",
  asana: "https://mcp.asana.com/v2/mcp",
  zoom: "https://zoom.us/mcp/meeting/streamable",
  notion: "https://mcp.notion.com/mcp",
  linear: "https://mcp.linear.app/mcp",
} as const;

function setup(): () => MockGateway {
  let gw: MockGateway | null = null;
  render(
    <StoryWorld onGateway={(g) => (gw = g)}>
      <SettingsScreen now={Date.parse(FIXTURE_NOW)} defaultSection="connectors" />
    </StoryWorld>,
  );
  return () => {
    if (gw === null) throw new Error("gateway not ready");
    return gw;
  };
}

async function openDirectory() {
  await waitFor(async () => {
    await userEvent.click(
      screen.getAllByRole("button", { name: "Add connector" })[0] as HTMLElement,
    );
    expect(screen.getByRole("searchbox", { name: "Search connectors" })).toBeTruthy();
  });
}

describe("service presets", () => {
  it("use the vendor's own address, sign in by OAuth and grant no tools up front", () => {
    for (const [id, url] of Object.entries(SERVICE_PRESETS)) {
      const p = MCP_PRESETS.find((x) => x.id === id) as McpPreset;
      expect(p, id).toBeTruthy();
      expect(p.official, id).toBe(true);
      expect(p.transport, id).toEqual({ kind: "http", url, auth: "oauth" });
      const { input } = presetServer(p, {}, "ab12");
      // Only an address: a preset carries no tool allowlist and no pre-approval.
      expect(Object.keys(input).sort(), id).toEqual(["id", "name", "transport"]);
      expect(() => validateParams("mcp.probe", { server: input }), id).not.toThrow();
    }
    const shopify = MCP_PRESETS.find((x) => x.id === "shopify-dev") as McpPreset;
    expect(shopify.transport).toMatchObject({
      kind: "stdio",
      command: ["npx", "-y", "@shopify/dev-mcp@latest"],
    });
  });

  it("leave out services with no verifiable official server", () => {
    const ids = MCP_PRESETS.map((p) => p.id);
    for (const skipped of ["canva", "quickbooks", "spotify", "opentable", "slack"]) {
      expect(ids).not.toContain(skipped);
    }
  });
});

describe("Browse connectors directory", () => {
  it("filters by name and keyword", async () => {
    setup();
    await openDirectory();
    const search = screen.getByRole("searchbox", { name: "Search connectors" });
    await userEvent.type(search, "dropbox");
    expect(screen.getByRole("button", { name: /Dropbox/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /GitHub/ })).toBeNull();
    await userEvent.clear(search);
    await userEvent.type(search, "design");
    expect(screen.getByRole("button", { name: /Figma/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Dropbox/ })).toBeNull();
  });

  it("starts the existing add flow for the chosen preset and saves nothing before approval", async () => {
    const gateway = setup();
    await openDirectory();
    await userEvent.type(screen.getByRole("searchbox", { name: "Search connectors" }), "dropbox");
    await userEvent.click(screen.getByRole("button", { name: /Dropbox/ }));
    await userEvent.click(screen.getByRole("button", { name: "Check server" }));
    await screen.findByTestId("mcp-trust-card");
    const calls = gateway().calls;
    expect(calls.find((c) => c.method === "mcp.probe")?.params).toMatchObject({
      server: { id: "dropbox", transport: { kind: "http", url: "https://mcp.dropbox.com/mcp" } },
    });
    expect(calls.map((c) => c.method)).not.toContain("mcp.add");
  });
});
