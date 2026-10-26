// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ThreadListEntry } from "@psyche/protocol";
import { usePrefillComposer } from "@psyche/ui";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { GatewayEvent } from "../../src/client/connection.ts";
import type { GatewayStatus } from "../../src/client/status.ts";
import { SHORTCUTS } from "../../src/shell/keyboard.ts";
import type { ShellPlatform } from "../../src/shell/platform.ts";
import {
  agentSheetDocked,
  chromeLead,
  isAgentRoute,
  isChatRoute,
  ShellApp,
  underlyingRoute,
} from "../../src/shell/ShellApp.tsx";

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
    expect(shell.querySelector("nav.rail, .threads-slot")).toBeNull();
    // The threads live inside the sidebar, not in a column of their own.
    const sidebar = within(shell).getByRole("navigation", { name: "Sidebar" });
    expect(shell.querySelector("aside.threads")?.closest("nav")).toBe(sidebar);

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
    await waitFor(() =>
      expect(screen.getByTestId("shell").getAttribute("data-sidebar")).toBe("open"),
    );
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

  it("lets Escape through to the focused field when nothing is running", async () => {
    window.history.replaceState(null, "", "/chat");
    const { platform } = platformWith();
    render(<ShellApp platform={platform} />);
    await screen.findByTestId("shell");
    const esc = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    act(() => {
      window.dispatchEvent(esc);
    });
    expect(esc.defaultPrevented).toBe(false);
  });

  it("keeps the §4.11 keyboard map: ⌘B is still the sidebar's chord", () => {
    const chord = SHORTCUTS.find((s) => s.action === "toggleThreadList")?.chord;
    expect(chord).toEqual({ key: "b", mod: true });
    expect(SHORTCUTS.map((s) => s.action)).toEqual(
      expect.arrayContaining(["palette", "newSideChat", "cycleThreads", "closePane", "stop"]),
    );
  });
});

describe("the sidebar toggle and the compact rail (#598)", () => {
  it("puts the toggle at the sidebar's top on the web, and keeps it when the sidebar hides", async () => {
    window.history.replaceState(null, "", "/feed");
    const { platform } = platformWith();
    render(<ShellApp platform={platform} />);
    const sidebar = screen.getByRole("navigation", { name: "Sidebar" });
    fireEvent.click(within(sidebar).getByRole("button", { name: "Hide the sidebar" }));
    await waitFor(() =>
      expect(screen.getByTestId("shell").getAttribute("data-sidebar")).toBe("collapsed"),
    );
    const show = screen.getByRole("button", { name: "Show the sidebar" });
    expect(show.getAttribute("aria-expanded")).toBe("false");
    expect(show.closest('[data-testid="content"]')).not.toBeNull();
  });

  it("⌥⌘B switches to the 64 px rail and back, remembered with the width", async () => {
    window.history.replaceState(null, "", "/feed");
    const { platform, storage } = platformWith();
    const { unmount } = render(<ShellApp platform={platform} />);
    await press({ key: "∫", code: "KeyB", ctrlKey: true, altKey: true });
    const shell = screen.getByTestId("shell");
    await waitFor(() => expect(shell.getAttribute("data-sidebar-mode")).toBe("rail"));
    expect(storage.get("shell.sidebar.mode")).toBe("rail");
    expect(screen.getByRole("navigation", { name: "Sidebar" }).style.width).toBe("64px");
    // ⌘B still hides and shows it; it comes back as the rail.
    await press({ key: "b", code: "KeyB", ctrlKey: true });
    await waitFor(() => expect(shell.getAttribute("data-sidebar")).toBe("collapsed"));
    unmount();
    render(<ShellApp platform={platform} />);
    const again = screen.getByTestId("shell");
    expect(again.getAttribute("data-sidebar")).toBe("collapsed");
    expect(again.getAttribute("data-sidebar-mode")).toBe("rail");
    await press({ key: "∫", code: "KeyB", ctrlKey: true, altKey: true });
    await waitFor(() => expect(again.getAttribute("data-sidebar")).toBe("open"));
    expect(again.getAttribute("data-sidebar-mode")).toBe("full");
    expect(storage.get("shell.sidebar.mode")).toBe("full");
  });
});

