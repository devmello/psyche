import type { AppleLlmStatus } from "@psyche/protocol";
import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { MockGateway } from "../src/data/mock-gateway.ts";
import { AccessListView } from "../src/screens/settings/AccessList.tsx";
import { EssentialsPanel } from "../src/screens/settings/EssentialsSection.tsx";
import { SearchModelGroup } from "../src/screens/settings/SearchSection.tsx";
import { SettingsScreen } from "../src/screens/settings/SettingsScreen.tsx";
import { StoryWorld } from "../src/stories/harness.tsx";

/** Settings → Essentials and the Access list (docs/design/settings-2026.md §7). */

const sources = [
  { id: "mail" as const, label: "Mail", enabled: false },
  { id: "notes" as const, label: "Notes", enabled: true },
];

function panel(over: Partial<Parameters<typeof EssentialsPanel>[0]> = {}) {
  const onChange = vi.fn();
  const onSource = vi.fn();
  const onOpen = vi.fn();
  render(
    <EssentialsPanel
      values={{}}
      onChange={onChange}
      persona="Wren"
      model={{ ref: "anthropic/claude-sonnet-5-5", label: "Claude Sonnet 5.5", ready: true }}
      sources={sources}
      onSource={onSource}
      remembering
      onRemember={vi.fn()}
      onOpen={onOpen}
      {...over}
    />,
  );
  return { onChange, onSource, onOpen };
}

describe("Settings → Essentials", () => {
  it("shows the safe defaults: quiet hours on, brief off, Balanced, memory on", () => {
    panel();
    const sw = (name: string) => screen.getByRole("switch", { name }).getAttribute("aria-checked");
    expect(sw("Quiet hours")).toBe("true");
    expect(screen.getByText("From 22:00 to 08:00, notifications wait in the inbox.")).toBeTruthy();
    expect(sw("Morning brief")).toBe("false");
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
    const { onChange, onSource, onOpen } = panel();
    await user.click(screen.getByRole("switch", { name: "Mail" }));
    expect(onSource).toHaveBeenCalledWith("mail", true);
    await user.click(screen.getByRole("switch", { name: "Quiet hours" }));
    expect(onChange).toHaveBeenCalledWith("notifications.quietHours.enabled", false);
    await user.click(screen.getByRole("radio", { name: /Manual/ }));
    expect(onChange).toHaveBeenCalledWith("permissions.mode", "manual");
    await user.click(screen.getByRole("button", { name: "More in Search" }));
    expect(onOpen).toHaveBeenCalledWith("search");
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

  it("is the first page and where Settings opens", async () => {
    let gw: MockGateway | null = null;
    render(
      <StoryWorld onGateway={(g) => (gw = g)}>
        <SettingsScreen />
      </StoryWorld>,
    );
    expect(await screen.findByRole("heading", { level: 2, name: "Essentials" })).toBeTruthy();
    const nav = screen.getByRole("navigation", { name: "Settings sections" });
    expect(within(nav).getAllByRole("button")[0]?.textContent).toBe("Essentials");
    await userEvent.click(await screen.findByRole("switch", { name: "Morning brief" }));
    await waitFor(() =>
      expect(
        gw?.calls.find(
          (c) =>
            c.method === "settings.set" &&
            (c.params as { key: string }).key === "daily.brief.enabled",
        )?.params,
      ).toMatchObject({ value: true }),
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
    expect(screen.getByText(/nothing is sent to the cloud/)).toBeTruthy();
    expect(screen.getByText("Ready on this Mac")).toBeTruthy();
  });

  it("writes search.model.engine and says plainly when Apple Intelligence is off", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { rerender } = render(
      <SearchModelGroup status={status()} values={{}} onChange={onChange} />,
    );
    await user.click(screen.getByRole("radio", { name: /Apple on-device model/ }));
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

  it("cannot be chosen on a Mac that can't run it", () => {
    render(
      <SearchModelGroup
        status={status({ available: false, reason: "device_not_eligible" })}
        values={{}}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByText("Not available on this Mac")).toBeTruthy();
    const apple = screen.getByRole("radio", { name: /Apple on-device model/ });
    expect(apple.hasAttribute("disabled") || apple.hasAttribute("data-disabled")).toBe(true);
  });
});
