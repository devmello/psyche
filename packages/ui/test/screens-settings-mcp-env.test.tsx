import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { MockGateway } from "../src/data/mock-gateway.ts";
import { FIXTURE_NOW } from "../src/fixtures/index.ts";
import type { ConnectorsView } from "../src/screens/settings/ConnectorsSection.tsx";
import { SettingsScreen } from "../src/screens/settings/SettingsScreen.tsx";
import { StoryWorld } from "../src/stories/harness.tsx";

/** Environment variables typed into the Add MCP server form: plain values in config, secrets in the vault. */

function setup(view: ConnectorsView): () => MockGateway {
  let gw: MockGateway | null = null;
  render(
    <StoryWorld onGateway={(g) => (gw = g)}>
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

/** The `mcp.probe` params this file reads: the server as the form sent it. */
interface ProbeParams {
  server: { transport: { env?: Record<string, string> } };
}

async function fillCommandServer(): Promise<void> {
  await userEvent.type(await screen.findByLabelText("Name"), "Files");
  await userEvent.type(screen.getAllByLabelText("Command").at(-1) as HTMLElement, "npx -y files");
}

describe("Add MCP server → environment variables", () => {
  it("keeps plain values in the config and sends a secret-looking one to the vault", async () => {
    const gateway = setup("add-mcp");
    await fillCommandServer();
    await userEvent.click(screen.getByRole("button", { name: "Add variable" }));
    await userEvent.click(screen.getByRole("button", { name: "Add variable" }));
    const names = screen.getAllByLabelText("Variable name");
    const values = screen.getAllByLabelText("Value");
    await userEvent.type(names[0] as HTMLElement, "LOG_LEVEL");
    await userEvent.type(values[0] as HTMLElement, "debug");
    await userEvent.type(names[1] as HTMLElement, "API_TOKEN");
    await userEvent.type(values[1] as HTMLElement, "tok-very-secret");

    await userEvent.click(screen.getByRole("button", { name: "Check server" }));
    await screen.findByTestId("mcp-trust-card");

    const add = gateway().calls.find((c) => c.method === "vault.add");
    expect(add?.params).toMatchObject({
      kind: "api_key",
      bindings: [{ connector: "mcp:files" }],
      secret: { token: "tok-very-secret" },
    });
    const probe = gateway().calls.find((c) => c.method === "mcp.probe");
    const probeServer = (probe?.params as ProbeParams | undefined)?.server;
    if (probeServer === undefined) throw new Error("no mcp.probe call");
    const env = probeServer.transport.env ?? {};
    expect(env.LOG_LEVEL).toBe("debug");
    expect(env.API_TOKEN).toMatch(/^\{\{cred:[a-z0-9-]+\}\}$/);
    expect(JSON.stringify(probe?.params)).not.toContain("tok-very-secret");
    expect(methods(gateway()).indexOf("vault.add")).toBeLessThan(
      methods(gateway()).indexOf("mcp.probe"),
    );
  });

  it("clears a stored secret from the form and shows it as saved", async () => {
    setup("add-mcp");
    await fillCommandServer();
    await userEvent.click(screen.getByRole("button", { name: "Add variable" }));
    await userEvent.type(screen.getByLabelText("Variable name"), "GITHUB_TOKEN");
    await userEvent.type(screen.getByLabelText("Value"), "ghp_example_value");
    expect((screen.getByLabelText("Value") as HTMLInputElement).type).toBe("password");

    await userEvent.click(screen.getByRole("button", { name: "Check server" }));
    await screen.findByTestId("mcp-trust-card");

    const value = screen.getByLabelText("Value") as HTMLInputElement;
    expect(value.value).toBe("");
    expect(value.placeholder).toBe("Saved");
    expect(document.body.innerHTML).not.toContain("ghp_example_value");
  });

  it("refuses a variable name the Gateway would not accept, and can remove a row", async () => {
    const gateway = setup("add-mcp");
    await fillCommandServer();
    await userEvent.click(screen.getByRole("button", { name: "Add variable" }));
    await userEvent.type(screen.getByLabelText("Variable name"), "bad-name");

    expect(
      screen.getByText(
        "Names use capital letters, digits and underscores, and start with a letter or underscore.",
      ),
    ).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Check server" }) as HTMLButtonElement).disabled,
    ).toBe(true);

    await userEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(screen.queryByLabelText("Variable name")).toBeNull();
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Check server" }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    expect(methods(gateway())).not.toContain("vault.add");
  });
});
