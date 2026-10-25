// @vitest-environment happy-dom
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { GatewayEvent, GatewayStatus } from "../../src/client/index.ts";
import { ONBOARDED_KEY, PsycheApp } from "../../src/compose/PsycheApp.tsx";
import type { ShellPlatform } from "../../src/shell/platform.ts";

afterEach(cleanup);

const MAIN = {
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
  createdAt: "2026-10-19T10:00:00.000Z",
  updatedAt: "2026-10-19T10:00:00.000Z",
  lastMessageAt: null,
};

/** A paired web host whose Gateway has finished onboarding and holds one empty main thread. */
function webPlatform() {
  const calls: { method: string; params: unknown }[] = [];
  const status: GatewayStatus = { phase: "paired", health: "ok", attempt: 0 };
  const handlers: Record<string, (p: unknown) => unknown> = {
    "settings.get": () => ({
      settings: { [ONBOARDED_KEY]: "2026-10-19T09:00:00.000Z" },
      stateVersion: 1,
    }),
    "threads.list": () => ({
      threads: [{ thread: MAIN, activity: { running: 0, awaitingInput: 0, awaitingApproval: 0 } }],
      nextCursor: null,
    }),
    "threads.get": () => ({
      thread: MAIN,
      activity: { running: 0, awaitingInput: 0, awaitingApproval: 0 },
    }),
    "chat.history": () => ({ messages: [], nextCursor: null }),
    "chat.queue.list": () => ({ items: [] }),
    "events.subscribe": () => ({ ok: true }),
    "memory.read": () => ({
      content: '---\nname: "Flash"\ncreature: "moth"\n---\n',
      etag: "e1",
    }),
  };
  const platform: ShellPlatform = {
    kind: "web",
    gateway: {
      getStatus: async () => status,
      onStatus: () => () => {},
      call: async (method, params) => {
        calls.push({ method, params });
        const h = handlers[method];
        if (h) return h(params);
        if (method.endsWith(".list")) return { [method.split(".")[0] ?? "items"]: [] };
        return {};
      },
      onEvent: (_cb: (e: GatewayEvent) => void) => () => {},
      onResync: () => () => {},
    },
    storage: { get: () => null, set: () => {} },
    notify: { show: () => {} },
  };
  return { platform, calls };
}

type Command = Parameters<NonNullable<ShellPlatform["windows"]>["onCommand"]>[0] extends (
  c: infer C,
) => void
  ? C
  : never;

/** The desktop host: an inset title bar and a native Settings window (redesign §4). */
function desktopPlatform() {
  const { platform, calls } = webPlatform();
  const opened: (string | undefined)[] = [];
  let send: ((c: Command) => void) | undefined;
  const desktop: ShellPlatform = {
    ...platform,
    kind: "desktop",
    chrome: { titleBar: "inset", trafficLights: { x: 20, y: 19 } },
    windows: {
      popOutPane: async () => {},
      closeWindow: () => {},
      openSettings: (section) => opened.push(section),
      onCommand: (cb) => {
        send = cb;
        return () => {
          send = undefined;
        };
      },
    },
  };
  return { platform: desktop, calls, opened, command: (c: Command) => send?.(c) };
}

describe("Settings in their own window on the desktop (docs/design/redesign-2026.md §4, §5.8)", () => {
  it("opens the Settings window instead of navigating the main window", async () => {
    window.innerWidth = 1280;
    window.history.replaceState(null, "", "/chat");
    const { platform, opened, command } = desktopPlatform();
    render(<PsycheApp platform={platform} />);
    await screen.findByTestId("shell");
    await act(async () => command({ type: "navigate", route: "/settings/permissions" }));
    expect(opened).toEqual(["permissions"]);
    expect(screen.queryByTestId("settings-window")).toBeNull();
    expect(window.location.pathname).toBe("/chat");
  });

  it("renders only the section under its own title bar in the Settings window", async () => {
    window.innerWidth = 760;
    window.history.replaceState(null, "", "/window/settings/appearance");
    const { platform } = desktopPlatform();
    render(<PsycheApp platform={platform} />);
    const win = await screen.findByTestId("settings-window");
    expect(within(win).getByTestId("titlebar").textContent).toContain("Settings");
    expect(screen.queryByTestId("rail")).toBeNull();
    expect(screen.queryByTestId("shell")).toBeNull();
  });
});
