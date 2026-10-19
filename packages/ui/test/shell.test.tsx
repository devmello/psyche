import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { MockGateway } from "../src/data/mock-gateway.ts";
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
    const main = await screen.findByRole("list", { name: "Main chat" });
    await userEvent.click(within(main).getByRole("button", { name: /More for/ }));
    expect(screen.queryByRole("menuitem", { name: "Archive" })).toBeNull();
    await userEvent.keyboard("{Escape}");

    const side = screen.getByRole("list", { name: "Side chats" });
    await userEvent.click(
      within(side).getAllByRole("button", { name: /More for/ })[0] as HTMLElement,
    );
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