describe("the toolbar clear of the traffic lights (#624)", () => {
  const chrome = { titleBar: "inset" as const, trafficLights: { x: 18, y: 19 } };

  it("full sidebar: none; compact rail: the rest of the lights' zone; hidden: all of it", () => {
    const base = { chrome, sidebarWidth: 248 };
    expect(chromeLead({ ...base, sidebarOpen: true, mode: "full" })).toEqual({
      lead: 248,
      toolbar: null,
    });
    // The lights (x 18 + 52 + gutter = 86) plus the 32 px toggle: 128 px from the left edge.
    expect(chromeLead({ ...base, sidebarOpen: true, mode: "rail" })).toEqual({
      lead: 128,
      toolbar: 128 - 64 + 4,
    });
    expect(chromeLead({ ...base, sidebarOpen: false, mode: "full" })).toEqual({
      lead: 128,
      toolbar: 132,
    });
    // Lights placed further in push the toolbars further too.
    expect(
      chromeLead({
        chrome: { titleBar: "inset", trafficLights: { x: 40, y: 19 } },
        sidebarOpen: false,
        mode: "full",
        sidebarWidth: 248,
      }).toolbar,
    ).toBe(40 + 52 + 16 + 42 + 4);
  });

  it("the desktop window marks the toolbars for the inset while the sidebar is hidden", async () => {
    window.innerWidth = 1280;
    window.history.replaceState(null, "", "/feed");
    const { platform } = platformWith({ "shell.sidebar.open": "false" });
    platform.chrome = chrome;
    platform.kind = "desktop";
    render(<ShellApp platform={platform} />);
    const frame = screen.getByTestId("app-frame");
    expect(frame.getAttribute("data-chrome")).toBe("inset");
    expect(frame.hasAttribute("data-toolbar-lead")).toBe(true);
    expect(frame.style.getPropertyValue("--toolbar-lead")).toBe("132px");
    expect(frame.style.getPropertyValue("--chrome-lead")).toBe("128px");
  });

  it("the desktop's toggle reopens the collapsed sidebar and sits after the screens in the tree", async () => {
    window.innerWidth = 1280;
    window.history.replaceState(null, "", "/feed");
    const { platform, storage } = platformWith({ "shell.sidebar.open": "false" });
    platform.chrome = chrome;
    platform.kind = "desktop";
    render(<ShellApp platform={platform} />);
    const frame = screen.getByTestId("app-frame");
    const holder = screen.getByTestId("titlebar-toggle");
    // Electron resolves drag regions in tree order: a toolbar after the toggle would swallow it.
    expect(holder.parentElement).toBe(frame);
    expect(frame.lastElementChild).toBe(holder);
    expect(screen.getByTestId("titlebar").contains(holder)).toBe(false);
    expect(holder.style.left).toBe("86px");
    fireEvent.click(within(holder).getByRole("button", { name: "Show the sidebar" }));
    await waitFor(() =>
      expect(screen.getByTestId("shell").getAttribute("data-sidebar")).toBe("open"),
    );
    expect(storage.get("shell.sidebar.open")).toBe("true");
    // ...and hides it again from the same spot.
    fireEvent.click(within(holder).getByRole("button", { name: "Hide the sidebar" }));
    await waitFor(() =>
      expect(screen.getByTestId("shell").getAttribute("data-sidebar")).toBe("collapsed"),
    );
  });

  it("the web has no lights: no inset, whatever the sidebar does", () => {
    window.innerWidth = 1280;
    window.history.replaceState(null, "", "/feed");
    const { platform } = platformWith({ "shell.sidebar.open": "false" });
    render(<ShellApp platform={platform} />);
    const frame = screen.getByTestId("app-frame");
    expect(frame.hasAttribute("data-chrome")).toBe(false);
    // The attribute alone does nothing without the inset chrome (the CSS needs both).
    const css = readFileSync(join(process.cwd(), "src/shell/layout/shell-layout.css"), "utf8");
    expect(css).toMatch(
      /\.app-frame\[data-chrome="inset"\]\[data-toolbar-lead\]\s+\.shell-content\s+:is\(\[data-slot="toolbar"\], \[data-testid="chat-toolbar"\]\)\s*\{\s*padding-left: var\(--toolbar-lead/,
    );
    // The stale `<header>` selector is gone: the agent header is a div[role=toolbar].
    expect(css).not.toContain('[data-testid="kit-chat"] > header');
  });
});

describe("Try it from the desktop's Settings window (#677)", () => {
  function TryIt() {
    const prefill = usePrefillComposer();
    return (
      <button type="button" onClick={() => prefill?.("Summarise my unread mail")}>
        Try it
      </button>
    );
  }

  it("sends the text to the main window over the bridge instead of navigating", async () => {
    window.history.replaceState(null, "", "/window/settings/connectors");
    const { platform } = platformWith();
    const sent: string[] = [];
    platform.kind = "desktop";
    platform.windows = {
      popOutPane: async () => {},
      closeWindow: () => {},
      onCommand: () => () => {},
      prefillComposer: (text) => sent.push(text),
    };
    render(<ShellApp platform={platform} slots={{ section: () => <TryIt /> }} />);
    fireEvent.click(await screen.findByRole("button", { name: "Try it" }));
    expect(sent).toEqual(["Summarise my unread mail"]);
    expect(window.location.pathname).toBe("/window/settings/connectors");
  });
});

describe("the agent sheet's routes (redesign §5.7)", () => {
  it("docks beside the content only with room for both and no panes open (#625)", () => {
    expect(agentSheetDocked({ compact: false, contentWidth: 1280 - 248 })).toBe(true);
    // 480 px of content beside the 400 px sheet is the floor.
    expect(agentSheetDocked({ compact: false, contentWidth: 880 })).toBe(true);
    expect(agentSheetDocked({ compact: false, contentWidth: 879 })).toBe(false);
    expect(agentSheetDocked({ compact: true, contentWidth: 2000 })).toBe(false);
    expect(agentSheetDocked({ compact: false, contentWidth: 2000, panesOpen: true })).toBe(false);
  });

  it("remembers the section under the sheet (#614)", () => {
    expect(isAgentRoute("/agent/upcoming")).toBe(true);
    expect(isAgentRoute("/agent")).toBe(true);
    expect(isAgentRoute("/agentx")).toBe(false);
    expect(underlyingRoute("/agent/upcoming", "/feed")).toBe("/feed");
    expect(underlyingRoute("/goals/g1", "/feed")).toBe("/goals/g1");
  });

  it("keeps the chat mounted under /agent/*", async () => {
    expect(isChatRoute("/agent/activity")).toBe(true);
    expect(isChatRoute("/chat/t1")).toBe(true);
    expect(isChatRoute("/agentx")).toBe(false);
    expect(isChatRoute("/feed")).toBe(false);
    window.history.replaceState(null, "", "/agent/activity");
    const { platform } = platformWith();
    render(<ShellApp platform={platform} />);
    expect(await screen.findByTestId("chat")).toBeTruthy();
    expect(screen.queryByTestId("section")).toBeNull();
    // The sidebar still marks Chat as where you are.
    expect(
      within(screen.getByRole("navigation", { name: "Sidebar" }))
        .getByRole("button", {
          name: "Chat",
        })
        .getAttribute("aria-current"),
    ).toBe("page");
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
    expect(
      within(tabs)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Chat", "Feed", "Ideas", "Goals", "Library"]);
    await press({ key: "b", ctrlKey: true });
    const drawer = await screen.findByRole("dialog", { name: "Threads" });
    expect(within(drawer).getByRole("button", { name: /Main chat/ })).toBeTruthy();
  });
});
