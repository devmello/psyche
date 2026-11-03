import type { SearchSourcesStatus } from "@psyche/protocol";
import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { MockGateway } from "../src/data/mock-gateway.ts";
import { SearchSourcesSettingsGroup } from "../src/screens/settings/SearchSourcesSettings.tsx";
import { StoryWorld } from "../src/stories/harness.tsx";

const NOW = Date.UTC(2026, 9, 28, 12, 0, 0);
const base = (
  over: Partial<SearchSourcesStatus["sources"][number]> & {
    id: SearchSourcesStatus["sources"][number]["id"];
  },
) => ({
  label: over.id,
  enabled: false,
  processing: "cloud" as const,
  agent: over.id !== "messages",
  ocr: false,
  state: "off" as const,
  items: 0,
  textBytes: 0,
  backfilled: false,
  ...over,
});

const status: SearchSourcesStatus = {
  sources: [
    base({
      id: "mail",
      label: "Mail",
      enabled: true,
      state: "idle",
      items: 120,
      textBytes: 2_400_000,
      lastIndexedAt: NOW - 3_600_000 * 3,
      backfilled: true,
    }),
    base({ id: "messages", label: "Messages" }),
    base({
      id: "files",
      label: "Files",
      enabled: true,
      state: "unavailable",
      detail: "no folder has been shared",
    }),
  ],
  exclude: { contacts: ["mum@example.com"], chats: [], accounts: [], folders: [] },
  indexBytes: 5_000_000,
};

describe("search sources settings", () => {
  it("lists sources off by default, with counts, last indexed time and size", () => {
    render(
      <StoryWorld>
        <SearchSourcesSettingsGroup
          status={status}
          onConfigure={vi.fn()}
          onRebuild={vi.fn()}
          now={NOW}
        />
      </StoryWorld>,
    );
    expect(screen.getByRole("switch", { name: "Messages" }).getAttribute("aria-checked")).toBe(
      "false",
    );
    expect(screen.getByText("Off: not read")).toBeTruthy();
    expect(screen.getByText("Up to date: 120 items")).toBeTruthy();
    expect(screen.getByText(/Last indexed 3 h ago · 2\.4 MB/)).toBeTruthy();
    expect(screen.getByText("On, but not available: no folder has been shared")).toBeTruthy();
    expect(screen.getByText("Search index size: 5.0 MB")).toBeTruthy();
  });

  it("switches a source, sets its processing model, rebuilds, and saves exclusions", async () => {
    const onConfigure = vi.fn();
    const onRebuild = vi.fn();
    render(
      <StoryWorld>
        <SearchSourcesSettingsGroup
          status={status}
          onConfigure={onConfigure}
          onRebuild={onRebuild}
          now={NOW}
        />
      </StoryWorld>,
    );
    await userEvent.click(screen.getByRole("switch", { name: "Messages" }));
    expect(onConfigure).toHaveBeenCalledWith({ source: "messages", enabled: true });
    await userEvent.click(screen.getByRole("switch", { name: "Mail" }));
    expect(onConfigure).toHaveBeenCalledWith({ source: "mail", enabled: false });
    await userEvent.selectOptions(screen.getByLabelText("Processing for Mail"), "none");
    expect(onConfigure).toHaveBeenCalledWith({ source: "mail", processing: "none" });
    await userEvent.click(screen.getByLabelText("Agent search for Mail"));
    expect(onConfigure).toHaveBeenCalledWith({ source: "mail", agent: false });
    // Reading text in images is Files only, and off until the owner ticks it.
    expect(screen.queryByLabelText("Read text in images for Mail")).toBeNull();
    const ocr = screen.getByLabelText("Read text in images for Files") as HTMLInputElement;
    expect(ocr.checked).toBe(false);
    await userEvent.click(ocr);
    expect(onConfigure).toHaveBeenCalledWith({ source: "files", ocr: true });
    await userEvent.click(screen.getByRole("button", { name: "Rebuild Mail" }));
    expect(onRebuild).toHaveBeenCalledWith("mail");
    const input = screen.getByLabelText("Never index these contacts");
    await userEvent.clear(input);
    await userEvent.type(input, "mum@example.com, +1 510 555 0101");
    await userEvent.tab();
    expect(onConfigure).toHaveBeenLastCalledWith({
      exclude: { contacts: ["mum@example.com", "+1 510 555 0101"] },
    });
  });
});

