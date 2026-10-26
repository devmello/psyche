import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { MockGateway } from "../src/data/mock-gateway.ts";
import { FIXTURE_NOW } from "../src/fixtures/index.ts";
import type { ConnectorsView } from "../src/screens/settings/ConnectorsSection.tsx";
import { toServerInput } from "../src/screens/settings/mcp-input.ts";
import { joinCommand, parseMcpJson, withImported } from "../src/screens/settings/mcp-json.ts";
import { SettingsScreen } from "../src/screens/settings/SettingsScreen.tsx";
import { StoryWorld } from "../src/stories/harness.tsx";

/** A server's detail (tools, secrets, danger zone) and the Add form's paste-JSON path. */

function setup(view: ConnectorsView, seed?: (g: MockGateway) => void): () => MockGateway {
  let gw: MockGateway | null = null;
  render(
    <StoryWorld
      onGateway={(g) => {
        gw = g;
        seed?.(g);
      }}
    >
      <SettingsScreen
        now={Date.parse(FIXTURE_NOW)}
        defaultSection="connectors"
        connectorsView={view}
      />
    </StoryWorld>,
  );
  return () => {
    if (gw === null) throw new Error("gateway not ready");
    return gw;
  };
}

const methods = (g: MockGateway) => g.calls.map((c) => c.method);
const lastCall = (g: MockGateway, method: string) =>
  g.calls.filter((c) => c.method === method).at(-1);

const FILES = {
  id: "files",
  name: "Files",
  trust: "unknown" as const,
  transport: "stdio" as const,
  network: false,
  connected: true,
};
const seedFiles = (g: MockGateway) =>
  g.seedMcpServer(FILES, {
    tools: [
      {
        name: "search_files",
        description: "Search by name.",
        sideEffect: "read",
        enabled: true,
        blocked: false,
      },
      {
        name: "write_file",
        description: "Write a file.",
        sideEffect: "write",
        enabled: true,
        blocked: false,
      },
      { name: "lookup", description: "Hidden markup.", enabled: true, blocked: true },
    ],
    secrets: [
      { name: "API_KEY", storage: "vault", isSet: true },
      { name: "LEGACY", storage: "config", isSet: true },
    ],
  });

