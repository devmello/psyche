import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { MockGateway } from "../src/data/mock-gateway.ts";
import { INITIAL_STATE, upsertMessage } from "../src/data/state.ts";
import { IDS } from "../src/fixtures/index.ts";
import { AppShell } from "../src/shell/AppShell.tsx";
import { SHORTCUTS } from "../src/shell/shortcuts.ts";
import { ThreadList } from "../src/shell/ThreadList.tsx";
import { STORY_NOW, StoryWorld } from "../src/stories/harness.tsx";

const ev = (init: KeyboardEventInit) => new KeyboardEvent("keydown", init);
const find = (id: string) => {
  const s = SHORTCUTS.find((x) => x.id === id);
  if (s === undefined) throw new Error(id);
  return s;
};

describe("keyboard map", () => {
  it("matches the §4.11 shortcuts with ⌘ on macOS and Ctrl elsewhere", () => {
    expect(find("palette").match(ev({ key: "k", metaKey: true }), true)).toBe(true);
    expect(find("palette").match(ev({ key: "k", ctrlKey: true }), false)).toBe(true);
    expect(find("palette").match(ev({ key: "k", ctrlKey: true }), true)).toBe(false);
    expect(find("cycleDisclosure").match(ev({ key: "o", ctrlKey: true }), true)).toBe(true);
    expect(find("approvals").match(ev({ key: "P", metaKey: true, shiftKey: true }), true)).toBe(
      true,
    );
    expect(find("stop").match(ev({ key: "Escape" }), true)).toBe(true);
  });
});

describe("ThreadList", () => {
  it("never offers to archive the main chat, and archives a side chat", async () => {
    let gateway: MockGateway | undefined;
    render(
      <StoryWorld onGateway={(g) => (gateway = g)}>
        <ThreadList activeThreadId={null} onOpen={() => {}} now={STORY_NOW} />
      </StoryWorld>,
    );
    await screen.findAllByTestId("thread-row");
    const main = document.querySelector<HTMLElement>('li[data-thread-kind="main"]');
    if (!main) throw new Error("no main chat row");
    await userEvent.click(within(main).getByRole("button", { name: /More for/ }));
    expect(screen.queryByRole("menuitem", { name: "Archive" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Rename" })).toBeNull();
    await userEvent.keyboard("{Escape}");

    const side = document.querySelector<HTMLElement>('li[data-thread-kind="side"]');
    if (!side) throw new Error("no side chat row");
    await userEvent.click(within(side).getByRole("button", { name: /More for/ }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Archive" }));
    await waitFor(() =>
      expect(gateway?.calls.some((c) => c.method === "threads.archive")).toBe(true),
    );
  });
});

describe("AppShell", () => {
  it("opens the command palette with the keyboard and navigates", async () => {
    const routes: string[] = [];
    render(
      <StoryWorld>
        <AppShell
          route={`/chat/${IDS.threads.dentist}`}
          onNavigate={(r) => routes.push(r)}
          now={STORY_NOW}
        />
      </StoryWorld>,
    );
    await screen.findByRole("log", { name: "Conversation" });
    await userEvent.keyboard("{Meta>}k{/Meta}{Control>}k{/Control}");
    const input = await screen.findByPlaceholderText("Search or type a command");
    await userEvent.type(input, "Go to Feed");
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(routes).toContain("/feed"));
  });
});

describe("ThreadList last line (§2.2)", () => {
  it("shows each thread's last line and filters on it", async () => {
    render(
      <StoryWorld
        edit={(w) => {
          const entry = w.threads.find((t) => t.thread.id === IDS.threads.lisbon);
          if (entry) {
            (entry as { lastMessage?: unknown }).lastMessage = {
              role: "agent",
              text: "Flights on the 14th are cheapest.",
              at: entry.thread.updatedAt,
            };
          }
        }}
      >
        <ThreadList activeThreadId={null} onOpen={() => {}} now={STORY_NOW} />
      </StoryWorld>,
    );
    // One-line rows (redesign §5.1): the last line is the row's tooltip, and the filter matches it.
    const lisbon = await screen.findByTitle("Flights on the 14th are cheapest.");
    expect(lisbon.getAttribute("data-testid")).toBe("thread-row");
    await userEvent.click(screen.getByRole("button", { name: "Filter" }));
    await userEvent.type(screen.getByRole("searchbox", { name: "Filter threads" }), "cheapest");
    const rows = screen.getAllByTestId("thread-row");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.getAttribute("title")).toBe("Flights on the 14th are cheapest.");
  });

  it("a committed message becomes its thread's last line", () => {
    const thread = {
      thread: { id: "t1", title: "T", lastMessageAt: null },
      activity: { running: 0, awaitingInput: 0, awaitingApproval: 0 },
    } as never;
    const state = { ...INITIAL_STATE, threads: { t1: thread } };
    const next = upsertMessage(state, {
      id: "m1",
      threadId: "t1",
      seq: 1,
      role: "user",
      blocks: [{ type: "text", md: "**Find** my `1099` forms" }],
      provenance: "owner",
      createdAt: "2026-10-20T10:00:00.000Z",
    } as never);
    expect(next.threads.t1?.lastMessage).toEqual({
      role: "user",
      text: "Find my 1099 forms",
      at: "2026-10-20T10:00:00.000Z",
    });
    expect(next.threads.t1?.thread.lastMessageAt).toBe("2026-10-20T10:00:00.000Z");
  });
});