describe("the Memory source", () => {
  const withMemory = (over: Partial<SearchSourcesStatus["sources"][number]> = {}) => ({
    ...status,
    sources: [...status.sources, base({ id: "memory", label: "Memory", agent: false, ...over })],
  });

  it("is a row like the others: off, owner-only for the agent, with what it leaves out", async () => {
    const onConfigure = vi.fn();
    render(
      <StoryWorld>
        <SearchSourcesSettingsGroup status={withMemory()} onConfigure={onConfigure} now={NOW} />
      </StoryWorld>,
    );
    const sw = screen.getByRole("switch", { name: "Memory" });
    expect(sw.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText(/Anything sensitive, still waiting for review/)).toBeTruthy();
    expect(screen.getByText(/Memory doesn't learn from this index/)).toBeTruthy();
    await userEvent.click(sw);
    expect(onConfigure).toHaveBeenCalledWith({ source: "memory", enabled: true });
  });

  it("shows its count, a Rebuild, and an agent switch that starts off, once on", async () => {
    const onRebuild = vi.fn();
    const onConfigure = vi.fn();
    render(
      <StoryWorld>
        <SearchSourcesSettingsGroup
          status={withMemory({ enabled: true, state: "idle", items: 42, backfilled: true })}
          onConfigure={onConfigure}
          onRebuild={onRebuild}
          now={NOW}
        />
      </StoryWorld>,
    );
    expect(screen.getByText("Up to date: 42 items")).toBeTruthy();
    const agent = screen.getByLabelText("Agent search for Memory") as HTMLInputElement;
    expect(agent.checked).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: "Rebuild Memory" }));
    expect(onRebuild).toHaveBeenCalledWith("memory");
  });

  it("greys the switch, saying why, while memory is encrypted and the search index is not", async () => {
    const onConfigure = vi.fn();
    render(
      <StoryWorld>
        <SearchSourcesSettingsGroup
          status={withMemory({ cannotEnable: "Turn on search index encryption first" })}
          onConfigure={onConfigure}
          now={NOW}
        />
      </StoryWorld>,
    );
    const sw = screen.getByRole("switch", { name: "Memory" });
    expect(sw.hasAttribute("data-disabled") || sw.getAttribute("aria-disabled") === "true").toBe(
      true,
    );
    expect(
      screen.getByText("Can't be switched on yet: Turn on search index encryption first"),
    ).toBeTruthy();
    await userEvent.click(sw);
    expect(onConfigure).not.toHaveBeenCalled();
  });

  it("greys the agent switch, saying why, while memory's agent access is none", () => {
    render(
      <StoryWorld>
        <SearchSourcesSettingsGroup
          status={withMemory({
            enabled: true,
            state: "idle",
            cannotAgent: "Memory's agent access is set to none",
          })}
          onConfigure={vi.fn()}
          now={NOW}
        />
      </StoryWorld>,
    );
    const agent = screen.getByLabelText("Agent search for Memory") as HTMLInputElement;
    expect(agent.disabled).toBe(true);
    expect(
      screen.getByText("The agent can't search this yet: Memory's agent access is set to none"),
    ).toBeTruthy();
    // Other sources are unaffected.
    expect((screen.getByLabelText("Agent search for Mail") as HTMLInputElement).disabled).toBe(
      false,
    );
  });
});

