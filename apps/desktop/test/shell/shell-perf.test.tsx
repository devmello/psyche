// @vitest-environment happy-dom

import type { ThreadListEntry } from "@psyche/protocol";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { memo, type ReactElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { GatewayEvent } from "../../src/client/connection.ts";
import type { GatewayStatus } from "../../src/client/status.ts";
import type { ShellPlatform } from "../../src/shell/platform.ts";
import { type ChatSlotContext, ShellApp } from "../../src/shell/ShellApp.tsx";

afterEach(cleanup);

const T0 = "2026-11-09T10:00:00.000Z";
function entry(id: string, kind: "main" | "side", running = false): ThreadListEntry {
  return {
    thread: {
      id,
      kind,
      title: kind === "main" ? "Main chat" : `Side ${id}`,
      titleSource: "auto",
      parentThreadId: null,
      forkedFromMessageId: null,
      sessionKey: `owner:${id}`,
      personaOverlay: null,
      permissionMode: "balanced",
      modelRef: null,
      pinned: false,
      archivedAt: null,
      expiresAt: null,
      activeWriterRunId: running ? "R1" : null,
      createdAt: T0,
      updatedAt: T0,
      lastMessageAt: T0,
    },
    activity: { running: running ? 1 : 0, awaitingInput: 0, awaitingApproval: 0 },
  } as unknown as ThreadListEntry;
}
const MAIN = entry("01JBXY6Q8Z0000000000000001", "main", true);
const SIDE = entry("01JBXY6Q8Z0000000000000002", "side");

function setup(failCancel = false) {
  const calls: { method: string; params: unknown }[] = [];
  const listeners = new Set<(e: GatewayEvent) => void>();
  const status: GatewayStatus = { phase: "paired", health: "ok", attempt: 0 };
  let seq = 0;
  const platform: ShellPlatform = {
    kind: "web",
    gateway: {
      getStatus: async () => status,
      onStatus: (cb) => {
        cb(status);
        return () => {};
      },
      onEvent: (cb) => {
        listeners.add(cb);
        return () => listeners.delete(cb);
      },
      onResync: () => () => {},
      call: async (method, params) => {
        calls.push({ method, params });
        if (method === "chat.cancel" && failCancel)
          throw Object.assign(new Error("slow"), { code: "rate_limited" });
        if (method === "threads.list") return { threads: [MAIN, SIDE], nextCursor: null };
        if (method === "approvals.list") return { approvals: [] };
        if (method === "chat.history") return { messages: [], nextCursor: null };
        if (method === "models.list") return { providers: [], roles: {} };
        return { notifications: [], nextCursor: null };
      },
    },
    windows: { popOutPane: async () => {}, closeWindow: () => {}, onCommand: () => () => {} },
    storage: { get: () => null, set: () => {} },
    notify: { show: () => {} },
  };
  const emit = (event: string, payload: unknown) =>
    act(() => {
      for (const cb of listeners) cb({ event, payload, seq: seq++, stateVersion: seq });
    });
  return { platform, calls, emit };
}

let renders = 0;
const Probe = memo(function Probe(p: { ctx: ChatSlotContext }): ReactElement {
  renders++;
  return <div data-testid="kit-chat">{p.ctx.thread?.id}</div>;
});

describe("open chat renders (D8)", () => {
  it("does not re-render for another thread's message or update", async () => {
    window.history.replaceState(null, "", `/chat/${MAIN.thread.id}`);
    const s = setup();
    renders = 0;
    render(<ShellApp platform={s.platform} slots={{ chat: (_id, ctx) => <Probe ctx={ctx} /> }} />);
    await waitFor(() => expect(screen.getByTestId("kit-chat").textContent).toBe(MAIN.thread.id));
    await new Promise((r) => setTimeout(r, 50));
    const before = renders;
    await s.emit("chat.message", {
      message: {
        id: "m9",
        threadId: SIDE.thread.id,
        seq: 1,
        role: "agent",
        createdAt: T0,
        blocks: [{ type: "text", md: "hello from the side" }],
      },
    });
    await s.emit("thread.updated", { thread: { ...SIDE.thread, title: "Renamed" } });
    await new Promise((r) => setTimeout(r, 30));
    expect(renders).toBe(before);
    // Positive control: an update to the open thread does reach the chat.
    await s.emit("thread.updated", { thread: { ...MAIN.thread, permissionMode: "manual" } });
    await waitFor(() => expect(renders).toBeGreaterThan(before));
  });
});

describe("Escape-to-stop failure (D12)", () => {
  it("toasts when chat.cancel fails", async () => {
    window.history.replaceState(null, "", `/chat/${MAIN.thread.id}`);
    const s = setup(true);
    render(<ShellApp platform={s.platform} />);
    const field = await screen.findByRole("textbox");
    await new Promise((r) => setTimeout(r, 50));
    fireEvent.keyDown(field, { key: "Escape" });
    expect(await screen.findByText("Couldn't stop. Try again.")).toBeTruthy();
  });
});
