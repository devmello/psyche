// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

describe("the composed app on the web host (A8)", () => {
  it("renders the kit's chat column with the persona and the phone layout below 720 px", async () => {
    window.innerWidth = 390;
    window.history.replaceState(null, "", "/chat");
    const { platform, calls } = webPlatform();
    render(<PsycheApp platform={platform} />);
    const shell = await screen.findByTestId("shell");
    expect(shell.getAttribute("data-compact")).toBe("true");
    // The kit's composer, addressed to the agent named in IDENTITY.md.
    await screen.findByRole("textbox", { name: "Message Flash" });
    // Accessibility (docs/a11y-audit.md A1–A3): a skip link to the one main landmark, an h1 for
    // the chat, and the Appearance settings applied to the document (reduce motion, theme).
    expect(screen.getByRole("link", { name: "Skip to content" }).getAttribute("href")).toBe(
      "#main",
    );
    expect(screen.getAllByRole("main")).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1, name: "Main chat" })).toBeTruthy();
    await waitFor(() => expect(document.documentElement.dataset.reduceMotion).toBeDefined());
    // Bottom tab bar: the five phone tabs, no Search and no Settings in the rail.
    const rail = screen.getByTestId("rail");
    const labels = Array.from(rail.querySelectorAll("button")).map((b) => b.textContent?.trim());
    expect(labels).toEqual(["Chat", "Feed", "Ideas", "Goals", "Library"]);
    expect(calls.some((c) => c.method === "settings.get")).toBe(true);
    await act(async () => {
      window.innerWidth = 1280;
      window.dispatchEvent(new Event("resize"));
    });
    await waitFor(() => expect(shell.getAttribute("data-compact")).toBe("false"));
  });

  it("gates on onboarding when the Gateway has no completedAt", async () => {
    const { platform } = webPlatform();
    const call = platform.gateway.call;
    platform.gateway.call = async (method, params, options) =>
      method === "settings.get" ? { settings: {}, stateVersion: 1 } : call(method, params, options);
    render(<PsycheApp platform={platform} />);
    await screen.findByTestId("onboarding");
    // The web can't ask macOS: no Permissions step (#554).
    const progress = screen.getByRole("navigation", { name: "Onboarding progress" });
    expect(progress.textContent).not.toContain("Permissions");
  });

  it("gives the kit the shell's navigation: Add a goal creates it and opens it (#554)", async () => {
    window.innerWidth = 1280;
    window.history.replaceState(null, "", "/goals");
    const { platform } = webPlatform();
    const call = platform.gateway.call;
    let created: unknown;
    platform.gateway.call = async (method, params, options) => {
      if (method !== "goals.create") return call(method, params, options);
      created = params;
      return {
        goal: {
          id: "01JBXY6Q8Z00000000000000G1",
          title: (params as { title: string }).title,
          category: (params as { category: string }).category,
          status: "active",
          inferred: false,
          confirmedAt: "2026-10-19T10:00:00.000Z",
          plan: null,
          cadence: null,
          nextCheckinAt: null,
          archivedAt: null,
          createdAt: "2026-10-19T10:00:00.000Z",
          updatedAt: "2026-10-19T10:00:00.000Z",
        },
        taskIds: [],
        milestones: [],
        links: [],
      };
    };
    render(<PsycheApp platform={platform} />);
    fireEvent.click(await screen.findByRole("button", { name: "Add a goal" }));
    const dialog = await screen.findByRole("dialog", { name: "Add a goal" });
    fireEvent.change(within(dialog).getByLabelText("Goal"), { target: { value: "Learn to swim" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add a goal" }));
    await waitFor(() => expect(window.location.pathname).toBe("/goals/01JBXY6Q8Z00000000000000G1"));
    expect(created).toEqual({ title: "Learn to swim", category: "other" });
  });
});