describe("Rebuild", () => {
  const show = (props: Parameters<typeof SearchSourcesSettingsGroup>[0]) =>
    render(
      <StoryWorld>
        <SearchSourcesSettingsGroup now={NOW} {...props} />
      </StoryWorld>,
    );

  it("is disabled for a source that is off, and says to turn it on first", () => {
    show({ status, onConfigure: vi.fn(), onRebuild: vi.fn() });
    const button = screen.getByRole("button", { name: "Rebuild Messages" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toBe("Turn Messages on first");
  });

  it("goes busy while the call is out, then says how many items were rebuilt", async () => {
    let finish: () => void = () => undefined;
    const onRebuild = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    show({ status, onConfigure: vi.fn(), onRebuild });
    await userEvent.click(screen.getByRole("button", { name: "Rebuild Mail" }));
    const busy = screen.getByRole("button", { name: "Rebuild Mail" }) as HTMLButtonElement;
    expect(busy.disabled).toBe(true);
    expect(busy.textContent).toBe("Rebuilding…");
    expect(screen.getByTestId("rebuild-mail").textContent).toBe("Rebuilding Mail…");
    finish();
    await waitFor(() =>
      expect(screen.getByTestId("rebuild-mail").textContent).toBe("Rebuilt Mail: 120 items."),
    );
    expect(
      (screen.getByRole("button", { name: "Rebuild Mail" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("shows progress while the source is still reading, then the final count as it finishes", async () => {
    const indexing: SearchSourcesStatus = {
      ...status,
      sources: status.sources.map((s) =>
        s.id === "mail" ? { ...s, state: "indexing" as const, items: 40, backfilled: false } : s,
      ),
    };
    const view = render(
      <StoryWorld>
        <SearchSourcesSettingsGroup status={indexing} onRebuild={vi.fn()} now={NOW} />
      </StoryWorld>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Rebuild Mail" }));
    await waitFor(() =>
      expect(screen.getByTestId("rebuild-mail").textContent).toBe(
        "Rebuilding Mail: 40 items read so far. It carries on in the background.",
      ),
    );
    // Still busy while it reads: pressing again would start it over.
    expect(
      (screen.getByRole("button", { name: "Rebuild Mail" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    view.rerender(
      <StoryWorld>
        <SearchSourcesSettingsGroup status={status} onRebuild={vi.fn()} now={NOW} />
      </StoryWorld>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("rebuild-mail").textContent).toBe("Rebuilt Mail: 120 items."),
    );
  });

  it("says why when the Gateway refuses, and leaves the button usable", async () => {
    const why =
      "Mail can't be read right now (the Mac helper is not connected), so it was left as it is.";
    show({ status, onConfigure: vi.fn(), onRebuild: vi.fn(() => Promise.reject(new Error(why))) });
    await userEvent.click(screen.getByRole("button", { name: "Rebuild Mail" }));
    await waitFor(() =>
      expect(screen.getByTestId("rebuild-mail").textContent).toBe(`Couldn't rebuild Mail: ${why}`),
    );
    expect(
      (screen.getByRole("button", { name: "Rebuild Mail" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("through the composed store: the call reaches the Gateway and a refusal is shown", async () => {
    let gateway: MockGateway | undefined;
    render(
      <StoryWorld
        edit={(w) => {
          w.searchSources = {
            sources: { mail: { enabled: true, processing: "cloud", agent: true } },
            exclude: { contacts: [], chats: [], accounts: [], folders: [] },
          };
        }}
        onGateway={(g) => (gateway = g)}
      >
        <SearchSourcesSettingsGroup now={NOW} />
      </StoryWorld>,
    );
    await userEvent.click(await screen.findByRole("button", { name: "Rebuild Mail" }));
    await waitFor(() =>
      expect(screen.getByTestId("rebuild-mail").textContent).toBe("Rebuilt Mail: 120 items."),
    );
    const why =
      'The Mac is on battery, so Mail can\'t be rebuilt now. Plug in, or turn on "Index on battery" in Settings → Search sources.';
    gateway?.failNext("search.sources.rebuild", "unavailable", why);
    await userEvent.click(screen.getByRole("button", { name: "Rebuild Mail" }));
    await waitFor(() =>
      expect(screen.getByTestId("rebuild-mail").textContent).toBe(`Couldn't rebuild Mail: ${why}`),
    );
  });
});

describe("Contacts and Index on battery", () => {
  const withContacts: SearchSourcesStatus = {
    ...status,
    sources: [...status.sources, base({ id: "contacts", label: "Contacts", agent: false })],
  };

  it("lists Contacts off, with what it reads and what it never reads, owner-only for the agent", async () => {
    const onConfigure = vi.fn();
    render(
      <StoryWorld>
        <SearchSourcesSettingsGroup status={withContacts} onConfigure={onConfigure} now={NOW} />
      </StoryWorld>,
    );
    const sw = screen.getByRole("switch", { name: "Contacts" });
    expect(sw.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText(/Street addresses, notes and groups are never read/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Rebuild Contacts" }).hasAttribute("disabled")).toBe(
      true,
    );
    // No agent checkbox while it is off; switching on is a plain configure call.
    expect(screen.queryByRole("checkbox", { name: "Agent search for Contacts" })).toBeNull();
    await userEvent.click(sw);
    expect(onConfigure).toHaveBeenCalledWith({ source: "contacts", enabled: true });
  });

  it("an enabled Contacts row has the agent box unticked, and Rebuild", async () => {
    const on: SearchSourcesStatus = {
      ...status,
      sources: [
        base({
          id: "contacts",
          label: "Contacts",
          agent: false,
          enabled: true,
          state: "idle",
          items: 312,
          backfilled: true,
        }),
      ],
    };
    const onRebuild = vi.fn();
    render(
      <StoryWorld>
        <SearchSourcesSettingsGroup
          status={on}
          onConfigure={vi.fn()}
          onRebuild={onRebuild}
          now={NOW}
        />
      </StoryWorld>,
    );
    expect(screen.getByText("Up to date: 312 items")).toBeTruthy();
    const agent = screen.getByRole("checkbox", { name: "Agent search for Contacts" });
    expect((agent as HTMLInputElement).checked).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: "Rebuild Contacts" }));
    expect(onRebuild).toHaveBeenCalledWith("contacts");
  });

  it("shows Index on battery off by default, with its hint, and writes the setting", async () => {
    const onChange = vi.fn();
    render(
      <StoryWorld>
        <SearchSourcesSettingsGroup status={status} values={{}} onChange={onChange} now={NOW} />
      </StoryWorld>,
    );
    const sw = screen.getByRole("switch", { name: "Index on battery" });
    expect(sw.getAttribute("aria-checked")).toBe("false");
    expect(
      screen.getByText(/It uses more battery\. Low Power Mode still pauses indexing\./),
    ).toBeTruthy();
    await userEvent.click(sw);
    expect(onChange).toHaveBeenCalledWith("search.runOnBattery", true);
  });

  it("reflects the stored setting", () => {
    render(
      <StoryWorld>
        <SearchSourcesSettingsGroup
          status={status}
          values={{ "search.runOnBattery": true }}
          onChange={vi.fn()}
          now={NOW}
        />
      </StoryWorld>,
    );
    expect(
      screen.getByRole("switch", { name: "Index on battery" }).getAttribute("aria-checked"),
    ).toBe("true");
  });
});
