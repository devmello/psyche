import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { MockGateway } from "../src/data/mock-gateway.ts";
import { FIXTURE_NOW } from "../src/fixtures/index.ts";
import { SettingsScreen } from "../src/screens/settings/SettingsScreen.tsx";
import { StoryWorld } from "../src/stories/harness.tsx";

/** Edit a server in place (prefilled Add form, trust card for real changes) and Test connection. */

function setup(seed?: (g: MockGateway) => void): () => MockGateway {
  let gw: MockGateway | null = null;
  render(
    <StoryWorld
      onGateway={(g) => {
        gw = g;
        seedFiles(g);
        seed?.(g);
      }}
    >
      <SettingsScreen
        now={Date.parse(FIXTURE_NOW)}
        defaultSection="connectors"
        connectorsView="mcp"
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

const seedFiles = (g: MockGateway) =>
  g.seedMcpServer(
    {
      id: "files",
      name: "Files",
      trust: "unknown",
      transport: "stdio",
      network: false,
      connected: true,
    },
    {
      tools: [
        { name: "search_files", description: "Search.", enabled: true, blocked: false },
        { name: "read_file", description: "Read.", enabled: true, blocked: false },
        { name: "write_file", description: "Write.", enabled: true, blocked: false },
      ],
      secrets: [
        { name: "API_KEY", storage: "vault", isSet: true },
        { name: "LOG_LEVEL", storage: "config", isSet: true },
      ],
      config: { command: ["npx", "-y", "files"] },
    },
  );

async function openEdit(): Promise<void> {
  await userEvent.click(await screen.findByRole("button", { name: "Open Files" }));
  await userEvent.click(await screen.findByRole("button", { name: "Edit" }));
}

describe("Edit a server", () => {
  it("opens the Add form prefilled, with secrets saved and no value to read", async () => {
    setup();
    await openEdit();
    expect(((await screen.findByLabelText("Name")) as HTMLInputElement).value).toBe("Files");
    expect((screen.getAllByLabelText("Command").at(-1) as HTMLInputElement).value).toBe(
      "npx -y files",
    );
    const values = screen.getAllByLabelText("Value") as HTMLInputElement[];
    expect(values).toHaveLength(2);
    for (const v of values) {
      expect(v.value).toBe("");
      expect(v.placeholder).toBe("Saved");
    }
    // Nothing changed yet: nothing to save.
    expect(
      (screen.getByRole("button", { name: "Save changes" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("a new command shows old and new on the trust card and applies only once approved", async () => {
    const gateway = setup();
    await openEdit();
    const cmd = screen.getAllByLabelText("Command").at(-1) as HTMLElement;
    await userEvent.clear(cmd);
    await userEvent.type(cmd, "npx -y files --root /tmp");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

    const card = await screen.findByTestId("mcp-trust-card");
    const change = within(card).getByTestId("mcp-trust-change");
    expect(within(change).getByText("Was: npx -y files")).toBeTruthy();
    expect(within(change).getByText("Now: npx -y files --root /tmp")).toBeTruthy();
    expect(lastCall(gateway(), "mcp.update")?.params).toEqual({
      id: "files",
      changes: { command: ["npx", "-y", "files", "--root", "/tmp"] },
    });
    // The saved secrets were left alone: nothing was sent for them, no vault write happened.
    expect(methods(gateway())).not.toContain("vault.add");
    expect(methods(gateway())).not.toContain("mcp.add");

    const allow = within(card).getByRole("button", { name: "Allow with scope" });
    await waitFor(() => expect((allow as HTMLButtonElement).disabled).toBe(false));
    await userEvent.click(allow);
    expect(await screen.findByText("Updated Files.")).toBeTruthy();
    expect(methods(gateway())).toContain("mcp.add");
  });

  it("a typed secret goes to the vault, and only its placeholder travels", async () => {
    const gateway = setup();
    await openEdit();
    await userEvent.click(screen.getByRole("button", { name: "Add variable" }));
    const names = screen.getAllByLabelText("Variable name");
    const values = screen.getAllByLabelText("Value");
    await userEvent.type(names.at(-1) as HTMLElement, "NEW_TOKEN");
    await userEvent.type(values.at(-1) as HTMLElement, "tok-very-secret");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByTestId("mcp-trust-card");
    expect(lastCall(gateway(), "vault.add")?.params).toMatchObject({
      bindings: [{ connector: "mcp:files" }],
      secret: { token: "tok-very-secret" },
    });
    const update = JSON.stringify(lastCall(gateway(), "mcp.update")?.params);
    expect(update).not.toContain("tok-very-secret");
    expect(update).toMatch(/\{\{cred:[a-z0-9-]+\}\}/);
    expect(document.body.innerHTML).not.toContain("tok-very-secret");
  });

  it("a name-only change applies at once, with no trust card", async () => {
    const gateway = setup();
    await openEdit();
    const name = await screen.findByLabelText("Name");
    await userEvent.clear(name);
    await userEvent.type(name, "My files");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText("Updated My files.")).toBeTruthy();
    expect(lastCall(gateway(), "mcp.update")?.params).toEqual({
      id: "files",
      changes: { name: "My files" },
    });
    expect(screen.queryByTestId("mcp-trust-card")).toBeNull();
    expect(methods(gateway())).not.toContain("mcp.add");
  });
});

describe("Test connection", () => {
  it("shows the tool count and changes nothing", async () => {
    const gateway = setup();
    await userEvent.click(await screen.findByRole("button", { name: "Open Files" }));
    await userEvent.click(await screen.findByRole("button", { name: "Test connection" }));
    expect(await screen.findByText("Works. 3 tools available.")).toBeTruthy();
    expect(lastCall(gateway(), "mcp.test")?.params).toEqual({ id: "files" });
    expect(methods(gateway())).not.toContain("mcp.update");
    expect(methods(gateway())).not.toContain("mcp.add");
    expect(screen.queryByTestId("mcp-trust-card")).toBeNull();
  });

  it("shows why it failed", async () => {
    setup((g) => {
      g.mcpTestError = "The server did not start: command not found";
    });
    await userEvent.click(await screen.findByRole("button", { name: "Open Files" }));
    await userEvent.click(await screen.findByRole("button", { name: "Test connection" }));
    expect(
      await screen.findByText("Didn't work: The server did not start: command not found"),
    ).toBeTruthy();
  });

  it("is off for a paused server", async () => {
    setup((g) => {
      const s = g.mcpServers.find((x) => x.id === "files");
      if (s) s.enabled = false;
    });
    await userEvent.click(await screen.findByRole("button", { name: "Open Files" }));
    const button = (await screen.findByRole("button", {
      name: "Test connection",
    })) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });
});

describe("A server whose command is fixed", () => {
  it("offers Rename only, and sends only the name", async () => {
    const gateway = setup((g) => {
      g.seedMcpServer(
        {
          id: "built",
          name: "Built in",
          trust: "bundled",
          transport: "stdio",
          network: false,
          connected: true,
        },
        { config: { editable: false } },
      );
    });
    await userEvent.click(await screen.findByRole("button", { name: "Open Built in" }));
    await userEvent.click(await screen.findByRole("button", { name: "Edit" }));
    expect(screen.queryByLabelText("Command")).toBeNull();
    const name = await screen.findByLabelText("Name");
    await userEvent.clear(name);
    await userEvent.type(name, "Mine");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText("Updated Mine.")).toBeTruthy();
    expect(lastCall(gateway(), "mcp.update")?.params).toEqual({
      id: "built",
      changes: { name: "Mine" },
    });
  });
});

describe("A URL server's address", () => {
  const seedWeb = (g: MockGateway) =>
    g.seedMcpServer(
      {
        id: "web",
        name: "Web",
        trust: "unknown",
        transport: "http",
        network: true,
        connected: true,
      },
      { config: { url: "https://api.example.com/mcp?token=***" } },
    );

  it("stays hidden and untouched: a rename sends no url", async () => {
    const gateway = setup(seedWeb);
    await userEvent.click(await screen.findByRole("button", { name: "Open Web" }));
    await userEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const field = (await screen.findByLabelText("Server URL")) as HTMLInputElement;
    expect(field.readOnly).toBe(true);
    const name = screen.getByLabelText("Name");
    await userEvent.clear(name);
    await userEvent.type(name, "Web 2");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText("Updated Web 2.")).toBeTruthy();
    expect(lastCall(gateway(), "mcp.update")?.params).toEqual({
      id: "web",
      changes: { name: "Web 2" },
    });
  });

  it("Change address clears the field and sends only the full new address", async () => {
    const gateway = setup(seedWeb);
    await userEvent.click(await screen.findByRole("button", { name: "Open Web" }));
    await userEvent.click(await screen.findByRole("button", { name: "Edit" }));
    await userEvent.click(await screen.findByRole("button", { name: "Change address" }));
    const url = screen.getByLabelText("Server URL") as HTMLInputElement;
    expect(url.value).toBe("");
    expect(url.readOnly).toBe(false);
    const save = screen.getByRole("button", { name: "Save changes" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    await userEvent.type(url, "https://api.example.com/v2?token=NEW");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByTestId("mcp-trust-card");
    expect(lastCall(gateway(), "mcp.update")?.params).toEqual({
      id: "web",
      changes: { url: "https://api.example.com/v2?token=NEW" },
    });
  });
});
