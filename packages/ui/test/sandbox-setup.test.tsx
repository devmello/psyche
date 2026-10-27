import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { MockGateway } from "../src/data/mock-gateway.ts";
import { FIXTURE_NOW } from "../src/fixtures/index.ts";
import { OnboardingFlow } from "../src/screens/onboarding/OnboardingFlow.tsx";
import { McpPresetForm } from "../src/screens/settings/McpPresetForm.tsx";
import { MCP_PRESETS } from "../src/screens/settings/mcp-presets.ts";
import { SandboxSetup } from "../src/screens/settings/SandboxSetup.tsx";
import { SettingsScreen } from "../src/screens/settings/SettingsScreen.tsx";
import type { McpState } from "../src/screens/settings/use-mcp.tsx";
import { StoryWorld } from "../src/stories/harness.tsx";

/** Guided sandbox setup: the "Set up sandbox" button, the walkthrough, onboarding's Sandbox step. */

type Setup = MockGateway["sandboxSetup"];
const backend = (
  kind: "apple-container" | "docker" | "podman",
  installed: boolean,
  running: boolean,
) => ({ kind, supported: true, installed, running, version: running ? "1" : null });

const MISSING: Setup = {
  recommended: "apple-container",
  backends: [
    backend("apple-container", false, false),
    backend("docker", false, false),
    backend("podman", false, false),
  ],
  ready: false,
  active: "none",
  restartNeeded: false,
};
const DOCKER_STOPPED: Setup = {
  ...MISSING,
  backends: [
    backend("apple-container", false, false),
    backend("docker", true, false),
    backend("podman", false, false),
  ],
};
const READY: Setup = {
  ...MISSING,
  backends: [
    backend("apple-container", true, true),
    backend("docker", false, false),
    backend("podman", false, false),
  ],
  ready: true,
  active: "apple-container",
};

function world(seed: (g: MockGateway) => void, children: React.ReactNode): () => MockGateway {
  let gw: MockGateway | null = null;
  render(
    <StoryWorld
      onGateway={(g) => {
        gw = g;
        seed(g);
      }}
    >
      {children}
    </StoryWorld>,
  );
  return () => {
    if (gw === null) throw new Error("gateway not ready");
    return gw;
  };
}

const time = MCP_PRESETS.find((p) => p.id === "time");
if (time === undefined) throw new Error("no time preset");

function presetForm(launcher: McpState["launcher"], reload = vi.fn()) {
  const mcp = { launcher, reload, checking: false, check: vi.fn() } as unknown as McpState;
  return <McpPresetForm preset={time as never} mcp={mcp} onCancel={() => {}} />;
}

describe("Set up sandbox button", () => {
  it("shows only when the Gateway has no sandbox for commands", () => {
    const { unmount } = render(<StoryWorld>{presetForm("none")}</StoryWorld>);
    expect(screen.getByText(/has no sandbox for commands/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Set up sandbox" })).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Check server" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    unmount();
    render(<StoryWorld>{presetForm("container")}</StoryWorld>);
    expect(screen.queryByRole("button", { name: "Set up sandbox" })).toBeNull();
    expect(screen.queryByText(/has no sandbox for commands/)).toBeNull();
  });

  it("is on the Custom MCP server form too, only without a sandbox", async () => {
    world(
      (g) => {
        g.mcpLauncher = "none";
      },
      <SettingsScreen
        now={Date.parse(FIXTURE_NOW)}
        defaultSection="connectors"
        connectorsView="add-mcp"
      />,
    );
    expect(await screen.findByRole("button", { name: "Set up sandbox" })).toBeTruthy();
  });

  it("walks through setup and returns to the form once the sandbox is ready", async () => {
    const reload = vi.fn();
    const gw = world(
      (g) => {
        g.sandboxSetup = MISSING;
      },
      presetForm("none", reload),
    );
    await userEvent.click(screen.getByRole("button", { name: "Set up sandbox" }));
    const dialog = await screen.findByRole("dialog", { name: "Set up the sandbox" });
    expect(await within(dialog).findByText("Install Apple container")).toBeTruthy();
    expect(within(dialog).getAllByText(/isolated from your Mac/).length).toBeGreaterThan(0);

    gw().sandboxSetup = READY;
    await userEvent.click(within(dialog).getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(reload).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});

describe("SandboxSetup walkthrough", () => {
  it("missing: the recommended runtime's download and start command, nothing run", async () => {
    const gw = world(
      (g) => {
        g.sandboxSetup = MISSING;
      },
      <SandboxSetup />,
    );
    expect(await screen.findByText("Install Apple container")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open the Apple container releases" })).toBeTruthy();
    expect(screen.getByText("container system start")).toBeTruthy();
    // Only looks: the walkthrough calls nothing but the read-only detection.
    expect(
      gw()
        .calls.filter((c) => c.method.startsWith("sandbox."))
        .map((c) => c.method),
    ).toEqual(["sandbox.setup"]);
  });

  it("missing where Apple container can't run: Colima or Docker Desktop", async () => {
    world(
      (g) => {
        g.sandboxSetup = { ...MISSING, recommended: "docker" };
      },
      <SandboxSetup />,
    );
    expect(await screen.findByText("Install Docker")).toBeTruthy();
    expect(screen.getByText("brew install colima docker")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open the Docker Desktop download" })).toBeTruthy();
  });

  it("installed but not running: how to start it", async () => {
    world(
      (g) => {
        g.sandboxSetup = DOCKER_STOPPED;
      },
      <SandboxSetup />,
    );
    expect(await screen.findByText("Docker is installed but not running")).toBeTruthy();
    expect(screen.getByText("colima start")).toBeTruthy();
  });

  it("running but the Gateway started without it: restart", async () => {
    world(
      (g) => {
        g.sandboxSetup = { ...READY, active: "none", restartNeeded: true };
      },
      <SandboxSetup />,
    );
    expect(await screen.findByText(/Restart the Gateway to use it/)).toBeTruthy();
  });

  it("ready, and Check again looks again", async () => {
    const gw = world(
      (g) => {
        g.sandboxSetup = DOCKER_STOPPED;
      },
      <SandboxSetup />,
    );
    await screen.findByText("Docker is installed but not running");
    gw().sandboxSetup = READY;
    await userEvent.click(screen.getByRole("button", { name: "Check again" }));
    expect(await screen.findByRole("status")).toBeTruthy();
    expect(screen.getByText("Ready")).toBeTruthy();
  });
});

describe("Onboarding → Sandbox", () => {
  const flow = (seed: Setup) =>
    world(
      (g) => {
        g.sandboxSetup = seed;
      },
      <OnboardingFlow onComplete={() => {}} defaultStep="sandbox" />,
    );

  it("is optional: says what is lost and skips to the next step", async () => {
    flow(MISSING);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toContain("Sandbox (optional)");
    expect(await screen.findByText(/can't run local MCP command servers/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Skip for now" }));
    expect(screen.getByRole("heading", { level: 1 }).textContent).toContain("Model & provider");
  });

  it("shows Ready when a sandbox is already there, with no Skip", async () => {
    flow(READY);
    expect(await screen.findByText("Ready")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Skip for now" })).toBeNull();
    expect(screen.queryByText(/can't run local MCP command servers/)).toBeNull();
  });
});