async function openDetails(name = "Files") {
  const row = await screen.findByRole("article", { name });
  await userEvent.click(within(row).getByRole("button", { name: `More for ${name}` }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Show details" }));
  return row;
}

describe("MCP server detail → Tools", () => {
  it("lists the tools and switches one off for the agent", async () => {
    const gateway = setup("mcp", seedFiles);
    const row = await openDetails();
    const tools = await within(row).findByRole("heading", { name: "Tools" });
    const group = tools.closest("section") as HTMLElement;
    expect(await within(group).findByText("search_files")).toBeTruthy();
    expect(within(group).getByText("Reads")).toBeTruthy();
    expect(within(group).getByText("Changes things")).toBeTruthy();
    // A blocked tool is off whatever the owner says, and its switch cannot be turned on.
    expect(within(group).getByText("Off: suspicious description")).toBeTruthy();
    const lookup = within(group).getByRole("switch", { name: "lookup" });
    expect(lookup.getAttribute("aria-checked")).toBe("false");
    expect(lookup.hasAttribute("disabled") || lookup.getAttribute("data-disabled") !== null).toBe(
      true,
    );

    const write = within(group).getByRole("switch", { name: "write_file" });
    expect(write.getAttribute("aria-checked")).toBe("true");
    await userEvent.click(write);
    await waitFor(() =>
      expect(
        within(group).getByRole("switch", { name: "write_file" }).getAttribute("aria-checked"),
      ).toBe("false"),
    );
    expect(lastCall(gateway(), "mcp.tools.set")?.params).toEqual({
      serverId: "files",
      tool: "write_file",
      enabled: false,
    });
    expect(within(group).getByText(/2 tools are kept from Psyche/)).toBeTruthy();
  });
});

describe("MCP server detail → Secrets", () => {
  it("shows set or not set by name and replaces a value without showing it", async () => {
    const gateway = setup("mcp", seedFiles);
    const row = await openDetails();
    const heading = await within(row).findByRole("heading", { name: "Secrets" });
    const group = heading.closest("section") as HTMLElement;
    expect(await within(group).findByText("API_KEY")).toBeTruthy();
    expect(
      within(group).getByText(
        "Kept in the server's settings, not the vault. Replacing it moves it to the vault.",
      ),
    ).toBeTruthy();
    expect(within(group).getAllByText("Set")).toHaveLength(2);

    await userEvent.click(within(group).getByRole("button", { name: "Replace API_KEY" }));
    const input = within(group).getByLabelText("New value for API_KEY") as HTMLInputElement;
    expect(input.type).toBe("password");
    await userEvent.type(input, "s3cret-value");
    await userEvent.click(within(group).getByRole("button", { name: "Save" }));

    expect(await within(group).findByText(/API_KEY was replaced/)).toBeTruthy();
    expect(lastCall(gateway(), "mcp.secrets.replace")?.params).toEqual({
      serverId: "files",
      name: "API_KEY",
      value: "s3cret-value",
    });
    // The value is not on screen, and the field closed.
    expect(document.body.textContent).not.toContain("s3cret-value");
    expect(within(group).queryByLabelText("New value for API_KEY")).toBeNull();
  });
});

describe("MCP server detail → Danger zone", () => {
  it("turns a server off and on without removing it", async () => {
    const gateway = setup("mcp", seedFiles);
    const row = await openDetails();
    const zone = (await within(row).findByRole("heading", { name: "Danger zone" })).closest(
      "section",
    ) as HTMLElement;
    await userEvent.click(within(zone).getByRole("button", { name: "Turn off" }));
    expect(await screen.findByText("Files is off.")).toBeTruthy();
    expect(lastCall(gateway(), "mcp.setEnabled")?.params).toEqual({
      serverId: "files",
      enabled: false,
    });
    expect(methods(gateway())).not.toContain("mcp.remove");
    await waitFor(() => expect(within(row).getByText("Off")).toBeTruthy());
    expect(
      await within(row).findByText("This server is off. Turn it on to see its tools."),
    ).toBeTruthy();

    await userEvent.click(within(zone).getByRole("button", { name: "Turn on" }));
    await waitFor(() => expect(within(row).getByText("Connected")).toBeTruthy());
    expect(lastCall(gateway(), "mcp.setEnabled")?.params).toEqual({
      serverId: "files",
      enabled: true,
    });
  });

  it("removes a server only after a confirmation", async () => {
    const gateway = setup("mcp", seedFiles);
    const row = await openDetails();
    const zone = (await within(row).findByRole("heading", { name: "Danger zone" })).closest(
      "section",
    ) as HTMLElement;
    await userEvent.click(within(zone).getByRole("button", { name: "Remove" }));
    expect(methods(gateway())).not.toContain("mcp.remove");
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Remove Files?")).toBeTruthy();
    await userEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    expect(await screen.findByText("Removed Files.")).toBeTruthy();
    expect(lastCall(gateway(), "mcp.remove")?.params).toEqual({ serverId: "files" });
  });
});

describe("pasting a server's JSON", () => {
  const JSON_TEXT = JSON.stringify({
    mcpServers: {
      brave: {
        command: "npx",
        args: ["-y", "@brave/brave-search-mcp-server", "--transport", "stdio"],
        env: { BRAVE_API_KEY: "BSA-very-secret", LOG_LEVEL: "debug" },
      },
    },
  });

  it("parses the common formats and keeps secrets apart from plain config", () => {
    const r = parseMcpJson(JSON_TEXT);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const s = r.servers[0];
    expect(s?.name).toBe("brave");
    expect(s?.draft).toMatchObject({
      kind: "command",
      command: "npx -y @brave/brave-search-mcp-server --transport stdio",
    });
    expect(s?.env).toEqual({ LOG_LEVEL: "debug" });
    expect(s?.secrets).toEqual([
      { name: "BRAVE_API_KEY", value: "BSA-very-secret", bearer: false },
    ]);

    const { input, secrets } = withImported(
      toServerInput(s?.draft ?? ({} as never)),
      s as never,
      "ab12",
    );
    // The config holds a placeholder and the plain value, never the key.
    expect(JSON.stringify(input)).not.toContain("BSA-very-secret");
    expect(input.transport).toMatchObject({
      kind: "stdio",
      env: { LOG_LEVEL: "debug", BRAVE_API_KEY: "{{cred:mcp-brave-brave-api-key-ab12}}" },
    });
    expect(secrets).toEqual([
      expect.objectContaining({ slug: "mcp-brave-brave-api-key-ab12", token: "BSA-very-secret" }),
    ]);
  });

  it("reads a remote server's bearer header, a bare server and several servers", () => {
    const remote = parseMcpJson(
      JSON.stringify({
        mcpServers: {
          linear: {
            url: "https://mcp.linear.app/mcp",
            headers: { Authorization: "Bearer lin_api_abc", "X-Other": "1" },
          },
          local: { command: "uvx mcp-server-time" },
        },
      }),
    );
    expect(remote.ok && remote.servers.map((s) => s.name)).toEqual(["linear", "local"]);
    if (!remote.ok) return;
    const [linear] = remote.servers;
    expect(linear?.draft).toMatchObject({ kind: "url", url: "https://mcp.linear.app/mcp" });
    expect(linear?.secrets).toEqual([
      { name: "Authorization", value: "lin_api_abc", bearer: true },
    ]);
    expect(linear?.ignored).toEqual(["X-Other"]);
    const out = withImported(toServerInput(linear?.draft ?? ({} as never)), linear as never, "zz");
    expect(out.input.transport).toMatchObject({
      kind: "http",
      auth: { kind: "bearer", credential: "{{cred:mcp-linear-authorization-zz}}" },
    });
    expect(out.secrets[0]).toMatchObject({
      token: "lin_api_abc",
      header: { name: "Authorization" },
    });

    const bare = parseMcpJson(
      JSON.stringify({ name: "Time", command: "uvx", args: ["mcp-server-time"] }),
    );
    expect(bare.ok && bare.servers[0]?.draft.command).toBe("uvx mcp-server-time");
  });

  it("refuses what is not a server, with a reason", () => {
    expect(parseMcpJson("  ")).toEqual({ ok: false, reason: "empty" });
    expect(parseMcpJson("{nope")).toEqual({ ok: false, reason: "invalid" });
    expect(parseMcpJson("[1]")).toEqual({ ok: false, reason: "shape" });
    expect(parseMcpJson('{"mcpServers": {"a": {"cwd": "/"}}}')).toEqual({
      ok: false,
      reason: "noServers",
    });
  });

  it("quotes words with spaces so the command line reads back the same", () => {
    expect(joinCommand(["npx", "-y", "srv", "--root", "My Files", 'say "hi"'])).toBe(
      `npx -y srv --root "My Files" 'say "hi"'`,
    );
  });

  it("fills the Add form from the JSON, then stores the key in the vault before the probe", async () => {
    const gateway = setup("add-mcp");
    await userEvent.click(await screen.findByRole("button", { name: "Paste JSON" }));
    const box = screen.getByLabelText("Server JSON");
    await userEvent.click(box);
    await userEvent.paste(JSON_TEXT);
    await userEvent.click(screen.getByRole("button", { name: "Fill the form" }));

    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("brave");
    expect((screen.getAllByLabelText("Command").at(-1) as HTMLInputElement).value).toBe(
      "npx -y @brave/brave-search-mcp-server --transport stdio",
    );
    expect(
      screen.getByText(/1 secret from the JSON will go to your vault: BRAVE_API_KEY/),
    ).toBeTruthy();
    expect(document.body.textContent).not.toContain("BSA-very-secret");

    await userEvent.click(screen.getByRole("button", { name: "Check server" }));
    await screen.findByTestId("mcp-trust-card");
    const add = gateway().calls.find((c) => c.method === "vault.add");
    expect(add?.params).toMatchObject({
      kind: "api_key",
      bindings: [{ connector: "mcp:brave" }],
      secret: { token: "BSA-very-secret" },
    });
    const probe = lastCall(gateway(), "mcp.probe");
    expect(JSON.stringify(probe?.params)).not.toContain("BSA-very-secret");
    expect(probe?.params).toMatchObject({
      server: { id: "brave", transport: { kind: "stdio", env: { LOG_LEVEL: "debug" } } },
    });
    expect(methods(gateway()).indexOf("vault.add")).toBeLessThan(
      methods(gateway()).indexOf("mcp.probe"),
    );
  });

  it("says why bad JSON can't fill the form", async () => {
    setup("add-mcp");
    await userEvent.click(await screen.findByRole("button", { name: "Paste JSON" }));
    await userEvent.click(screen.getByLabelText("Server JSON"));
    await userEvent.paste("{nope");
    await userEvent.click(screen.getByRole("button", { name: "Fill the form" }));
    expect((await screen.findByRole("alert")).textContent).toBe("That isn't valid JSON.");
  });
});
