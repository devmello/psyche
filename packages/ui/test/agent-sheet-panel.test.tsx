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
        <AgentSheetPanel tab="approvals" onTabChange={() => {}} onClose={onClose} now={STORY_NOW} />
      </StoryWorld>,
    );
    const panel = screen.getByRole("complementary", { name: "Agent" });
    expect(panel.getAttribute("data-presentation")).toBe("inline");
    expect(screen.queryByRole("dialog")).toBeNull();
    // Escape elsewhere in the window (the composer) doesn't close it.
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Composer" }), { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(within(panel).getByRole("tab", { name: /Approvals/ }), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(within(panel).getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("takes focus when it opens so Escape closes it at once, and gives focus back on close", () => {
    const onClose = vi.fn();
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    const { unmount } = render(
      <StoryWorld>
        <AgentSheetPanel tab="approvals" onTabChange={() => {}} onClose={onClose} now={STORY_NOW} />
      </StoryWorld>,
    );
    const tab = within(screen.getByRole("complementary", { name: "Agent" })).getByRole("tab", {
      name: /Approvals/,
    });
    expect(document.activeElement).toBe(tab);
    // Escape with focus where the panel put it: no click inside needed.
    fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    unmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it("does not take focus from a field the owner is typing in", () => {
    const field = document.createElement("textarea");
    document.body.append(field);
    field.focus();
    render(
      <StoryWorld>
        <AgentSheetPanel
          tab="approvals"
          onTabChange={() => {}}
          onClose={() => {}}
          now={STORY_NOW}
        />
      </StoryWorld>,
    );
    expect(document.activeElement).toBe(field);
    field.remove();
  });

  it("AppShell puts it beside the content with room for both, the modal sheet otherwise", () => {
    window.innerWidth = 1440;
    const { unmount } = render(
      <StoryWorld>
        <AppShell route="/feed" onNavigate={() => {}} defaultSheet="approvals" compact={false} />
      </StoryWorld>,
    );
    expect(screen.getByTestId("agent-sheet").getAttribute("data-presentation")).toBe("inline");
    expect(screen.queryByRole("dialog")).toBeNull();
    unmount();
    // 960 px with the full sidebar: 960 − 248 − 400 < 480.
    window.innerWidth = 960;
    const narrow = render(
      <StoryWorld>
        <AppShell route="/feed" onNavigate={() => {}} defaultSheet="approvals" compact={false} />
      </StoryWorld>,
    );
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByTestId("agent-sheet").getAttribute("data-presentation")).toBeNull();
    narrow.unmount();
    render(
      <StoryWorld>
        <AppShell route="/feed" onNavigate={() => {}} defaultSheet="approvals" compact />
      </StoryWorld>,
    );
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
});
