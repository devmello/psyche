import type { AppleLlmStatus } from "@psyche/protocol";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { MockGateway } from "../src/data/mock-gateway.ts";
import { AccessListView } from "../src/screens/settings/AccessList.tsx";
import { EssentialsPanel } from "../src/screens/settings/EssentialsSection.tsx";
import { SearchModelGroup } from "../src/screens/settings/SearchSection.tsx";
import { SettingsScreen } from "../src/screens/settings/SettingsScreen.tsx";
import { UiSlotsProvider } from "../src/slots.tsx";
import { StoryWorld } from "../src/stories/harness.tsx";

/** Settings → Essentials and the Access list (docs/design/settings-2026.md §7). */

function panel(over: Partial<Parameters<typeof EssentialsPanel>[0]> = {}) {
  const onChange = vi.fn();
  const onOpen = vi.fn();
  render(
    <EssentialsPanel
      values={{}}
      onChange={onChange}
      persona="Wren"
      model={{ ref: "anthropic/claude-sonnet-5-5", label: "Claude Sonnet 5.5", ready: true }}
      remembering
      onRemember={vi.fn()}
      onOpen={onOpen}
      {...over}
    />,
  );
  return { onChange, onOpen };
}

describe("Settings → Essentials", () => {
  it("shows the safe defaults: Balanced, memory on", () => {
    panel();
    const sw = (name: string) => screen.getByRole("switch", { name }).getAttribute("aria-checked");
    expect(sw("Let Wren remember our chats")).toBe("true");
    expect(
      screen.getByRole("radio", { name: /Balanced/ }).getAttribute("aria-checked") ??
        (screen.getByRole("radio", { name: /Balanced/ }) as HTMLInputElement).checked.toString(),
    ).toBe("true");
    expect(screen.getByText("Claude Sonnet 5.5")).toBeTruthy();
    expect(screen.getByText("Ready")).toBeTruthy();
  });

  it("writes the same keys as the detailed panes and opens them with More", async () => {
    const user = userEvent.setup();
    const { onChange, onOpen } = panel();
    await user.click(screen.getByRole("radio", { name: /Manual/ }));
    expect(onChange).toHaveBeenCalledWith("permissions.mode", "manual");
    await user.click(screen.getByRole("button", { name: "More in Model & providers" }));
    expect(onOpen).toHaveBeenCalledWith("model");
    // The groups that only repeated another pane (sources, quiet hours, brief) are gone.
    expect(screen.queryByRole("switch", { name: "Quiet hours" })).toBeNull();
    expect(screen.queryByRole("switch", { name: "Morning brief" })).toBeNull();
    expect(screen.queryByRole("switch", { name: "Mail" })).toBeNull();
  });

  it("asks for a model in amber when none is picked", async () => {
    const user = userEvent.setup();
    const { onOpen } = panel({ model: { ref: null, label: null, ready: false } });
    expect(screen.getByText("No model yet").closest("[data-tone]")?.getAttribute("data-tone")).toBe(
      "approval",
    );
    await user.click(screen.getByRole("button", { name: "Set up a model" }));
    expect(onOpen).toHaveBeenCalledWith("model");
  });

  it("is General's body and where Settings opens", async () => {
    let gw: MockGateway | null = null;
    render(
      <StoryWorld onGateway={(g) => (gw = g)}>
        <SettingsScreen />
      </StoryWorld>,
    );
    expect(await screen.findByRole("heading", { level: 2, name: "General" })).toBeTruthy();
    const nav = screen.getByRole("navigation", { name: "Settings sections" });
    expect(within(nav).getAllByRole("button")[0]?.textContent).toBe("General");
    await userEvent.click(await screen.findByRole("radio", { name: /Manual/ }));
    await waitFor(() =>
      expect(
        gw?.calls.find(
          (c) =>
            c.method === "settings.set" && (c.params as { key: string }).key === "permissions.mode",
        )?.params,
      ).toMatchObject({ value: "manual" }),
    );
  });
});

