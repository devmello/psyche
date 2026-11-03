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
  it("puts matching actions first, then the hits by kind", () => {
    const groups = surfaceGroups(hits, [{ id: "a", label: "Go to dentist notes" }], "dentist");
    expect(groups[0]?.id).toBe("actions");
    expect(groups.slice(1).every((g) => g.items.every((i) => i.kind === "hit"))).toBe(true);
    expect(groups.length).toBeGreaterThan(1);
    expect(surfaceGroups([], [{ id: "b", label: "Open Feed" }], "dentist")).toEqual([]);
  });

  it("keeps actions ahead of people, projects and facts too", () => {
    const entity = { id: "e1", kind: "person", name: "Dr Dentist" } as never;
    const fact = { factId: "f1", entity } as never;
    const groups = surfaceGroups(
      hits,
      [{ id: "a", label: "Go to dentist notes" }],
      "dentist",
      [entity],
      [fact],
    );
    expect(groups.map((g) => g.id).slice(0, 3)).toEqual(["actions", "people", "life"]);
  });

  it("lists every action, first and alone, for an empty query", () => {
    const actions = [
      { id: "a", label: "Go to Home" },
      { id: "b", label: "Open Settings" },
    ];
    const groups = surfaceGroups([], actions, "");
    expect(groups.map((g) => g.id)).toEqual(["actions"]);
    expect(groups[0]?.items.map((i) => (i.kind === "action" ? i.action.id : ""))).toEqual([
      "a",
      "b",
    ]);
    // Even handed hits (a stale result set), actions stay on top and in the host's order.
    expect(surfaceGroups(hits, actions, "")[0]?.id).toBe("actions");
  });

  it("starts the selection on the first action when one matches, and on a hit otherwise", () => {
    render(<Surface actions={[{ id: "a", label: "Go to dentist notes" }]} />);
    const options = screen.getAllByRole("option");
    expect(options[0]?.textContent).toContain("Go to dentist notes");
    expect(options[0]?.getAttribute("aria-selected")).toBe("true");
    expect(options.filter((o) => o.getAttribute("aria-selected") === "true")).toHaveLength(1);
  });

  it("selects the first hit when no action matches", () => {
    render(<Surface actions={[{ id: "b", label: "Open Feed" }]} />);
    const options = screen.getAllByRole("option");
    expect(options[0]?.getAttribute("aria-selected")).toBe("true");
    expect(options[0]?.textContent).not.toContain("Open Feed");
  });

  it("runs the first action on Enter before any hit", async () => {
    const onRunAction = vi.fn();
    const onOpen = vi.fn();
    render(
      <Surface
        actions={[{ id: "a", label: "Go to dentist notes" }]}
        {...{ onRunAction, onOpen }}
      />,
    );
    await userEvent.type(screen.getByRole("combobox"), "{Enter}");
    expect(onRunAction).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }));
    expect(onOpen).not.toHaveBeenCalled();
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

  it("opens in a side chat with ⌘L (Ctrl+L off the Mac), and leaves the key alone without one", async () => {
    const onOpen = vi.fn();
    const onOpenInSideChat = vi.fn();
    const { unmount } = render(
      <StoryWorld>
        <Surface onOpen={onOpen} onOpenInSideChat={onOpenInSideChat} />
      </StoryWorld>,
    );
    screen.getByRole("combobox").focus();
    await userEvent.keyboard(isMac() ? "{Meta>}l{/Meta}" : "{Control>}l{/Control}");
    expect(onOpenInSideChat).toHaveBeenCalledTimes(1);
    expect(onOpenInSideChat.mock.calls[0]?.[0]).toBe(hits[0]);
    expect(onOpen).not.toHaveBeenCalled();
    expect(screen.getByTestId("search-hints").textContent).toContain(isMac() ? "⌘L" : "Ctrl L");
    unmount();

    // Without a side chat to open, ⌘L is not ours: the browser keeps its address bar.
    const press = vi.fn();
    render(
      <StoryWorld>
        <Surface onOpen={onOpen} />
      </StoryWorld>,
    );
    const field = screen.getByRole("combobox");
    field.addEventListener("keydown", (e) => press(e.defaultPrevented));
    field.focus();
    await userEvent.keyboard(isMac() ? "{Meta>}l{/Meta}" : "{Control>}l{/Control}");
    expect(press).toHaveBeenCalledWith(false);
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

  it("opens on the first action, with an empty query and while typing", async () => {
    const run = vi.fn();
    render(
      <StoryWorld>
        <CommandPalette
          open
          onOpenChange={() => {}}
          onNavigate={() => {}}
          actions={[{ id: "dentist-pane", label: "Open the dentist pane", run }]}
        />
      </StoryWorld>,
    );
    const dialog = await screen.findByRole("dialog", { name: "Command palette" });
    const selected = () =>
      within(dialog)
        .getAllByRole("option")
        .find((o) => o.getAttribute("aria-selected") === "true");
    expect(within(dialog).getAllByRole("option")[0]?.textContent).toContain(
      "Open the dentist pane",
    );
    expect(selected()?.textContent).toContain("Open the dentist pane");
    await userEvent.type(within(dialog).getByRole("combobox"), "dentist");
    // Hits arrive after the debounce; the action stays first and selected.
    await within(dialog).findByRole("group", { name: /^Threads/ });
    const groups = within(dialog).getAllByRole("group");
    expect(groups[0]?.getAttribute("aria-label")).toMatch(/^Actions/);
    expect(selected()?.textContent).toContain("Open the dentist pane");
    await userEvent.keyboard("{Enter}");
    expect(run).toHaveBeenCalled();
  });

  it("searches the index and navigates to a hit", async () => {
    const onNavigate = vi.fn();
    render(
      <StoryWorld>
        <CommandPalette
          open
          onOpenChange={() => {}}
          onNavigate={onNavigate}
          initialQuery="dentist"
        />
      </StoryWorld>,
    );
    const dialog = await screen.findByRole("dialog", { name: "Command palette" });
    const threads = await within(dialog).findByRole("group", { name: /^Threads/ });
    await userEvent.click(within(threads).getAllByRole("option")[0] as HTMLElement);
    await waitFor(() => expect(onNavigate).toHaveBeenCalled());
  });
});

