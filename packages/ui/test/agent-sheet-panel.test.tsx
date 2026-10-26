import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AgentSheetPanel } from "../src/agent/AgentSheet.tsx";
import { AppShell } from "../src/shell/AppShell.tsx";
import { STORY_NOW, StoryWorld } from "../src/stories/harness.tsx";

describe("the agent sheet beside the content (#625)", () => {
  it("is a labelled, non-modal panel that closes on × and on Escape inside it only", () => {
    const onClose = vi.fn();
    render(
      <StoryWorld>
        <input aria-label="Composer" />
        <AgentSheetPanel tab="activity" onTabChange={() => {}} onClose={onClose} now={STORY_NOW} />
      </StoryWorld>,
    );
    const panel = screen.getByRole("complementary", { name: "Agent" });
    expect(panel.getAttribute("data-presentation")).toBe("inline");
    expect(screen.queryByRole("dialog")).toBeNull();
    // Escape elsewhere in the window (the composer) doesn't close it.
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Composer" }), { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(within(panel).getByRole("tab", { name: /Activity/ }), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(within(panel).getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("AppShell puts it beside the content with room for both, the modal sheet otherwise", () => {
    window.innerWidth = 1440;
    const { unmount } = render(
      <StoryWorld>
        <AppShell route="/feed" onNavigate={() => {}} defaultSheet="upcoming" compact={false} />
      </StoryWorld>,
    );
    expect(screen.getByTestId("agent-sheet").getAttribute("data-presentation")).toBe("inline");
    expect(screen.queryByRole("dialog")).toBeNull();
    unmount();
    // 960 px with the full sidebar: 960 − 248 − 400 < 480.
    window.innerWidth = 960;
    const narrow = render(
      <StoryWorld>
        <AppShell route="/feed" onNavigate={() => {}} defaultSheet="upcoming" compact={false} />
      </StoryWorld>,
    );
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByTestId("agent-sheet").getAttribute("data-presentation")).toBeNull();
    narrow.unmount();
    render(
      <StoryWorld>
        <AppShell route="/feed" onNavigate={() => {}} defaultSheet="upcoming" compact />
      </StoryWorld>,
    );
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
});
