// @vitest-environment happy-dom

import type { ThreadListEntry } from "@psyche/protocol";
import { AUTO_EXPLAINER_KEY } from "@psyche/ui";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GatewayEvent } from "../../src/client/connection.ts";
import type { GatewayStatus } from "../../src/client/status.ts";
import type { ShellPlatform } from "../../src/shell/platform.ts";
import { ShellApp } from "../../src/shell/ShellApp.tsx";

afterEach(cleanup);
beforeEach(() => window.localStorage.removeItem(AUTO_EXPLAINER_KEY));

const T0 = "2026-11-09T10:00:00.000Z";
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
    modelRef: "lmstudio/tiny-7b",
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

const MODELS = {
  providers: [
    {
      id: "lmstudio",
      keyConfigured: true,
      models: [{ ref: "lmstudio/tiny-7b", autoMode: false }],
    },
    {
      id: "anthropic",
      keyConfigured: true,
      models: [{ ref: "anthropic/claude-sonnet-5-5", autoMode: true }],
    },
  ],
  roles: { primary: "lmstudio/tiny-7b" },
};

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
        if (method === "threads.list") return { threads: [MAIN], nextCursor: null };
        if (method === "approvals.list") return { approvals: [] };
        if (method === "chat.history") return { messages: [], nextCursor: null };
        if (method === "models.list") return MODELS;
        if (method === "threads.update") return { thread: MAIN.thread };
        return { notifications: [], nextCursor: null };
      },
    },
    windows: { popOutPane: async () => {}, closeWindow: () => {}, onCommand: () => () => {} },
    storage: { get: () => null, set: () => {} },
    notify: { show: () => {} },
  };
  return { platform, named: (m: string) => calls.filter((c) => c.method === m) };
}

describe("the chat's mode switch", () => {
  it("offers a model that can run Auto, and one tap sets both and remembers the mode", async () => {
    window.history.replaceState(null, "", `/chat/${MAIN.thread.id}`);
    const { platform, named } = setup();
    render(<ShellApp platform={platform} />);
    await screen.findByTestId("mode-switch");
    await waitFor(() => expect(named("models.list").length).toBeGreaterThan(0));

    fireEvent.click(screen.getByTestId("mode-switch-auto"));
    expect(named("threads.update")).toHaveLength(0);
    fireEvent.click(await screen.findByTestId("mode-switch-take-offer"));

    await waitFor(() => expect(named("threads.update")).toHaveLength(1));
    expect(named("threads.update")[0]?.params).toEqual({
      threadId: MAIN.thread.id,
      permissionMode: "auto",
      modelRef: "anthropic/claude-sonnet-5-5",
    });
    await waitFor(() => expect(named("settings.set")).toHaveLength(1));
    expect(named("settings.set")[0]?.params).toEqual({ key: "permissions.mode", value: "auto" });
    expect(await screen.findByTestId("mode-switch-explainer")).toBeTruthy();
  });

  it("sets Manual in a single click with no prompt", async () => {
    window.history.replaceState(null, "", `/chat/${MAIN.thread.id}`);
    const { platform, named } = setup();
    render(<ShellApp platform={platform} />);
    await screen.findByTestId("mode-switch");
    fireEvent.click(screen.getByTestId("mode-switch-manual"));
    await waitFor(() => expect(named("threads.update")).toHaveLength(1));
    expect(named("threads.update")[0]?.params).toEqual({
      threadId: MAIN.thread.id,
      permissionMode: "manual",
    });
  });
});
