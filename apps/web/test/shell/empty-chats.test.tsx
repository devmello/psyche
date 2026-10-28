// @vitest-environment happy-dom
import type { ThreadListEntry } from "@psyche/protocol";
import { clearComposerBusy, setComposerBusy } from "@psyche/ui";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { GatewayEvent } from "../../src/client/connection.ts";
import type { GatewayStatus } from "../../src/client/status.ts";
import type { ShellCommand, ShellPlatform } from "../../src/shell/platform.ts";
import { ShellApp } from "../../src/shell/ShellApp.tsx";

afterEach(() => {
  cleanup();
  clearComposerBusy();
});

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
      lastMessageAt: null,
      ...over,
    },
    activity: { running: 0, awaitingInput: 0, awaitingApproval: 0 },
  }) as unknown as ThreadListEntry;

const MAIN = entry("01JBXY6Q8Z0000000000000001", {
  kind: "main",
  title: "Main chat",
  sessionKey: "owner:main",
  lastMessageAt: T0,
});
const EMPTY = entry("01JBXY6Q8Z0000000000000002", { userCreated: true });

interface Call {
  method: string;
  params: unknown;
}

/** A Gateway stub whose `threads.newChat` hands out `EMPTY` (reused once it exists). */
function setup(opts: { listed?: ThreadListEntry[] } = {}) {
  const calls: Call[] = [];
  const events = new Set<(e: GatewayEvent) => void>();
  const commands = new Set<(c: ShellCommand) => void>();
  let created = false;
  const status: GatewayStatus = { phase: "paired", health: "ok", attempt: 0 };
  const platform: ShellPlatform = {
    kind: "web",
    gateway: {
      getStatus: async () => status,
      onStatus: (cb) => {
        cb(status);
        return () => {};
      },
      onEvent: (cb) => {
        events.add(cb);
        return () => events.delete(cb);
      },
      onResync: () => () => {},
      call: async (method, params) => {
        calls.push({ method, params });
        if (method === "threads.list") return { threads: opts.listed ?? [MAIN], nextCursor: null };
        if (method === "approvals.list") return { approvals: [] };
        if (method === "chat.history") return { messages: [], nextCursor: null };
        if (method === "threads.newChat") {
          const reused = created;
          created = true;
          return { thread: EMPTY.thread, reused };
        }
        if (method === "threads.discardEmpty") return { deleted: true };
        return { notifications: [], nextCursor: null };
      },
    },
    windows: {
      popOutPane: async () => {},
      closeWindow: () => {},
      onCommand: (cb) => {
        commands.add(cb);
        return () => commands.delete(cb);
      },
    },
    storage: { get: () => null, set: () => {} },
    notify: { show: () => {} },
  };
  const send = (c: ShellCommand) =>
    act(() => {
      for (const cb of commands) cb(c);
    });
  const emit = (event: string, payload: unknown) =>
    act(() => {
      for (const cb of events) cb({ event, payload } as GatewayEvent);
    });
  const named = (m: string) => calls.filter((c) => c.method === m);
  return { platform, send, emit, named };
}

describe("New chat reuses an empty chat", () => {
  it("asks the Gateway for the empty chat instead of creating one, and goes to it", async () => {
    window.history.replaceState(null, "", "/chat");
    const { platform, send, named } = setup();
    render(<ShellApp platform={platform} />);
    await screen.findByTestId("shell");

    await send({ type: "newSideChat" });
    await waitFor(() => expect(window.location.pathname).toBe(`/chat/${EMPTY.thread.id}`));
    expect(named("threads.create")).toHaveLength(0);
    expect(named("threads.newChat")[0]?.params).toMatchObject({ kind: "side" });

    // Pressing it again on the empty chat prefers that chat and stays on it.
    await send({ type: "newSideChat" });
    await waitFor(() => expect(named("threads.newChat")).toHaveLength(2));
    expect(named("threads.newChat")[1]?.params).toMatchObject({
      kind: "side",
      preferThreadId: EMPTY.thread.id,
    });
    expect(window.location.pathname).toBe(`/chat/${EMPTY.thread.id}`);
    expect(named("threads.discardEmpty")).toHaveLength(0);
  });
});

