import type { ApprovalRequest } from "@psyche/protocol";
import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ApprovalDetails } from "../src/blocks/approval-details.tsx";
import type { MockGateway } from "../src/data/mock-gateway.ts";
import { FIXTURE_NOW } from "../src/fixtures/index.ts";
import { SettingsScreen } from "../src/screens/settings/SettingsScreen.tsx";
import { StoryWorld } from "../src/stories/harness.tsx";

/** A connector Psyche wrote: the badge, the read-only code, and an edit that needs a diff card. */

const SERVER = {
  id: "notes",
  name: "Notes tools",
  trust: "unknown" as const,
  transport: "stdio" as const,
  network: false,
  connected: true,
  madeBy: "psyche" as const,
  version: "1",
};

function setup(): () => MockGateway {
  let gw: MockGateway | null = null;
  render(
    <StoryWorld
      onGateway={(g) => {
        gw = g;
        g.seedMcpServer(SERVER);
        g.seedMcpFiles("notes", {
          "server.mjs": 'serve({ name: "notes" });\nconst x = 1;',
          "manifest.json": '{"version":"1"}',
        });
        g.seedMcpServer({
          id: "files",
          name: "Files",
          trust: "unknown",
          transport: "stdio",
          network: false,
          connected: true,
        });
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

async function openDetails(name: string) {
  const row = await screen.findByRole("article", { name });
  await userEvent.click(within(row).getByRole("button", { name: `More for ${name}` }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Show details" }));
  return row;
}

describe("Connectors → made by Psyche", () => {
  it("badges only the connectors Psyche wrote", async () => {
    setup();
    const mine = await screen.findByRole("article", { name: "Notes tools" });
    expect(within(mine).getByText("Made by Psyche")).toBeTruthy();
    expect(within(mine).getByText("Trust: unverified")).toBeTruthy();
    const other = await screen.findByRole("article", { name: "Files" });
    expect(within(other).queryByText("Made by Psyche")).toBeNull();
  });

  it("shows the code read-only, and an edit stops it behind a card with the diff", async () => {
    const gateway = setup();
    const row = await openDetails("Notes tools");
    await userEvent.click(within(row).getByRole("button", { name: "View code" }));
    expect(await within(row).findByText(/^server\.mjs · \d+ B$/)).toBeTruthy();
    expect(within(row).getByText(/Version 1 · node/)).toBeTruthy();

    await userEvent.click(await within(row).findByRole("button", { name: "Edit server.mjs" }));
    const box = within(row).getByLabelText("Editing server.mjs");
    await userEvent.clear(box);
    await userEvent.type(box, "const x = 2;");
    await userEvent.click(within(row).getByRole("button", { name: "Save for review" }));

    const card = await screen.findByTestId("mcp-trust-card");
    const calls = gateway().calls.filter((c) => c.method === "mcp.files.write");
    expect(calls.at(-1)?.params).toMatchObject({ serverId: "notes", path: "server.mjs" });
    // The approval card carries the diff against the approved code, and nothing was added yet.
    expect(await within(card).findByTestId("self-connector-diff")).toBeTruthy();
    expect(within(card).getByText("Changes since version 1")).toBeTruthy();
    expect(gateway().calls.map((c) => c.method)).not.toContain("mcp.add");

    const allow = await within(card).findByRole("button", { name: "Allow with scope" });
    await waitFor(() => expect((allow as HTMLButtonElement).disabled).toBe(false));
    await userEvent.click(allow);
    expect(await screen.findByText("Notes tools updated.")).toBeTruthy();
    expect(gateway().calls.map((c) => c.method)).toContain("mcp.add");
  });
});

describe("Approval card for a connector Psyche wrote", () => {
  it("lists every file, the exact command, the network and the diff", () => {
    const approval = {
      kind: "skill_install",
      details: {
        kind: "mcp_server",
        madeBy: "psyche",
        version: "2",
        previousVersion: "1",
        command: "node server.mjs",
        requestedNetwork: ["api.example.com"],
        tools: ["read shout"],
        files: [
          { path: "server.mjs", bytes: 12, lines: ["const x = 2;"] },
          { path: "mcp-lite.mjs", bytes: 900, provided: true, lines: [] },
        ],
        diff: ["--- a/server.mjs", "+++ b/server.mjs", "@@", "-const x = 1;", "+const x = 2;"],
      },
    } as unknown as ApprovalRequest;
    render(<ApprovalDetails approval={approval} persona="Psyche" />);
    expect(screen.getByText("node server.mjs")).toBeTruthy();
    expect(screen.getByText("api.example.com")).toBeTruthy();
    expect(screen.getByText("Psyche wrote this connector (version 2)")).toBeTruthy();
    expect(screen.getByText("server.mjs (12 bytes)")).toBeTruthy();
    expect(screen.getByText(/mcp-lite\.mjs \(900 bytes\)/)).toBeTruthy();
    expect(screen.getByTestId("self-connector-diff")).toBeTruthy();
    expect(screen.getByText("const x = 2;")).toBeTruthy();
  });
});
