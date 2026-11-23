import type { BrowserAgentSettings } from "@psyche/protocol";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentBrowserGroup, BrowserPanel } from "../src/screens/settings/BrowserSection.tsx";

afterEach(cleanup);

const agent = (
  sites: BrowserAgentSettings["signedInSites"],
  over: Partial<BrowserAgentSettings> = {},
): BrowserAgentSettings => ({
  partition: { value: "auto", source: "setting" },
  signedInOrigins: {
    value: sites.filter((s) => s.source === "setting").map((s) => s.origin),
    source: "setting",
  },
  devPreviewPorts: { value: [], source: "default" },
  signedInSites: sites,
  useSignedInSessions: true,
  ...over,
});

const SITES: BrowserAgentSettings["signedInSites"] = [
  { origin: "https://a.example", source: "setting" },
  { origin: "https://canvas.ucsc.edu", source: "stay_signed_in" },
  { origin: "https://github.com", source: "detected" },
];
const VALUES = { "browser.signedInOrigins": ["https://a.example"] };

/** Settings → Browser: one "Signed-in sites" list, whatever the source of each site. */
describe("Settings → Browser signed-in sites", () => {
  it("shows one list with a source on each row, and a single 'Signed-in sites' title", () => {
    render(
      <BrowserPanel
        agentSettings={agent(SITES)}
        values={VALUES}
        onChange={() => {}}
        persona="Wren"
        signedInSites={{ list: async () => [], forget: async () => {} }}
      />,
    );
    expect(screen.getAllByText("Signed-in sites")).toHaveLength(1);
    const rows = within(screen.getByTestId("signed-in-sites")).getAllByRole("listitem");
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringMatching(/a\.example.*Added in Settings/),
      expect.stringMatching(/canvas\.ucsc\.edu.*Stay signed in/),
      expect.stringMatching(/github\.com.*found automatically/),
    ]);
  });

  it("removing a setting row writes the setting and never calls sign-out", async () => {
    const onChange = vi.fn();
    const forget = vi.fn(async () => {});
    render(
      <AgentBrowserGroup
        agent={agent(SITES)}
        values={VALUES}
        onChange={onChange}
        signedInSites={{ list: async () => [], forget }}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Remove https://a.example" }));
    expect(onChange).toHaveBeenCalledWith("browser.signedInOrigins", []);
    expect(forget).not.toHaveBeenCalled();
  });

  it.each([["https://canvas.ucsc.edu"], ["https://github.com"]])(
    "signing out of %s calls forget and writes no setting",
    async (origin) => {
      const onChange = vi.fn();
      const onForgotten = vi.fn();
      const forget = vi.fn(async () => {});
      render(
        <AgentBrowserGroup
          agent={agent(SITES)}
          values={VALUES}
          onChange={onChange}
          onForgotten={onForgotten}
          signedInSites={{ list: async () => [], forget }}
        />,
      );
      await userEvent.click(screen.getByRole("button", { name: `Sign out of ${origin}` }));
      expect(forget).toHaveBeenCalledWith(origin);
      await waitFor(() => expect(onForgotten).toHaveBeenCalled());
      expect(onChange).not.toHaveBeenCalled();
    },
  );

  it("without the desktop API those rows are read-only and say where to sign out", () => {
    render(<AgentBrowserGroup agent={agent(SITES)} values={VALUES} onChange={() => {}} />);
    expect(screen.queryByRole("button", { name: /Sign out of/ })).toBeNull();
    expect(screen.getAllByTestId("signed-in-readonly")).toHaveLength(2);
    expect(screen.getAllByText("Sign out from the Psyche desktop app")).toHaveLength(2);
    // The setting row stays removable from anywhere.
    expect(screen.getByRole("button", { name: "Remove https://a.example" })).toBeTruthy();
  });

  it("shows a failed sign-out and keeps the site listed", async () => {
    render(
      <AgentBrowserGroup
        agent={agent(SITES)}
        values={VALUES}
        onChange={() => {}}
        signedInSites={{
          list: async () => [],
          forget: async () => {
            throw new Error("profile busy");
          },
        }}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Sign out of https://github.com" }));
    expect(await screen.findByText(/couldn't sign out of https:\/\/github\.com/i)).toBeTruthy();
    expect(screen.getByText("https://github.com")).toBeTruthy();
  });

  it("the Signed-in sites only hint is true: it names signed-in sites, and follows the toggle", () => {
    const { rerender } = render(
      <AgentBrowserGroup agent={agent(SITES)} values={VALUES} onChange={() => {}} />,
    );
    const hint = () => screen.getByTestId("agent-browser-mode-hint").textContent ?? "";
    expect(hint()).toMatch(/already signed in to/);
    expect(hint()).not.toMatch(/Listed sites/);
    rerender(
      <AgentBrowserGroup
        agent={agent(SITES)}
        values={{ ...VALUES, "browser.useSignedInSessions": false }}
        onChange={() => {}}
      />,
    );
    expect(hint()).not.toMatch(/already signed in to/);
    expect(hint()).toMatch(/Only the sites in the list below/);
  });
});
