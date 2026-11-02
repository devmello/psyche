import { MCP_PRESETS, presetNeeds } from "@psyche/protocol";
import { render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { FilesOnMacCard, TerminalCard } from "../src/screens/settings/DeviceAccessCards.tsx";
import { execHostEnabled } from "../src/screens/settings/FileAccessSection.tsx";
import { McpFailureNotice } from "../src/screens/settings/McpFailureNotice.tsx";
import { McpPrerequisites } from "../src/screens/settings/McpPrerequisites.tsx";
import { launchFailureOf, type McpState } from "../src/screens/settings/use-mcp.tsx";
import { StoryWorld } from "../src/stories/harness.tsx";

const preset = (id: string) => {
  const p = MCP_PRESETS.find((x) => x.id === id);
  if (!p) throw new Error(id);
  return p;
};

describe("preset prerequisites", () => {
  it("marks what every stdio preset needs from how it starts", () => {
    for (const p of MCP_PRESETS) {
      const needs = presetNeeds(p);
      if (p.transport.kind === "http") {
        expect(needs, p.id).toEqual(["network"]);
        continue;
      }
      expect(needs, p.id).toContain("srt");
      const first = p.transport.command[0];
      expect(needs.includes("node"), p.id).toBe(first === "npx");
      expect(needs.includes("uv"), p.id).toBe(first === "uvx");
    }
    expect(presetNeeds(preset("time"))).toEqual(["srt", "uv", "network"]);
    expect(MCP_PRESETS.some((p) => p.id === "filesystem")).toBe(false);
  });

  it("shows the table and the one-click sandbox fix", () => {
    const mcp = { launcher: "none", reload: vi.fn() } as Pick<McpState, "launcher" | "reload">;
    render(
      <StoryWorld>
        <McpPrerequisites preset={preset("time")} mcp={mcp} />
      </StoryWorld>,
    );
    const table = screen.getByRole("table");
    expect(within(table).getByText("Sandbox (srt)")).toBeTruthy();
    expect(within(table).getByText("uv (uvx)")).toBeTruthy();
    expect(within(table).getByText("Missing")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Set up sandbox" })).toBeTruthy();
  });
});

describe("failure card", () => {
  it("shows the real reason: next step, exit code and the server's own output", () => {
    const failure = launchFailureOf({
      details: {
        failure: "network_blocked",
        exitCode: 3,
        stderr: "getaddrinfo ENOTFOUND pypi.org",
      },
    });
    render(
      <StoryWorld>
        <McpFailureNotice
          message="The server did not start: The server could not download its package"
          failure={failure}
          mcp={{ reload: vi.fn() }}
        />
      </StoryWorld>,
    );
    expect(screen.getByText(/could not download or reach what it needs/)).toBeTruthy();
    expect(screen.getByText("Exit code 3.")).toBeTruthy();
    expect(screen.getByText("getaddrinfo ENOTFOUND pypi.org")).toBeTruthy();
  });

  it("points to uv when it is missing", () => {
    render(
      <StoryWorld>
        <McpFailureNotice
          message="The server did not start"
          failure={{ failure: "uv_missing", stderr: "" }}
          mcp={{ reload: vi.fn() }}
        />
      </StoryWorld>,
    );
    expect(screen.getByText(/Install uv/)).toBeTruthy();
  });
});

describe("Files on this Mac and Terminal", () => {
  it("show what File access decides and open it there, with no second editor", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    const values = {
      "permissions.policy": {
        folders: [
          { path: "/Users/me/Documents", mode: "ro" },
          { path: "/Users/me/Projects", mode: "rw" },
        ],
        exec: { execHostEnabled: true },
      },
    };
    render(
      <StoryWorld>
        <FilesOnMacCard values={values} persona="Psyche" onOpenFileAccess={onOpen} />
        <TerminalCard values={values} persona="Psyche" onOpenFileAccess={onOpen} />
      </StoryWorld>,
    );
    const list = screen.getByRole("list", { name: "Shared folders" });
    expect(within(list).getByText("/Users/me/Projects")).toBeTruthy();
    expect(within(list).getByText("read and write")).toBeTruthy();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByRole("button", { name: "Share a folder" })).toBeNull();
    expect(screen.getByText("Running commands is on")).toBeTruthy();
    expect(screen.getByText("2 folders shared.")).toBeTruthy();
    await user.click(screen.getAllByRole("button", { name: "Open File access" })[1] as HTMLElement);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(execHostEnabled({})).toBe(false);
  });
});
