import { render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AgentHeader } from "../src/agent/AgentHeader.tsx";
import { ChatThread } from "../src/chat/Thread.tsx";
import { IDS } from "../src/fixtures/index.ts";
import { SHORTCUTS, useShortcuts } from "../src/shell/shortcuts.ts";
import { StoryWorld } from "../src/stories/harness.tsx";

const NOW = Date.parse("2026-10-18T09:21:00Z");

function Header() {
  return (
    <AgentHeader
      onOpenSheet={() => {}}
      onOpenApprovals={() => {}}
      model="anthropic/claude-sonnet-5-5"
      onOpenModelPicker={() => {}}
      disclosure={1}
      onDisclosureChange={() => {}}
      onExport={() => {}}
      onCompact={() => {}}
      onContextLimits={() => {}}
      onClearChat={() => {}}
    />
  );
}

function Keys({ mode, model }: { mode: () => void; model: () => void }) {
  useShortcuts({ permissionMode: mode, modelPicker: model });
  return null;
}

describe("chat header (desktop simplicity, wave B)", () => {
  it("has at most four controls: avatar, one status and ⋯, with no bell and no 'need you' link", async () => {
    render(
      <StoryWorld>
        <Header />
      </StoryWorld>,
    );
    const toolbar = await screen.findByRole("toolbar", { name: "Chat toolbar" });
    const controls = within(toolbar).getAllByRole("button");
    expect(controls.length).toBeLessThanOrEqual(4);
    // The fixture world has approvals waiting: the one status is an amber count, not a link.
    const status = await within(toolbar).findByTestId("header-status");
    expect(status.getAttribute("aria-label")).toMatch(/need you|needs you/);
    expect(within(toolbar).queryByRole("button", { name: /Notifications/ })).toBeNull();
    expect(within(toolbar).queryByText(/need you/)).toBeNull();
    expect(within(toolbar).queryByTestId("toolbar-pills")).toBeNull();
  });

  it("keeps the ⋯ menu short: model, approvals and memory, Export chat, Advanced, Clear chat", async () => {
    render(
      <StoryWorld>
        <Header />
      </StoryWorld>,
    );
    await userEvent.click(await screen.findByRole("button", { name: "More" }));
    // The mode is not here any more: it is the picker in the composer bar.
    expect(screen.queryByTestId("mode-menu")).toBeNull();
    expect(screen.queryByRole("menuitemradio", { name: /balanced/i })).toBeNull();
    const model = await screen.findByRole("menuitem", { name: /Model: Sonnet 5.5/ });
    expect(model.getAttribute("aria-keyshortcuts")).toBe("Meta+Shift+I");
    const items = screen.getAllByRole("menuitem").map((i) => i.textContent?.trim());
    expect(items).toHaveLength(5);
    expect(items[1]).toMatch(/Approvals and memory/);
    expect(items[2]).toMatch(/Export chat/);
    expect(items[3]).toMatch(/Advanced/);
    expect(items[4]).toMatch(/Clear chat/);
    // The developer tools sit behind Advanced, not in the first menu.
    expect(screen.queryByText("Raw tool I/O")).toBeNull();
    expect(screen.queryByText("Compact now")).toBeNull();
    expect(screen.queryByText("Export as Markdown")).toBeNull();
  });

  it("puts transcript view, context limits and compact under Advanced, and the formats under Export chat", async () => {
    const onExport = vi.fn();
    const onCompact = vi.fn();
    render(
      <StoryWorld>
        <AgentHeader
          onOpenSheet={() => {}}
          disclosure={1}
          onDisclosureChange={() => {}}
          onExport={onExport}
          onCompact={onCompact}
          onContextLimits={() => {}}
        />
      </StoryWorld>,
    );
    await userEvent.click(await screen.findByRole("button", { name: "More" }));
    await userEvent.click(await screen.findByTestId("advanced-submenu"));
    expect(await screen.findByRole("menuitemradio", { name: "Raw tool I/O" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Compact now" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /Context limits/ })).toBeTruthy();
    await userEvent.click(screen.getByRole("menuitem", { name: "Compact now" }));
    expect(onCompact).toHaveBeenCalledTimes(1);
    await userEvent.click(await screen.findByRole("button", { name: "More" }));
    await userEvent.click(await screen.findByTestId("export-submenu"));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Export as JSON" }));
    expect(onExport).toHaveBeenCalledWith("json");
  });

  it("still answers ⌘⇧M (mode) and ⌘⇧I (model)", async () => {
    const mode = vi.fn();
    const model = vi.fn();
    render(<Keys mode={mode} model={model} />);
    const meta = navigator.platform.toLowerCase().includes("mac");
    const press = (key: string) =>
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key,
          shiftKey: true,
          metaKey: meta,
          ctrlKey: !meta,
          bubbles: true,
          cancelable: true,
        }),
      );
    press("M");
    press("I");
    // The shortcut map is the source of truth: both are still bound.
    expect(SHORTCUTS.some((s) => s.id === "permissionMode")).toBe(true);
    expect(SHORTCUTS.some((s) => s.id === "modelPicker")).toBe(true);
    expect(mode).toHaveBeenCalledTimes(1);
    expect(model).toHaveBeenCalledTimes(1);
  });

  it("has no segmented mode strip above the composer", async () => {
    render(
      <StoryWorld>
        <div style={{ height: 900 }}>
          <ChatThread threadId={IDS.threads.dentist} now={NOW} />
        </div>
      </StoryWorld>,
    );
    await screen.findByTestId("approval-dock");
    expect(screen.queryByTestId("mode-switch")).toBeNull();
    expect(screen.queryByRole("radiogroup", { name: "Permissions" })).toBeNull();
    // The one mode control is a pop-up button in the composer bar, always showing the mode.
    const picker = await screen.findByTestId("mode-picker");
    expect(picker.textContent).toMatch(/Manual|Balanced|Auto|Full access|Plan/);
  });
});