describe("⌘K → open in a side chat", () => {
  const chord = isMac() ? "{Meta>}l{/Meta}" : "{Control>}l{/Control}";

  it("hands the result to the shell's side chat and creates no thread of its own", async () => {
    const openSideChat = vi.fn();
    const onNavigate = vi.fn();
    const onOpenChange = vi.fn();
    const requests: string[] = [];
    render(
      <StoryWorld
        slots={{ openSideChat }}
        onGateway={(gw) => {
          const request = gw.request.bind(gw) as (
            m: string,
            p: unknown,
            o: unknown,
          ) => Promise<unknown>;
          // biome-ignore lint/suspicious/noExplicitAny: wraps the mock to record its calls
          (gw as any).request = (m: string, p: unknown, o: unknown) => {
            requests.push(m);
            return request(m, p, o);
          };
        }}
      >
        <CommandPalette
          open
          onOpenChange={onOpenChange}
          onNavigate={onNavigate}
          initialQuery="dentist"
        />
      </StoryWorld>,
    );
    const dialog = await screen.findByRole("dialog", { name: "Command palette" });
    await within(dialog).findByRole("group", { name: /^Threads/ });
    screen.getByRole("combobox").focus();
    await userEvent.keyboard(chord);
    await waitFor(() => expect(openSideChat).toHaveBeenCalledTimes(1));
    // The original is not cloned into the thread list, and nothing navigates away.
    expect(requests).toContain("search.query");
    expect(requests).not.toContain("threads.create");
    expect(onNavigate).not.toHaveBeenCalled();
    expect(openSideChat.mock.calls[0]?.[0]).toMatchObject({
      title: expect.stringMatching(/dentist/i),
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("without a pane, opens one new chat linked to the result, with it as context", async () => {
    const navigate = vi.fn();
    const created: unknown[] = [];
    render(
      <StoryWorld
        slots={{ navigate }}
        onGateway={(gw) => {
          const request = gw.request.bind(gw) as (
            m: string,
            p: unknown,
            o: unknown,
          ) => Promise<unknown>;
          // biome-ignore lint/suspicious/noExplicitAny: wraps the mock to record its calls
          (gw as any).request = (m: string, p: unknown, o: unknown) => {
            if (m === "threads.create") created.push(p);
            return request(m, p, o);
          };
        }}
      >
        <CommandPalette open onOpenChange={() => {}} onNavigate={vi.fn()} initialQuery="dentist" />
      </StoryWorld>,
    );
    const dialog = await screen.findByRole("dialog", { name: "Command palette" });
    await within(dialog).findByRole("group", { name: /^Threads/ });
    screen.getByRole("combobox").focus();
    await userEvent.keyboard(chord);
    await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ kind: "side", parentThreadId: expect.any(String) });
    expect(String(navigate.mock.calls[0]?.[0])).toMatch(/^\/chat\//);
  });

  it("opens a chat result itself on Enter", async () => {
    const openSideChat = vi.fn();
    const onNavigate = vi.fn();
    render(
      <StoryWorld slots={{ openSideChat }}>
        <CommandPalette
          open
          onOpenChange={() => {}}
          onNavigate={onNavigate}
          initialQuery="dentist"
        />
      </StoryWorld>,
    );
    const dialog = await screen.findByRole("dialog", { name: "Command palette" });
    await within(dialog).findByRole("group", { name: /^Threads/ });
    screen.getByRole("combobox").focus();
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(onNavigate).toHaveBeenCalledTimes(1));
    expect(String(onNavigate.mock.calls[0]?.[0])).toMatch(/^\/chat\//);
    expect(openSideChat).not.toHaveBeenCalled();
  });
});

describe("understood filter chips", () => {
  const understood = {
    natural: true,
    intent: "answer" as const,
    relaxed: "none" as const,
    query: "from:alex after:2026-10-12 before:2026-10-19 lease",
    chips: [
      {
        id: "time:last week",
        kind: "time" as const,
        label: "last week",
        token: "after:2026-10-12 before:2026-10-19",
      },
      { id: "person:alex", kind: "person" as const, label: "Alex", token: "from:alex" },
      { id: "source:mail", kind: "source" as const, label: "mail", token: "source:mail" },
    ],
  };

  it("shows them as removable chips", async () => {
    const onDropChip = vi.fn();
    render(
      <StoryWorld>
        <SearchSurface
          variant="page"
          query="what did Alex send about the lease last week"
          onQueryChange={() => undefined}
          hits={hits}
          understood={understood}
          onDropChip={onDropChip}
        />
      </StoryWorld>,
    );
    const list = screen.getByRole("list", { name: "Understood filters" });
    expect(within(list).getByText("Last week")).toBeTruthy();
    expect(within(list).getByText("From Alex")).toBeTruthy();
    expect(within(list).getByText("In email")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Remove From Alex" }));
    expect(onDropChip).toHaveBeenCalledWith("person:alex");
  });

  it("hides chips that were relaxed and says so", () => {
    render(
      <StoryWorld>
        <SearchSurface
          variant="page"
          query="what did Alex send about the lease last week"
          onQueryChange={() => undefined}
          hits={hits}
          understood={{ ...understood, relaxed: "filters" }}
        />
      </StoryWorld>,
    );
    expect(screen.queryByRole("list", { name: "Understood filters" })).toBeNull();
    expect(screen.getByText(/Nothing matched all of your filters/)).toBeTruthy();
  });
});
