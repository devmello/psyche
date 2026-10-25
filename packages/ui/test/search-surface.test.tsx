import type { SearchHit } from "@psyche/protocol";
import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { createFixtureWorld } from "../src/fixtures/index.ts";
import { SearchSurface, surfaceGroups } from "../src/screens/search/SearchSurface.tsx";
import { CommandPalette, type PaletteAction } from "../src/shell/CommandPalette.tsx";
import { isMac } from "../src/shell/shortcuts.ts";
import { StoryWorld } from "../src/stories/harness.tsx";

const world = createFixtureWorld();
const hits: SearchHit[] = world.searchHits.filter((h) => h.title.toLowerCase().includes("dentist"));

function Surface(props: {
  variant?: "palette" | "page";
  actions?: PaletteAction[];
  onOpen?: (h: SearchHit) => void;
  onOpenInSideChat?: (h: SearchHit) => void;
  onRunAction?: (a: PaletteAction) => void;
  preview?: boolean;
  initial?: string;
}) {
  const [q, setQ] = useState(props.initial ?? "dentist");
  return (
    <SearchSurface
      variant={props.variant ?? "palette"}
      query={q}
      onQueryChange={setQ}
      hits={hits}
      actions={props.actions ?? []}
      preview={props.preview ?? false}
      {...(props.onOpen ? { onOpen: props.onOpen } : {})}
      {...(props.onOpenInSideChat ? { onOpenInSideChat: props.onOpenInSideChat } : {})}
      {...(props.onRunAction ? { onRunAction: props.onRunAction } : {})}
    />
  );
}

describe("search surface (redesign §5.5)", () => {
  it("groups hits by kind with matching actions last", () => {
    const groups = surfaceGroups(hits, [{ id: "a", label: "Go to dentist notes" }], "dentist");
    expect(groups.at(-1)?.id).toBe("actions");
    expect(groups.slice(0, -1).every((g) => g.items.every((i) => i.kind === "hit"))).toBe(true);
    expect(surfaceGroups([], [{ id: "b", label: "Open Feed" }], "dentist")).toEqual([]);
  });

  it("walks results with ↑ ↓ through aria-activedescendant and opens with Enter", async () => {
    const onOpen = vi.fn();
    render(
      <StoryWorld>
        <Surface onOpen={onOpen} />
      </StoryWorld>,
    );
    const field = screen.getByRole("combobox");
    const options = screen.getAllByRole("option");
    expect(options.length).toBeGreaterThan(1);
    expect(field.getAttribute("aria-activedescendant")).toBe(options[0]?.id);
    expect(options[0]?.getAttribute("aria-selected")).toBe("true");
    field.focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(field.getAttribute("aria-activedescendant")).toBe(options[1]?.id);
    await userEvent.keyboard("{Enter}");
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen.mock.calls[0]?.[0]).toBeTruthy();
  });

  it("opens in a side chat with ⌘↵ (Ctrl+↵ off the Mac)", async () => {
    const onOpen = vi.fn();
    const onOpenInSideChat = vi.fn();
    render(
      <StoryWorld>
        <Surface onOpen={onOpen} onOpenInSideChat={onOpenInSideChat} />
      </StoryWorld>,
    );
    screen.getByRole("combobox").focus();
    await userEvent.keyboard(isMac() ? "{Meta>}{Enter}{/Meta}" : "{Control>}{Enter}{/Control}");
    expect(onOpenInSideChat).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalled();
    expect(screen.getByTestId("search-hints").textContent).toMatch(/open in a side chat/);
  });

  it("shows typed filters as removable chips inside the field", async () => {
    render(
      <StoryWorld>
        <Surface initial="in:feed dentist" />
      </StoryWorld>,
    );
    const chips = screen.getByRole("list", { name: "Active filters" });
    expect(within(chips).getByText("in: Feed")).toBeTruthy();
    await userEvent.click(within(chips).getByRole("button", { name: "Remove filter in: Feed" }));
    expect(screen.getByRole("combobox")).toHaveProperty("value", "dentist");
  });

  it("previews the selected result when there is room", async () => {
    render(
      <StoryWorld>
        <Surface preview variant="page" />
      </StoryWorld>,
    );
    const preview = screen.getByRole("complementary", { name: "Preview" });
    const first = screen.getAllByRole("option")[0];
    expect(preview.textContent).toContain(first?.textContent?.split(":")[0]?.trim() ?? "");
    expect(within(preview).getByRole("button", { name: "Open" })).toBeTruthy();
  });
});

describe("⌘K palette", () => {
  it("lists actions in a labelled dialog and runs the chosen one", async () => {
    const onNavigate = vi.fn();
    const run = vi.fn();
    render(
      <StoryWorld>
        <CommandPalette
          open
          onOpenChange={() => {}}
          onNavigate={onNavigate}
          actions={[{ id: "browser", label: "Open the Browser pane", run }]}
        />
      </StoryWorld>,
    );
    const dialog = await screen.findByRole("dialog", { name: "Command palette" });
    const field = within(dialog).getByRole("combobox");
    expect(document.activeElement).toBe(field);
    expect(within(dialog).getByRole("group", { name: /^Actions/ })).toBeTruthy();
    await userEvent.type(field, "Browser pane");
    await userEvent.keyboard("{Enter}");
    expect(run).toHaveBeenCalled();
  });

  it("searches the index and navigates to a hit", async () => {
    const onNavigate = vi.fn();
    render(
      <StoryWorld>
        <CommandPalette open onOpenChange={() => {}} onNavigate={onNavigate} initialQuery="dentist" />
      </StoryWorld>,
    );
    const dialog = await screen.findByRole("dialog", { name: "Command palette" });
    const threads = await within(dialog).findByRole("group", { name: /^Threads/ });
    await userEvent.click(within(threads).getAllByRole("option")[0] as HTMLElement);
    await waitFor(() => expect(onNavigate).toHaveBeenCalled());
  });
});