describe("Access list", () => {
  it("names each grant's kind and scope, and revokes one", async () => {
    const user = userEvent.setup();
    const onRevoke = vi.fn();
    render(
      <AccessListView
        persona="Wren"
        now={Date.parse("2026-11-02T12:00:00Z")}
        onRevoke={onRevoke}
        entries={[
          {
            id: "folder:conversation:/tmp/a",
            type: "folder",
            scope: "conversation",
            label: "/tmp/a",
            path: "/tmp/a",
            mode: "rw",
          },
          {
            id: "grant:g1",
            type: "grant",
            scope: "always",
            label: "Send email to jane@example.com",
            lastUsedAt: "2026-11-02T11:55:00Z",
          },
        ]}
      />,
    );
    const list = screen.getByRole("list", { name: "What Wren can reach" });
    expect(within(list).getByText("This chat · Read and write")).toBeTruthy();
    expect(within(list).getByText(/^Always · used/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Revoke Send email to jane@example.com" }));
    expect(onRevoke).toHaveBeenCalledWith(expect.objectContaining({ id: "grant:g1" }));
  });

  it("shows an older folder that moved, with a one-tap Confirm (PR #1395)", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(
      <AccessListView
        persona="Wren"
        onRevoke={vi.fn()}
        onConfirm={onConfirm}
        entries={[
          {
            id: "folder:always:/Users/o/cloud/Notes",
            type: "folder",
            scope: "always",
            label: "/Users/o/cloud/Notes",
            path: "/Users/o/cloud/Notes",
            mode: "rw",
            refused: true,
            moved: true,
            movedTo: "/Users/o/real-cloud/Notes",
          },
        ]}
      />,
    );
    expect(
      screen.getByText(
        /Now points to \/Users\/o\/real-cloud\/Notes — confirm only if you moved it yourself/,
      ),
    ).toBeTruthy();
    await user.click(
      screen.getByRole("button", {
        name: "Confirm /Users/o/cloud/Notes again at /Users/o/real-cloud/Notes",
      }),
    );
    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ id: "folder:always:/Users/o/cloud/Notes" }),
    );
  });

  it("offers Reconnect <name>? for a renamed folder, and only taps re-point it", async () => {
    const user = userEvent.setup();
    const onReconnect = vi.fn();
    render(
      <AccessListView
        persona="Wren"
        onRevoke={vi.fn()}
        onReconnect={onReconnect}
        entries={[
          {
            id: "folder:always:/Users/o/Projects/app",
            type: "folder",
            scope: "always",
            label: "/Users/o/Projects/app",
            path: "/Users/o/Projects/app",
            mode: "rw",
            reconnectTo: "/Users/o/Projects/app-v2",
          },
        ]}
      />,
    );
    expect(
      screen.getByText(/Reconnect app\? It is now at \/Users\/o\/Projects\/app-v2/),
    ).toBeTruthy();
    expect(onReconnect).not.toHaveBeenCalled();
    await user.click(
      screen.getByRole("button", { name: "Reconnect app to /Users/o/Projects/app-v2" }),
    );
    expect(onReconnect).toHaveBeenCalledWith(
      expect.objectContaining({ reconnectTo: "/Users/o/Projects/app-v2" }),
    );
  });

  it("says why a moved folder cannot be reconnected, with no dead button", () => {
    render(
      <AccessListView
        persona="Wren"
        onRevoke={vi.fn()}
        onReconnect={vi.fn()}
        entries={[
          {
            id: "folder:always:/Users/o/Projects/app",
            type: "folder",
            scope: "always",
            label: "/Users/o/Projects/app",
            path: "/Users/o/Projects/app",
            mode: "rw",
            reconnectBlocked: true,
          },
        ]}
      />,
    );
    expect(screen.getByText(/app moved, but it can't be reconnected safely/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Reconnect/ })).toBeNull();
  });

  it("shows a folder that is a system folder today as refused, with Revoke", () => {
    render(
      <AccessListView
        persona="Wren"
        entries={[
          {
            id: "folder:always:/opt/homebrew",
            type: "folder",
            scope: "always",
            label: "/opt/homebrew",
            path: "/opt/homebrew",
            mode: "rw",
            refused: true,
          },
        ]}
        onRevoke={vi.fn()}
      />,
    );
    const list = screen.getByRole("list", { name: "What Wren can reach" });
    expect(within(list).getByText(/\/opt\/homebrew can't be shared/)).toBeTruthy();
    expect(within(list).queryByText(/Read and write/)).toBeNull();
    expect(within(list).getByRole("button", { name: /Revoke/ })).toBeTruthy();
  });

  it("says Psyche asks when nothing is granted yet", () => {
    render(<AccessListView persona="Wren" entries={[]} />);
    expect(screen.getByText(/it asks you in the chat/)).toBeTruthy();
  });
});

describe("Search → Model for search (Apple on-device, #1115)", () => {
  const status = (over: Partial<AppleLlmStatus> = {}): AppleLlmStatus => ({
    ref: "apple/on-device",
    helperConnected: true,
    available: true,
    contextTokens: 4096,
    ...over,
  });

  it("is hidden without a Mac helper, and defaults to the utility model", () => {
    const { container } = render(
      <SearchModelGroup
        status={status({ helperConnected: false })}
        values={{}}
        onChange={vi.fn()}
      />,
    );
    expect(container.textContent).toBe("");
    render(<SearchModelGroup status={status()} values={{}} onChange={vi.fn()} />);
    expect(
      screen.getByRole("radio", { name: /Your utility model/ }).getAttribute("aria-checked"),
    ).toBe("true");
    expect(screen.getByText("Ready on this Mac")).toBeTruthy();
  });

  it("says plainly what it is: on this Mac, nothing to download or key, about 4k tokens, no cloud fallback", () => {
    render(<SearchModelGroup status={status()} values={{}} onChange={vi.fn()} />);
    const option = screen.getByRole("radio", {
      name: /Use Apple.s on-device model for private search jobs/,
    });
    expect(option).toBeTruthy();
    const text = document.body.textContent ?? "";
    expect(text).toMatch(/stays on this Mac/);
    expect(text).toMatch(/nothing to download, no key/);
    expect(text).toMatch(/about 4k tokens/);
    expect(text).toMatch(/never falls back to a cloud model/);
  });

  it("writes search.model.engine and says plainly when Apple Intelligence is off", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { rerender } = render(
      <SearchModelGroup status={status()} values={{}} onChange={onChange} />,
    );
    await user.click(screen.getByRole("radio", { name: /Apple.s on-device model/ }));
    expect(onChange).toHaveBeenCalledWith("search.model.engine", "apple");
    rerender(
      <SearchModelGroup
        status={status({ available: false, reason: "apple_intelligence_not_enabled" })}
        values={{ "search.model.engine": "apple" }}
        onChange={onChange}
      />,
    );
    const chip = screen.getByText("Needs Apple Intelligence").closest("[data-tone]");
    expect(chip?.getAttribute("data-tone")).toBe("approval");
  });

  it.each([
    ["apple_intelligence_not_enabled", /Apple Intelligence is turned off/],
    ["unsupported_os", /needs macOS 26 or later/],
    ["device_not_eligible", /doesn.t support Apple Intelligence/],
    ["model_not_ready", /still getting the model ready/],
  ] as const)("is disabled and gives the reason when unavailable: %s", (reason, words) => {
    const onChange = vi.fn();
    render(
      <SearchModelGroup
        status={status({ available: false, reason })}
        values={{}}
        onChange={onChange}
      />,
    );
    const apple = screen.getByRole("radio", { name: /Apple.s on-device model/ });
    expect(apple.hasAttribute("disabled") || apple.hasAttribute("data-disabled")).toBe(true);
    expect(screen.getByTestId("apple-reason").textContent).toMatch(words);
    fireEvent.click(apple);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("when it was chosen and then went away it stays shown as chosen and says jobs are skipped", () => {
    render(
      <SearchModelGroup
        status={status({ available: false, reason: "apple_intelligence_not_enabled" })}
        values={{ "search.model.engine": "apple" }}
        onChange={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("radio", { name: /Apple.s on-device model/ }).getAttribute("aria-checked"),
    ).toBe("true");
    expect(screen.getByTestId("apple-reason").textContent).toMatch(/those jobs are skipped/);
  });

  it("on a remote client window it is shown as the Host's setting", () => {
    render(
      <UiSlotsProvider value={{ remoteHost: "studio-mac" }}>
        <SearchModelGroup status={status()} values={{}} onChange={vi.fn()} />
      </UiSlotsProvider>,
    );
    expect(screen.getByTestId("apple-host-note").textContent).toMatch(/studio-mac.s setting/);
  });

  it("shows no Host note on This Mac", () => {
    render(<SearchModelGroup status={status()} values={{}} onChange={vi.fn()} />);
    expect(screen.queryByTestId("apple-host-note")).toBeNull();
  });

  it("cannot be chosen on a Mac that can't run it", () => {
    render(
      <SearchModelGroup
        status={status({ available: false, reason: "device_not_eligible" })}
        values={{}}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByText("Not available on this Mac")).toBeTruthy();
    const apple = screen.getByRole("radio", { name: /Apple.s on-device model/ });
    expect(apple.hasAttribute("disabled") || apple.hasAttribute("data-disabled")).toBe(true);
  });
});
