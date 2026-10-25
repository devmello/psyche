// @vitest-environment happy-dom
import type { ThreadListEntry } from "@psyche/protocol";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { GatewayEvent } from "../../src/client/connection.ts";
import type { GatewayStatus } from "../../src/client/status.ts";
import { SHORTCUTS } from "../../src/shell/keyboard.ts";
import type { ShellPlatform } from "../../src/shell/platform.ts";
import { ShellApp } from "../../src/shell/ShellApp.tsx";

afterEach(() => {
  cleanup();
  window.innerWidth = 1280;
});

const T0 = "2026-10-24T10:00:00.000Z";
const MAIN = {
  thread: {
    id: "01JBXY6Q8Z0000000000000001",
    kind: "main",
    title: "Main chat",
    titleSource: "auto",
    parentThreadId: null,
    forkedFromMessageId: null,
    sessionKey: "owner:main",
    personaOverlay: null,
    permissionMode: "balanced",
    modelRef: null,
    pinned: false,
    archivedAt: null,
    expiresAt: null,
    activeWriterRunId: null,
    createdAt: T0,
    updatedAt: T0,
    lastMessageAt: T0,
  },
  activity: { running: 0, awaitingInput: 0, awaitingApproval: 0 },
} as unknown as ThreadListEntry;

function platformWith(stored: Record<string, string> = {}) {
  const storage = new Map(Object.entries(stored));
  const status: GatewayStatus = { phase: "paired", health: "ok", attempt: 0 };
  const platform: ShellPlatform = {
    kind: "web",
    gateway: {
      getStatus: async () => status,
      onStatus: (cb) => {
        cb(status);
        return () => {};
      },
      onEvent: (_cb: (e: GatewayEvent) => void) => () => {},
      onResync: () => () => {},
      call: async (method) => {
        if (method === "threads.list") return { threads: [MAIN], nextCursor: null };
        if (method === "approvals.list") return { approvals: [] };
        if (method === "chat.history") return { messages: [], nextCursor: null };
        return { notifications: [], nextCursor: null };
      },
    },
    storage: { get: (k) => storage.get(k) ?? null, set: (k, v) => void storage.set(k, v) },
    notify: { show: () => {} },
  };
  return { platform, storage };
}

const press = (init: KeyboardEventInit) =>
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...init }));
  });

describe("the shell's one sidebar (redesign §5.1)", () => {
  it("shows one sidebar beside the content, collapses with ⌘B and remembers it", async () => {
    window.history.replaceState(null, "", "/chat");
    const { platform, storage } = platformWith();
    const { unmount } = render(<ShellApp platform={platform} />);
    const shell = screen.getByTestId("shell");
    expect(within(shell).getAllByRole("navigation", { name: "Sidebar" })).toHaveLength(1);
    expect(shell.getAttribute("data-sidebar")).toBe("open");
    // No rail and no separate thread-list column any more.
    expect(shell.querySelector(".rail, .threads-slot, .rail-slot")).toBeNull();

    await press({ key: "b", ctrlKey: true });
    await waitFor(() => expect(shell.getAttribute("data-sidebar")).toBe("collapsed"));
    expect(storage.get("shell.sidebar.open")).toBe("false");
    const show = await screen.findByRole("button", { name: "Show the sidebar" });
    unmount();

    // A new window starts collapsed, and the toolbar button brings it back.
    render(<ShellApp platform={platform} />);
    expect(screen.getByTestId("shell").getAttribute("data-sidebar")).toBe("collapsed");
    expect(show).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show the sidebar" }));
    await waitFor(() => expect(screen.getByTestId("shell").getAttribute("data-sidebar")).toBe("open"));
    expect(storage.get("shell.sidebar.open")).toBe("true");
  });

  it("keeps a stored width inside 220–320 px", () => {
    window.history.replaceState(null, "", "/feed");
    const { platform } = platformWith({ "shell.sidebar.width": "999" });
    render(<ShellApp platform={platform} />);
    expect(screen.getByRole("navigation", { name: "Sidebar" }).style.width).toBe("320px");
  });

  it("returns focus to the opener when a pane closes", async () => {
    window.history.replaceState(null, "", "/chat");
    const { platform } = platformWith();
    render(<ShellApp platform={platform} />);
    const composer = await screen.findByRole("textbox", { name: /message/i });
    composer.focus();
    // ⌃` opens the terminal pane (docs/06 §4.11); focus stays where it was.
    await press({ key: "`", ctrlKey: true });
    const area = await screen.findByTestId("pane-area");
    const close = within(area).getByRole("button", { name: "Close pane" });
    close.focus();
    expect(document.activeElement).toBe(close);
    fireEvent.click(close);
    await waitFor(() => expect(document.activeElement).toBe(composer));
  });

  it("keeps the §4.11 keyboard map: ⌘B is still the sidebar's chord", () => {
    const chord = SHORTCUTS.find((s) => s.action === "toggleThreadList")?.chord;
    expect(chord).toEqual({ key: "b", mod: true });
    expect(SHORTCUTS.map((s) => s.action)).toEqual(
      expect.arrayContaining(["palette", "newSideChat", "cycleThreads", "closePane", "stop"]),
    );
  });
});

describe("compact layout under 720 px (redesign §5.11)", () => {
  it("uses the top bar, the glass tab bar and a threads drawer on ⌘B", async () => {
    window.innerWidth = 390;
    window.history.replaceState(null, "", "/chat");
    const { platform } = platformWith();
    render(<ShellApp platform={platform} />);
    const shell = screen.getByTestId("shell");
    expect(shell.getAttribute("data-compact")).toBe("true");
    expect(within(shell).queryByRole("navigation", { name: "Sidebar" })).toBeNull();
    expect(screen.getByTestId("compact-top-bar")).toBeTruthy();
    const tabs = screen.getByTestId("tab-bar");
    expect(within(tabs).getAllByRole("button").map((b) => b.textContent)).toEqual([
      "Chat",
      "Feed",
      "Ideas",
      "Goals",
      "Library",
    ]);
    await press({ key: "b", ctrlKey: true });
    const drawer = await screen.findByRole("dialog", { name: "Threads" });
    expect(within(drawer).getByRole("button", { name: /Main chat/ })).toBeTruthy();
  });
});
