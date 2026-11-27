// @vitest-environment happy-dom
import type { SearchHit, ThreadListEntry } from "@psyche/protocol";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { GatewayEvent } from "../../src/client/connection.ts";
import type { GatewayStatus } from "../../src/client/status.ts";
import type { ShellPlatform } from "../../src/shell/platform.ts";
import { ShellApp, type ShellSlots } from "../../src/shell/ShellApp.tsx";

afterEach(cleanup);

const T0 = "2026-10-27T10:00:00.000Z";
const entry = (id: string, over: Record<string, unknown> = {}): ThreadListEntry =>
  ({
    thread: {
      id,
      kind: "side",
      title: "",
      titleSource: "auto",
      parentThreadId: null,
      forkedFromMessageId: null,
      sessionKey: `owner:side:${id}`,
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
      ...over,
    },
    activity: { running: 0, awaitingInput: 0, awaitingApproval: 0 },
  }) as unknown as ThreadListEntry;

const MAIN = entry("01JBXY6Q8Z0000000000000001", { kind: "main", title: "Main chat" });
const DENTIST = entry("01JBXY6Q8Z0000000000000005", { title: "Dentist on Friday" });
const NEW_ID = "01JBXY6Q8Z0000000000000009";

const hit = (over: Partial<SearchHit> = {}): SearchHit => ({
  scope: "threads",
  id: DENTIST.thread.id,
  title: "Dentist on Friday",
  snippet: "Moved to 3pm",
  score: 1,
  threadId: DENTIST.thread.id,
  route: `/chat/${DENTIST.thread.id}`,
  ...over,
});

/** The Gateway stub records every call; `threads.create` hands out a side chat. */
function setup() {
  const calls: { method: string; params: unknown }[] = [];
  const status: GatewayStatus = { phase: "paired", health: "ok", attempt: 0 };
  const listed = [MAIN, DENTIST];
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
      call: async (method, params) => {
        calls.push({ method, params });
        if (method === "threads.list") return { threads: listed, nextCursor: null };
        if (method === "approvals.list") return { approvals: [] };
        if (method === "chat.history") return { messages: [], nextCursor: null };
        if (method === "threads.create") {
          const p = params as { title?: string; parentThreadId?: string };
          return {
            thread: entry(NEW_ID, {
              title: p.title ?? "",
              parentThreadId: p.parentThreadId ?? null,
              lastMessageAt: null,
            }).thread,
          };
        }
        return { notifications: [], nextCursor: null };
      },
    },
    storage: (() => {
      const m = new Map<string, string>();
      return { get: (k) => m.get(k) ?? null, set: (k, v) => void m.set(k, v) };
    })(),
    notify: { show: () => {} },
  };
  return { platform, named: (m: string) => calls.filter((c) => c.method === m) };
}

/** A palette that opens `current` in a side chat, and a pane body that can expand or close. */
function slotsFor(current: () => SearchHit): ShellSlots {
  return {
    palette: ({ open, onClose, onOpenInSideChat }) =>
      open ? (
        <button
          type="button"
          onClick={() => {
            onClose();
            onOpenInSideChat(current());
          }}
        >
          open in side chat
        </button>
      ) : null,
    pane: (pane, ctx) =>
      pane.pane === "sidechat" ? (
        <div data-testid="side-chat-body">
          <span>{pane.target}</span>
          <button
            type="button"
            onClick={() => {
              ctx.dispatch({ type: "close", paneId: pane.paneId });
              ctx.navigate(`/chat/${pane.target}`);
            }}
          >
            expand
          </button>
        </div>
      ) : null,
  };
}

const openPalette = () =>
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }));

describe("⌘L: open a search result in a side chat", () => {
  it("opens a chat about the chat result beside the current view, without cloning it", async () => {
    window.history.replaceState(null, "", `/chat/${MAIN.thread.id}`);
    const { platform, named } = setup();
    render(<ShellApp platform={platform} slots={slotsFor(() => hit())} />);
    await screen.findByTestId("shell");

    act(() => openPalette());
    fireEvent.click(await screen.findByText("open in side chat"));

    // One new chat, named for the result, linked to the chat it is about; nothing else created.
    await waitFor(() => expect(named("threads.create")).toHaveLength(1));
    expect(named("threads.create")[0]?.params).toEqual({
      kind: "side",
      title: "About Dentist on Friday",
      parentThreadId: DENTIST.thread.id,
    });
    expect(named("threads.newChat")).toHaveLength(0);

    // It is a pane beside the chat on screen, which stays where it was.
    const pane = await screen.findByTestId("pane-area");
    expect(within(pane).getByTestId("pane-tab").getAttribute("data-pane")).toBe("sidechat");
    expect(within(pane).getByTestId("side-chat-body").textContent).toContain(NEW_ID);
    expect(window.location.pathname).toBe(`/chat/${MAIN.thread.id}`);
  });

  it("links a result that is not a chat to the chat on screen", async () => {
    window.history.replaceState(null, "", `/chat/${MAIN.thread.id}`);
    const { platform, named } = setup();
    const note = hit({
      scope: "memory",
      id: "mem_1",
      title: "Lease",
      threadId: null,
      route: "/memory/lease",
    });
    render(<ShellApp platform={platform} slots={slotsFor(() => note)} />);
    await screen.findByTestId("shell");
    act(() => openPalette());
    fireEvent.click(await screen.findByText("open in side chat"));
    await waitFor(() => expect(named("threads.create")).toHaveLength(1));
    expect(named("threads.create")[0]?.params).toMatchObject({ parentThreadId: MAIN.thread.id });
  });

  it("opens beside another screen too, which stays where it was", async () => {
    window.history.replaceState(null, "", "/feed");
    const { platform, named } = setup();
    const note = hit({
      scope: "memory",
      id: "mem_1",
      title: "Lease",
      threadId: null,
      route: "/memory/lease",
    });
    render(<ShellApp platform={platform} slots={slotsFor(() => note)} />);
    await screen.findByTestId("shell");
    act(() => openPalette());
    fireEvent.click(await screen.findByText("open in side chat"));
    await waitFor(() => expect(named("threads.create")).toHaveLength(1));
    // Nothing to link it to: the title says where it came from.
    expect(named("threads.create")[0]?.params).toEqual({ kind: "side", title: "About Lease" });
    expect(await screen.findByTestId("pane-area")).toBeTruthy();
    expect(window.location.pathname).toBe("/feed");
  });

  it("closes with the pane's ×, and expands to the full chat", async () => {
    window.history.replaceState(null, "", `/chat/${MAIN.thread.id}`);
    const { platform } = setup();
    render(<ShellApp platform={platform} slots={slotsFor(() => hit())} />);
    await screen.findByTestId("shell");
    act(() => openPalette());
    fireEvent.click(await screen.findByText("open in side chat"));
    const pane = await screen.findByTestId("pane-area");

    fireEvent.click(within(pane).getByRole("button", { name: "Close pane" }));
    await waitFor(() => expect(screen.queryByTestId("side-chat-body")).toBeNull());
    expect(window.location.pathname).toBe(`/chat/${MAIN.thread.id}`);

    act(() => openPalette());
    fireEvent.click(await screen.findByText("open in side chat"));
    fireEvent.click(await screen.findByText("expand"));
    await waitFor(() => expect(window.location.pathname).toBe(`/chat/${NEW_ID}`));
    // Back on the chat it came from, the pane is gone.
    window.history.replaceState(null, "", `/chat/${MAIN.thread.id}`);
  });
});
