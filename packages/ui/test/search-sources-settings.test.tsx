import type { SearchSourcesStatus } from "@psyche/protocol";
import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
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
