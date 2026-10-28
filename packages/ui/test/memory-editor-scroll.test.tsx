import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { SoulMemoryPanel } from "../src/agent/SoulMemoryPanel.tsx";
import { StoryWorld } from "../src/stories/harness.tsx";

const LONG = Array.from({ length: 400 }, (_, i) => `Line ${i + 1}`).join("\n");

describe("workspace file editor dialog layout", () => {
  it("bounds the dialog and makes the editor body the flex child that scrolls", async () => {
    render(
      <StoryWorld
        edit={(w) => {
          w.memoryFiles["AGENTS.md"] = LONG;
        }}
        slots={{
          renderEditor: ({ value }) => <textarea aria-label="slot editor" value={value} readOnly />,
        }}
      >
        <SoulMemoryPanel />
      </StoryWorld>,
    );
    await userEvent.click(await screen.findByRole("button", { name: "Open AGENTS.md" }));
    await screen.findByRole("textbox", { name: "slot editor" });

    const dialog = document.querySelector<HTMLElement>('[data-slot="dialog-content"]');
    expect(dialog).not.toBeNull();
    // Inside the viewport, clipped, and a column: nothing paints past it.
    for (const cls of ["flex", "flex-col", "overflow-hidden"]) {
      expect(dialog?.classList.contains(cls), cls).toBe(true);
    }
    expect(dialog?.className).toContain("max-h-[calc(100dvh-2rem)]");
    expect(dialog?.className).toMatch(/\bh-\[min\(85vh,/);

    const editor = dialog?.querySelector<HTMLElement>('[data-slot="memory-file-editor"]');
    const body = dialog?.querySelector<HTMLElement>('[data-slot="memory-file-body"]');
    for (const el of [editor, body]) {
      expect(el?.classList.contains("min-h-0")).toBe(true);
      expect(el?.classList.contains("flex-1")).toBe(true);
    }
    // The header (title) and the Save / Discard bar do not shrink away.
    expect(
      dialog?.querySelector('[data-slot="dialog-header"]')?.classList.contains("shrink-0"),
    ).toBe(true);
    expect(screen.getByRole("button", { name: "Discard" })).toBeTruthy();
  });

  it("the plain textarea fallback is its own scroll container", async () => {
    render(
      <StoryWorld
        edit={(w) => {
          w.memoryFiles["AGENTS.md"] = LONG;
        }}
      >
        <SoulMemoryPanel />
      </StoryWorld>,
    );
    await userEvent.click(await screen.findByRole("button", { name: "Open AGENTS.md" }));
    const box = await screen.findByRole("textbox", { name: "AGENTS.md contents" });
    for (const cls of ["min-h-0", "flex-1", "overflow-auto"]) {
      expect(box.classList.contains(cls), cls).toBe(true);
    }
  });
});
