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
      mode="balanced"
      onModeChange={() => {}}
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

  it("keeps mode (with the Auto explainer), model and the shortcuts in the ⋯ menu", async () => {
    render(
      <StoryWorld>
        <Header />
      </StoryWorld>,
    );
    await userEvent.click(await screen.findByRole("button", { name: "More" }));
    const modeMenu = await screen.findByTestId("mode-menu");
    for (const name of [/manual/i, /balanced/i, /auto/i])
      expect(within(modeMenu).getByRole("menuitemradio", { name })).toBeTruthy();
    expect(within(modeMenu).getByTestId("mode-menu-auto-explainer").textContent).toMatch(
      /Auto runs routine actions/,
    );
    expect(modeMenu.textContent).toMatch(/⇧|Shift/);
    const model = screen.getByRole("menuitem", { name: /Model: Sonnet 5.5/ });
    expect(model.getAttribute("aria-keyshortcuts")).toBe("Meta+Shift+I");
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
    expect(screen.queryByRole("radiogroup", { name: "Permission mode" })).toBeNull();
  });
});