describe("leaving an empty chat deletes it", () => {
  it("deletes it when the owner opens another screen", async () => {
    window.history.replaceState(null, "", "/chat");
    const { platform, send, named } = setup();
    render(<ShellApp platform={platform} />);
    await screen.findByTestId("shell");
    await send({ type: "newSideChat" });
    await waitFor(() => expect(window.location.pathname).toBe(`/chat/${EMPTY.thread.id}`));

    await send({ type: "navigate", route: "/feed" });
    await waitFor(() => expect(named("threads.discardEmpty")).toHaveLength(1));
    expect(named("threads.discardEmpty")[0]?.params).toEqual({ threadId: EMPTY.thread.id });
  });

  it("deletes it when the owner opens another chat", async () => {
    window.history.replaceState(null, "", "/chat");
    const { platform, send, named } = setup();
    render(<ShellApp platform={platform} />);
    await screen.findByTestId("shell");
    await send({ type: "newSideChat" });
    await waitFor(() => expect(window.location.pathname).toBe(`/chat/${EMPTY.thread.id}`));

    await send({ type: "navigate", route: `/chat/${MAIN.thread.id}` });
    await waitFor(() => expect(named("threads.discardEmpty")).toHaveLength(1));
  });

  it("deletes it when the window closes", async () => {
    window.history.replaceState(null, "", "/chat");
    const { platform, send, named } = setup();
    render(<ShellApp platform={platform} />);
    await screen.findByTestId("shell");
    await send({ type: "newSideChat" });
    await waitFor(() => expect(window.location.pathname).toBe(`/chat/${EMPTY.thread.id}`));

    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });
    await waitFor(() => expect(named("threads.discardEmpty")).toHaveLength(1));
  });

  it("keeps a chat the owner has started typing in", async () => {
    window.history.replaceState(null, "", "/chat");
    const { platform, send, named } = setup();
    render(<ShellApp platform={platform} />);
    await screen.findByTestId("shell");
    await send({ type: "newSideChat" });
    await waitFor(() => expect(window.location.pathname).toBe(`/chat/${EMPTY.thread.id}`));
    // The kit's composer reports a draft (see the UI package's tests); leaving must not throw it
    // away with the chat.
    setComposerBusy(EMPTY.thread.id, true);

    await send({ type: "navigate", route: "/feed" });
    await new Promise((r) => setTimeout(r, 30));
    expect(named("threads.discardEmpty")).toHaveLength(0);
  });

  it("never asks about a chat that has a message, or one another feature made", async () => {
    const started = entry("01JBXY6Q8Z0000000000000003", {
      userCreated: true,
      lastMessageAt: T0,
      title: "Trip",
    });
    const forkish = entry("01JBXY6Q8Z0000000000000004", { parentThreadId: MAIN.thread.id });
    window.history.replaceState(null, "", `/chat/${started.thread.id}`);
    const { platform, send, named } = setup({ listed: [MAIN, started, forkish] });
    render(<ShellApp platform={platform} />);
    await screen.findByTestId("shell");

    await send({ type: "navigate", route: `/chat/${forkish.thread.id}` });
    await send({ type: "navigate", route: "/feed" });
    await new Promise((r) => setTimeout(r, 30));
    expect(named("threads.discardEmpty")).toHaveLength(0);
  });

  it("goes back to the main chat when the open chat is deleted in another window", async () => {
    window.history.replaceState(null, "", "/chat");
    const { platform, send, emit } = setup();
    render(<ShellApp platform={platform} />);
    await screen.findByTestId("shell");
    await send({ type: "newSideChat" });
    await waitFor(() => expect(window.location.pathname).toBe(`/chat/${EMPTY.thread.id}`));

    await emit("thread.deleted", { threadId: EMPTY.thread.id });
    await waitFor(() => expect(window.location.pathname).toBe("/chat"));
  });
});
