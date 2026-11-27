import type { BrowserAgentSettings } from "@psyche/protocol";
import { cleanup, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AboutPanel } from "../src/screens/settings/AboutSection.tsx";
import { BrowserPanel } from "../src/screens/settings/BrowserSection.tsx";
import { PermissionsPanel } from "../src/screens/settings/PermissionsSection.tsx";
import type { AboutInfo, UpdatePort, UpdateStatusView } from "../src/screens/settings/types.ts";

afterEach(cleanup);

/** True when the element sits inside a closed `<details>` (folded away, still in the DOM). */
function folded(el: Element): boolean {
  const d = el.closest("details");
  return d !== null && !d.open;
}

const info: AboutInfo = {
  appVersion: "0.3.0",
  gatewayVersion: "0.3.1",
  protocolVersion: 7,
  platform: "macOS 27",
  home: "/Users/o/.psyche",
  runtime: "Electron 39",
};

function port(initial: UpdateStatusView): UpdatePort {
  return {
    status: vi.fn(async () => initial),
    subscribe: vi.fn(() => () => {}),
    restart: vi.fn(async () => undefined),
  };
}

describe("About, simplified", () => {
  it("shows the app version at rest and folds Gateway, Protocol, Platform and Runtime", () => {
    render(<AboutPanel info={info} />);
    expect(folded(screen.getByText("0.3.0"))).toBe(false);
    expect(folded(screen.getByText("/Users/o/.psyche"))).toBe(false);
    for (const text of ["Gateway", "Protocol", "Platform", "Runtime"]) {
      expect(folded(screen.getByText(text))).toBe(true);
    }
    // Still reachable.
    expect(screen.getByText("0.3.1")).toBeTruthy();
    expect(screen.getByText("Electron 39")).toBeTruthy();
  });

  it("has no release channel row", () => {
    render(<AboutPanel info={info} showUpdates update={port({ state: "none" })} />);
    expect(screen.queryByText("Release channel")).toBeNull();
    expect(screen.queryByText(/only channel/)).toBeNull();
  });

  it("says the updater is off, with no check button, when the gate is closed", async () => {
    render(<AboutPanel info={info} showUpdates update={port({ state: "idle" })} />);
    expect((await screen.findByTestId("updates-off")).textContent).toBe(
      "Updates are off for this build. To update, rebuild Psyche and run pnpm app:install.",
    );
    expect(screen.queryByRole("button", { name: /check for updates/i })).toBeNull();
    expect(screen.queryByText("Status")).toBeNull();
  });

  it("positive control: a live updater shows its status instead of the off line", async () => {
    render(<AboutPanel info={info} showUpdates update={port({ state: "none" })} />);
    expect(await screen.findByText("Up to date")).toBeTruthy();
    expect(screen.queryByTestId("updates-off")).toBeNull();
  });

  it("the doctor line doesn't say Gateway", () => {
    render(<AboutPanel info={info} />);
    expect(
      screen.getByText("Checks that Psyche, the sandbox, permissions and vault are working."),
    ).toBeTruthy();
  });
});

const agent = (over: Partial<BrowserAgentSettings> = {}): BrowserAgentSettings => ({
  partition: { value: "auto", source: "setting" },
  signedInOrigins: { value: ["https://a.example"], source: "setting" },
  devPreviewPorts: { value: [], source: "default" },
  signedInSites: [{ origin: "https://a.example", source: "setting" }],
  useSignedInSessions: true,
  ...over,
});

function browser(over: Partial<BrowserAgentSettings> = {}) {
  const onChange = vi.fn();
  render(
    <BrowserPanel
      agentSettings={agent(over)}
      values={{ "browser.signedInOrigins": ["https://a.example"] }}
      onChange={onChange}
      persona="Wren"
      onOpenProfile={async () => ({ path: "/p" })}
      cookieImport={
        {
          sources: async () => [],
          imported: async () => [],
        } as never
      }
      teachStorage={async () => ({ encrypted: true })}
      onRotateBotAuth={async () => undefined}
    />,
  );
  return onChange;
}

describe("Browser, simplified", () => {
  it("keeps only Sign-ins and Signed-in sites at rest", () => {
    browser();
    expect(folded(screen.getByTestId("agent-browser-mode"))).toBe(false);
    expect(folded(screen.getByTestId("agent-browser-sites"))).toBe(false);
  });

  it("folds the Chrome profile, other browsers, dev ports and the rest, all still reachable", async () => {
    const onChange = browser();
    expect(folded(screen.getByTestId("agent-browser-ports"))).toBe(true);
    expect(folded(screen.getByRole("switch", { name: /Psyche profile/ }))).toBe(true);
    expect(folded(screen.getByText("Open the profile in Chrome"))).toBe(true);
    expect(
      folded(screen.getByRole("switch", { name: "Let Psyche use my signed-in sessions" })),
    ).toBe(true);
    // Dev preview ports still work.
    const ports = within(screen.getByTestId("agent-browser-ports"));
    await userEvent.type(ports.getByLabelText("Port number"), "5173");
    await userEvent.click(ports.getByRole("button", { name: "Add port" }));
    expect(onChange).toHaveBeenCalledWith("browser.devPreviewPorts", [5173]);
  });

  it("says 'set by your setup' in plain words, never an environment variable", () => {
    browser({
      partition: { value: "clean", source: "env" },
      signedInOrigins: { value: [], source: "env" },
      devPreviewPorts: { value: [3000], source: "env" },
    });
    expect(screen.getAllByText("Set by your setup, so it can't be changed here.").length).toBe(3);
    expect(document.body.textContent).not.toMatch(/environment variable/);
  });
});

describe("Privacy & security, simplified", () => {
  const NAME = "Let a reviewer approve safe terminal commands in Auto mode";

  it("folds the exec-review switch under Advanced and it still writes", async () => {
    const onChange = vi.fn();
    render(<PermissionsPanel values={{}} onChange={onChange} connectors={[]} grants={[]} />);
    const sw = screen.getByRole("switch", { name: NAME });
    expect(folded(sw)).toBe(true);
    await userEvent.click(sw);
    expect(onChange).toHaveBeenCalledWith("permissions.policy", {
      exec: { reviewInAuto: false },
    });
  });

  it("shows no 'hash ok' chip for a connector whose tools did not change", () => {
    render(
      <PermissionsPanel
        values={{}}
        onChange={() => {}}
        grants={[]}
        connectors={[
          {
            id: "c1",
            label: "Files MCP",
            type: "mcp",
            scopeMode: "read",
            actionMatrix: [],
            config: { toolsListHash: "sha256:abcdef0123456789abcdef" },
          } as never,
        ]}
      />,
    );
    expect(screen.queryByText("tools/list hash ok")).toBeNull();
    expect(screen.queryByText(/tools\/list sha256/)).toBeNull();
  });
});
