// @vitest-environment happy-dom

import type { ThreadListEntry } from "@psyche/protocol";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { GatewayEvent } from "../../src/client/connection.ts";
import type { GatewayStatus } from "../../src/client/status.ts";
import { escapeHasOwner, isComposingKey } from "../../src/shell/escape-owner.ts";
import type { ShellPlatform } from "../../src/shell/platform.ts";
import { ShellApp } from "../../src/shell/ShellApp.tsx";

afterEach(cleanup);

const T0 = "2026-11-09T10:00:00.000Z";
const RUNNING = {
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
    activeWriterRunId: "01JBXY6Q8Z00000000000000R1",
    createdAt: T0,
    updatedAt: T0,
    lastMessageAt: T0,
  },
  activity: { running: 1, awaitingInput: 0, awaitingApproval: 0 },
} as unknown as ThreadListEntry;

function setup() {
  const calls: { method: string; params: unknown }[] = [];
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
      call: async (method, params) => {
        calls.push({ method, params });
        if (method === "threads.list") return { threads: [RUNNING], nextCursor: null };
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
  return { platform, cancels: () => calls.filter((c) => c.method === "chat.cancel") };
}

async function running() {
  window.history.replaceState(null, "", `/chat/${RUNNING.thread.id}`);
  const s = setup();
  render(<ShellApp platform={s.platform} />);
  const field = await screen.findByRole("textbox");
  // The thread list has loaded: the shell knows a run is active.
  await new Promise((r) => setTimeout(r, 50));
  return { ...s, field };
}

describe("Escape while the agent works", () => {
  it("stops the run when nothing else owns the key", async () => {
    const { field, cancels } = await running();
    expect(fireEvent.keyDown(field, { key: "Escape" })).toBe(false);
    await waitFor(() => expect(cancels()).toHaveLength(1));
    expect(cancels()[0]?.params).toEqual({ threadId: RUNNING.thread.id });
  });

  it("leaves the run alone, and the key unswallowed, while a menu or dialog is open", async () => {
    const { field, cancels } = await running();
    for (const role of ["listbox", "menu", "dialog"]) {
      const el = document.createElement("div");
      el.setAttribute("role", role);
      document.body.append(el);
      let seen = false;
      const onKey = () => {
        seen = true;
      };
      field.addEventListener("keydown", onKey);
      fireEvent.keyDown(field, { key: "Escape" });
      field.removeEventListener("keydown", onKey);
      el.remove();
      expect(seen, role).toBe(true);
    }
    await new Promise((r) => setTimeout(r, 30));
    expect(cancels()).toHaveLength(0);
  });

  it("leaves the run alone while an IME candidate window is open", async () => {
    const { field, cancels } = await running();
    expect(fireEvent.keyDown(field, { key: "Escape", isComposing: true })).toBe(true);
    fireEvent.keyDown(field, { key: "Escape", keyCode: 229 });
    await new Promise((r) => setTimeout(r, 30));
    expect(cancels()).toHaveLength(0);
  });

  it("stops again once the menu is gone", async () => {
    const { field, cancels } = await running();
    const el = document.createElement("div");
    el.setAttribute("role", "listbox");
    document.body.append(el);
    fireEvent.keyDown(field, { key: "Escape" });
    el.remove();
    fireEvent.keyDown(field, { key: "Escape" });
    await waitFor(() => expect(cancels()).toHaveLength(1));
  });
});

describe("what owns Escape", () => {
  const html = (s: string) => {
    const root = document.createElement("div");
    root.innerHTML = s;
    return root;
  };

  it("sees open popups and ignores closed, hidden and plain disclosures", () => {
    expect(escapeHasOwner(html(""))).toBe(false);
    expect(escapeHasOwner(html('<div role="dialog"></div>'))).toBe(true);
    expect(
      escapeHasOwner(html('<button aria-haspopup="menu" aria-expanded="true"></button>')),
    ).toBe(true);
    expect(escapeHasOwner(html('<input role="combobox" aria-expanded="true">'))).toBe(true);
    // Controls: closed, hidden, and a tool step that is merely expanded.
    expect(escapeHasOwner(html('<div role="menu" data-state="closed"></div>'))).toBe(false);
    expect(escapeHasOwner(html('<div aria-hidden="true"><div role="dialog"></div></div>'))).toBe(
      false,
    );
    expect(escapeHasOwner(html('<button aria-expanded="true"></button>'))).toBe(false);
  });

  it("reads composition from isComposing or the IME keyCode", () => {
    expect(isComposingKey({ isComposing: true })).toBe(true);
    expect(isComposingKey({ keyCode: 229 })).toBe(true);
    expect(isComposingKey({ isComposing: false, keyCode: 27 })).toBe(false);
  });
});
