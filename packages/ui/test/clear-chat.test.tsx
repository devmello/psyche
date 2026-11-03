import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { AgentHeader } from "../src/agent/AgentHeader.tsx";
import { useClearChatHeader } from "../src/chat/ClearChatDialog.tsx";
import { COMMANDS, parseCommand } from "../src/chat/commands.ts";
import { ChatThread } from "../src/chat/Thread.tsx";
import type { MockGateway } from "../src/data/mock-gateway.ts";
import { type FixtureWorld, IDS } from "../src/fixtures/index.ts";
import { CommandPalette } from "../src/shell/CommandPalette.tsx";
import { StoryWorld } from "../src/stories/harness.tsx";

/**
 * Clear chat for the main chat: the ⋯ menu item, the confirm dialog with its "also forget"
 * checkbox, the ⌘K action, `/clear`, and the chat showing its empty state afterwards.
 */

const MAIN = IDS.threads.main;

const mainEntry = (w: FixtureWorld) => {
  const entry = w.threads.find((t) => t.thread.id === MAIN);
  if (entry === undefined) throw new Error("fixtures have no main chat");
  return entry;
};

/** The main chat at rest (the fixture has it waiting on two approvals, which also blocks a clear). */
const calmMain = (w: FixtureWorld) => {
  w.runs = w.runs.filter((r) => r.threadId !== MAIN);
  mainEntry(w).activity = { running: 0, awaitingInput: 0, awaitingApproval: 0 };
};

/** A run working in the main chat, so Clear chat is off. */
const busyMain = (w: FixtureWorld) => {
  calmMain(w);
  mainEntry(w).activity = { running: 1, awaitingInput: 0, awaitingApproval: 0 };
};

function Header({ kind = "main" }: { kind?: string }) {
  const clear = useClearChatHeader(MAIN, kind);
  return <AgentHeader onOpenSheet={() => {}} {...clear} />;
}

function Chat({ kind = "main" }: { kind?: string }) {
  return (
    <>
      <Header kind={kind} />
      <ChatThread threadId={MAIN} />
    </>
  );
}

const openMenu = async () => {
  await userEvent.click(screen.getByRole("button", { name: "More" }));
};

describe("Clear chat in the header menu", () => {
  it("is in the main chat's ⋯ menu, and not in any other chat's", async () => {
    const { unmount } = render(
      <StoryWorld>
        <Header />
      </StoryWorld>,
    );
    await openMenu();
    expect(await screen.findByRole("menuitem", { name: "Clear chat…" })).toBeTruthy();
    unmount();
    render(
      <StoryWorld>
        <Header kind="side" />
      </StoryWorld>,
    );
    await openMenu();
    await screen.findByRole("menuitem", { name: /Approvals and memory/ });
    expect(screen.queryByRole("menuitem", { name: "Clear chat…" })).toBeNull();
  });

  it("is off, with the reason, while the chat is working", async () => {
    render(
      <StoryWorld edit={busyMain}>
        <Chat />
      </StoryWorld>,
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "More" })).toBeTruthy());
    await openMenu();
    const item = await screen.findByRole("menuitem", { name: /Clear chat…/ });
    await waitFor(() => expect(item.getAttribute("aria-disabled")).toBe("true"));
    expect(within(item).getByText(/Not while .* is working/)).toBeTruthy();
    await userEvent.click(item);
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});

