import { MCP_PRESETS, presetNeeds } from "@psyche/protocol";
import { render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { FilesOnMacCard, TerminalCard } from "../src/screens/settings/DeviceAccessCards.tsx";
import { execHostEnabled, folderGrants } from "../src/screens/settings/FileAccessSection.tsx";
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

function Harness({ initial }: { initial: Record<string, unknown> }) {
  const [values, setValues] = useState(initial);
  const onChange = (k: string, v: unknown) => setValues((s) => ({ ...s, [k]: v }));
  return (
    <StoryWorld>
      <output data-testid="policy">{JSON.stringify(values["permissions.policy"] ?? {})}</output>
      <FilesOnMacCard values={values} onChange={onChange} persona="Psyche" />
      <TerminalCard values={values} onChange={onChange} persona="Psyche" />
    </StoryWorld>
  );
}
const policy = () => JSON.parse(screen.getByTestId("policy").textContent ?? "{}");

describe("Files on this Mac and Terminal", () => {
  it("lists every granted folder, adds more than one, changes access and revokes", async () => {
    const user = userEvent.setup();
    render(
      <Harness
        initial={{
          "permissions.policy": { folders: [{ path: "/Users/me/Documents", mode: "ro" }] },
        }}
      />,
    );
    const list = screen.getByRole("list", { name: "Shared folders" });
    expect(within(list).getByText("/Users/me/Documents")).toBeTruthy();
    const input = screen.getAllByPlaceholderText(/\//)[0] as HTMLInputElement;
    await user.type(input, "/Users/me/Projects");
    await user.click(screen.getAllByRole("button", { name: "Share a folder" })[0] as HTMLElement);
    await user.type(input, "/Users/me/Desktop");
    await user.click(screen.getAllByRole("button", { name: "Share a folder" })[0] as HTMLElement);
    expect(folderGrants({ "permissions.policy": policy() }).map((g) => g.path)).toEqual([
      "/Users/me/Documents",
      "/Users/me/Projects",
      "/Users/me/Desktop",
    ]);
    await user.selectOptions(screen.getByLabelText("Access to /Users/me/Projects"), "rw");
    expect(policy().folders[1]).toEqual({ path: "/Users/me/Projects", mode: "rw" });
    await user.click(screen.getByRole("button", { name: "Stop sharing /Users/me/Desktop" }));
    expect(policy().folders).toHaveLength(2);
  });

  it("turns exec_host on and off through the same policy setting", async () => {
    const user = userEvent.setup();
    render(
      <Harness initial={{ "permissions.policy": { folders: [], exec: { allowEnv: ["FOO"] } } }} />,
    );
    const sw = screen.getByRole("switch", { name: /to ask to run commands/ });
    expect(execHostEnabled({ "permissions.policy": policy() })).toBe(false);
    await user.click(sw);
    expect(policy().exec).toEqual({ allowEnv: ["FOO"], execHostEnabled: true });
    await user.click(sw);
    expect(policy().exec.execHostEnabled).toBe(false);
    expect(screen.getByText(/type UNSANDBOXED/)).toBeTruthy();
  });
});
