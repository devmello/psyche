import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { MockGateway } from "../src/data/mock-gateway.ts";
import { FIXTURE_NOW } from "../src/fixtures/index.ts";
import { type ConnectorsView, offeredCatalog } from "../src/screens/settings/ConnectorsSection.tsx";
import { serverId, splitCommand, toServerInput } from "../src/screens/settings/mcp-input.ts";
import { SettingsScreen, type SettingsSectionId } from "../src/screens/settings/SettingsScreen.tsx";
import { parseSettingsRoute } from "../src/screens/settings/settings-route.ts";
import { StoryWorld } from "../src/stories/harness.tsx";

/** #529: MCP servers inside Settings → Connectors (probe, trust card, add, remove) and the catalog rows. */

function setup(section: SettingsSectionId, connectorsView?: ConnectorsView): () => MockGateway {
  let gw: MockGateway | null = null;
  render(
    <StoryWorld onGateway={(g) => (gw = g)}>
      <SettingsScreen
        now={Date.parse(FIXTURE_NOW)}
        defaultSection={section}
        {...(connectorsView === undefined ? {} : { connectorsView })}
      />
    </StoryWorld>,
  );
  return () => {
    if (gw === null) throw new Error("gateway not ready");
    return gw;
  };
}

const methods = (g: MockGateway) => g.calls.map((c) => c.method);

describe("MCP server input", () => {
  it("splits a command without a shell, derives an id and keeps domains", () => {
    expect(splitCommand(`npx -y @scope/server --root "My Files" 'a b'`)).toEqual([
      "npx",
      "-y",
      "@scope/server",
      "--root",
      "My Files",
      "a b",
    ]);
    expect(serverId("My Files!")).toBe("my-files");
    expect(serverId("1")).toBe("mcp-1");
    expect(
      toServerInput({
        name: "Files",
        kind: "command",
        command: "npx -y files",
        url: "",
        domains: "api.example.com, cdn.example.com",
      }),
    ).toEqual({
      id: "files",
      name: "Files",
      transport: { kind: "stdio", command: ["npx", "-y", "files"] },
      allowedDomains: ["api.example.com", "cdn.example.com"],
    });
  });
});

describe("connector catalog (#529)", () => {
  it("offers only what the Gateway implements, plus the Custom MCP server and Slack rows", () => {
    const types = (rows: readonly { type: string }[]) => rows.map((r) => r.type);
    expect(types(offeredCatalog(new Set(["google", "apple:notes"])))).toEqual([
      "google",
      "apple:notes",
      "mcp",
      "slack",
    ]);
    // Onboarding: real connectors only.
    expect(types(offeredCatalog(new Set(["google"]), { navigation: false }))).toEqual(["google"]);
  });
});

describe("old MCP route", () => {
  it("redirects /settings/mcp to Connectors with the MCP servers showing", () => {
    expect(parseSettingsRoute("/settings/mcp")).toEqual({ section: "connectors", view: "mcp" });
    expect(parseSettingsRoute("/settings/connectors/add-mcp")).toEqual({
      section: "connectors",
      view: "add-mcp",
    });
    expect(parseSettingsRoute("/settings/connectors")).toEqual({ section: "connectors" });
  });

  it("has no MCP section in the nav", () => {
    setup("connectors");
    const nav = screen.getByRole("navigation", { name: "Settings sections" });
    expect(within(nav).queryByRole("button", { name: /MCP/ })).toBeNull();
  });

  it("opens Connectors on the MCP filter, listing only MCP servers", async () => {
    setup("connectors", "mcp");
    const notion = await screen.findByRole("article", { name: "Notion" });
    expect(within(notion).getByText("MCP")).toBeTruthy();
    expect(screen.getByRole("radio", { name: "MCP servers" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(screen.queryByRole("article", { name: /Gmail|Google/ })).toBeNull();
  });
});

describe("Connectors → Custom MCP server", () => {
  it("checks a command server, shows the trust card, and adds it once approved", async () => {
    const gateway = setup("connectors", "add-mcp");
    await userEvent.type(await screen.findByLabelText("Name"), "Files");
    await userEvent.type(screen.getAllByLabelText("Command").at(-1) as HTMLElement, "npx -y files");
    await userEvent.click(screen.getByRole("button", { name: "Check server" }));

    const card = await screen.findByTestId("mcp-trust-card");
    expect(within(card).getByText("Sandboxed on this computer")).toBeTruthy();
    expect(within(card).getByText("No network")).toBeTruthy();
    expect(within(card).getByText(/2 tools · 1 read, 1 change things/)).toBeTruthy();
    // Tool names are one level down.
    const tools = within(card).getByText("See the 2 tools").closest("details") as HTMLElement;
    expect(within(tools).getByText("write_file")).toBeTruthy();
    expect(methods(gateway())).toContain("mcp.probe");
    expect(methods(gateway())).not.toContain("mcp.add");
    expect(gateway().calls.find((c) => c.method === "mcp.probe")?.params).toMatchObject({
      server: { id: "files", transport: { kind: "stdio", command: ["npx", "-y", "files"] } },
    });

    await userEvent.click(await within(card).findByText("Allow once", { exact: true }));
    const allow = within(card).getByRole("button", { name: "Allow with scope" });
    await waitFor(() => expect((allow as HTMLButtonElement).disabled).toBe(false));
    await userEvent.click(allow);

    expect(await screen.findByText("Added Files.")).toBeTruthy();
    expect(methods(gateway())).toContain("mcp.add");
    // The new server is a row like any connector: name, status, MCP and trust badges.
    const row = await screen.findByRole("article", { name: "Files" });
    expect(within(row).getByText("Connected")).toBeTruthy();
    expect(within(row).getByText("MCP")).toBeTruthy();
    expect(within(row).getByText("Trust: unverified")).toBeTruthy();
  });

  it("is a row of the Add connector form", async () => {
    const gateway = setup("connectors");
    await waitFor(async () => {
      await userEvent.click(
        screen.getAllByRole("button", { name: "Add connector" })[0] as HTMLElement,
      );
      expect(screen.getByRole("searchbox", { name: "Search connectors" })).toBeTruthy();
    });
    await userEvent.click(screen.getByRole("button", { name: /Custom MCP server/ }));
    expect(screen.getByRole("button", { name: "Check server" })).toBeTruthy();
    expect(methods(gateway())).not.toContain("mcp.probe");
  });
});