describe("the Clear chat dialog", () => {
  async function openDialog() {
    await openMenu();
    await userEvent.click(await screen.findByRole("menuitem", { name: "Clear chat…" }));
    return screen.findByRole("alertdialog", { name: "Clear the main chat?" });
  }

  it("says what goes and what stays, with the destructive confirm and the forget box off", async () => {
    render(
      <StoryWorld edit={calmMain}>
        <Chat />
      </StoryWorld>,
    );
    const dialog = await openDialog();
    expect(dialog.textContent).toMatch(/starts fresh\. Receipts and the activity log are kept/);
    const box = within(dialog).getByRole("checkbox", {
      name: /Also forget what .* learned from this chat/,
    });
    expect(box.getAttribute("aria-checked")).toBe("false");
    const confirm = within(dialog).getByRole("button", { name: "Clear chat" });
    // The existing destructive button variant, not a new colour.
    expect(confirm.className).toContain("bg-danger-surface");
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });

  it("clears with threads.clear and shows the empty chat", async () => {
    let gw: MockGateway | null = null;
    render(
      <StoryWorld edit={calmMain} onGateway={(g) => (gw = g)}>
        <Chat />
      </StoryWorld>,
    );
    await waitFor(() => expect(screen.getAllByRole("article").length).toBeGreaterThan(0));
    const dialog = await openDialog();
    await userEvent.click(within(dialog).getByRole("button", { name: "Clear chat" }));
    const g = gw as unknown as MockGateway;
    await waitFor(() => expect(g.calls.some((c) => c.method === "threads.clear")).toBe(true));
    expect(g.calls.find((c) => c.method === "threads.clear")?.params).toEqual({ threadId: MAIN });
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(await screen.findByTestId("chat-empty")).toBeTruthy();
    expect(screen.queryAllByRole("article")).toHaveLength(0);
    expect(g.world.messages.some((m) => m.threadId === MAIN)).toBe(false);
  });

  it("sends alsoForget when the box is ticked", async () => {
    let gw: MockGateway | null = null;
    render(
      <StoryWorld edit={calmMain} onGateway={(g) => (gw = g)}>
        <Chat />
      </StoryWorld>,
    );
    const dialog = await openDialog();
    await userEvent.click(
      within(dialog).getByRole("checkbox", { name: /Also forget what .* learned/ }),
    );
    await userEvent.click(within(dialog).getByRole("button", { name: "Clear chat" }));
    const g = gw as unknown as MockGateway;
    await waitFor(() =>
      expect(g.calls.find((c) => c.method === "threads.clear")?.params).toEqual({
        threadId: MAIN,
        alsoForget: true,
      }),
    );
  });

  it("keeps the dialog and says so when the Gateway refuses", async () => {
    let gw: MockGateway | null = null;
    render(
      <StoryWorld edit={calmMain} onGateway={(g) => (gw = g)}>
        <Chat />
      </StoryWorld>,
    );
    const dialog = await openDialog();
    (gw as unknown as MockGateway).failNext("threads.clear", "conflict");
    await userEvent.click(within(dialog).getByRole("button", { name: "Clear chat" }));
    expect(await within(dialog).findByRole("alert")).toBeTruthy();
    expect(within(dialog).getByRole("alert").textContent).toMatch(/working in this chat/);
    expect(screen.getByRole("alertdialog")).toBeTruthy();
  });
});

describe("⌘K → Clear the main chat", () => {
  function Host({ onNavigate }: { onNavigate: (r: string) => void }) {
    const [open, setOpen] = useState(true);
    return (
      <>
        <ChatThread threadId={MAIN} />
        <CommandPalette open={open} onOpenChange={setOpen} onNavigate={onNavigate} />
      </>
    );
  }

  it("opens the same dialog", async () => {
    const onNavigate = vi.fn();
    render(
      <StoryWorld edit={calmMain}>
        <Host onNavigate={onNavigate} />
      </StoryWorld>,
    );
    const palette = await screen.findByRole("dialog", { name: "Command palette" });
    await userEvent.type(within(palette).getByRole("combobox"), "clear the main");
    const option = await within(palette).findByRole("option", { name: /Clear the main chat/ });
    await userEvent.click(option);
    expect(await screen.findByRole("alertdialog", { name: "Clear the main chat?" })).toBeTruthy();
    expect(onNavigate).toHaveBeenCalledWith(`/chat/${MAIN}`);
  });

  it("is listed but cannot run while the chat is working", async () => {
    const onNavigate = vi.fn();
    render(
      <StoryWorld edit={busyMain}>
        <Host onNavigate={onNavigate} />
      </StoryWorld>,
    );
    const palette = await screen.findByRole("dialog", { name: "Command palette" });
    await userEvent.type(within(palette).getByRole("combobox"), "clear the main");
    const option = await within(palette).findByRole("option", { name: /Clear the main chat/ });
    await waitFor(() => expect(option.textContent).toMatch(/is working in this chat/));
    await userEvent.click(option);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(onNavigate).not.toHaveBeenCalled();
  });
});

describe("/clear", () => {
  it("is a command without arguments", () => {
    expect(COMMANDS.some((c) => c.name === "clear" && c.arity === "none")).toBe(true);
    expect(parseCommand("/clear")).toEqual({ type: "command", name: "clear", arg: "" });
    expect(parseCommand("/clear now").type).toBe("error");
  });

  it("opens the dialog in the main chat", async () => {
    render(
      <StoryWorld edit={calmMain}>
        <ChatThread threadId={MAIN} />
      </StoryWorld>,
    );
    const box = await screen.findByRole("textbox", { name: /^Message / });
    await userEvent.type(box, "/clear{Enter}");
    expect(await screen.findByRole("alertdialog", { name: "Clear the main chat?" })).toBeTruthy();
  });

  it("points a side chat to /new instead", async () => {
    render(
      <StoryWorld>
        <ChatThread threadId={IDS.threads.dentist} />
      </StoryWorld>,
    );
    const box = await screen.findByRole("textbox", { name: /^Message / });
    await userEvent.type(box, "/clear{Enter}");
    expect(await screen.findByText(/Use \/new for a fresh side chat/)).toBeTruthy();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});
