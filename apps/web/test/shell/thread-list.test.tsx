// @vitest-environment happy-dom
import type { Message, ThreadListEntry } from "@psyche/protocol";
import { activeI18n, createI18n, setActiveI18n } from "@psyche/ui";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, onTestFinished } from "vitest";
import type { GatewayEvent } from "../../src/client/connection.ts";
import { type GatewayStatus, INITIAL_STATUS } from "../../src/client/status.ts";
import { rowTime, ThreadList } from "../../src/shell/components/Chrome.tsx";
import { ShellProvider } from "../../src/shell/context.tsx";
import type { ShellPlatform } from "../../src/shell/platform.ts";
import { lastLineOf, ShellStore } from "../../src/shell/store.ts";

afterEach(cleanup);

const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const T = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

function entry(
  id: string,
  kind: string,
  title: string,
  preview?: string,
  mins = 5,
): ThreadListEntry {
  return {
    thread: {
      id,
      kind,
      title,
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
      activeWriterRunId: null,
      createdAt: T(600),
      updatedAt: T(mins),
      lastMessageAt: T(mins),
    } as ThreadListEntry["thread"],
    activity: { running: 0, awaitingInput: 0, awaitingApproval: 0 },
    ...(preview ? { lastMessage: { role: "agent" as const, text: preview, at: T(mins) } } : {}),
  };
}

function setup(threads: ThreadListEntry[]) {
  const statusCbs = new Set<(s: GatewayStatus) => void>();
  const eventCbs = new Set<(e: GatewayEvent) => void>();
  const platform: ShellPlatform = {
    kind: "web",
    gateway: {
      getStatus: async () => INITIAL_STATUS,
      onStatus: (cb) => {
        statusCbs.add(cb);
        return () => statusCbs.delete(cb);
      },
      onEvent: (cb) => {
        eventCbs.add(cb);
        return () => eventCbs.delete(cb);
      },
      onResync: () => () => undefined,
      call: async (m) => {
        if (m === "threads.list") return { threads, nextCursor: null };
        if (m === "approvals.list") return { approvals: [] };
        return { notifications: [], nextCursor: null };
      },
    },
    storage: { get: () => null, set: () => {} },
    notify: { show: () => {} },
  };
  const store = new ShellStore(platform.gateway);
  store.start();
  for (const cb of statusCbs) cb({ ...INITIAL_STATUS, health: "ok", phase: "paired" });
  render(
    <ShellProvider platform={platform} store={store} mac={true}>
      <ThreadList hidden={false} currentThreadId="t_main" onOpen={() => {}} onNew={() => {}} />
    </ShellProvider>,
  );
  const emit = (event: string, payload: unknown) => {
    for (const cb of eventCbs) cb({ event, payload, seq: 1, stateVersion: 1 });
  };
  return { store, emit };
}

describe("rowTime", () => {
  it("shows the clock today, the weekday this week and the date before that", () => {
    // Day boundaries are the owner's: format on the runtime's clock here (the setup pins UTC).
    const pinned = activeI18n();
    setActiveI18n(createI18n({ locale: "en-US", timeZone: localZone }));
    onTestFinished(() => setActiveI18n(pinned));
    const now = new Date(2026, 9, 20, 15, 0);
    expect(rowTime(new Date(2026, 9, 20, 9, 5).toISOString(), now)).toBe(
      new Date(2026, 9, 20, 9, 5).toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
      }),
    );
    expect(rowTime(new Date(2026, 9, 17, 9, 5).toISOString(), now)).toBe(
      new Date(2026, 9, 17).toLocaleDateString("en-US", { weekday: "short" }),
    );
    expect(rowTime(new Date(2026, 8, 2).toISOString(), now)).toBe(
      new Date(2026, 8, 2).toLocaleDateString("en-US", { month: "short", day: "numeric" }),
    );
  });
});

describe("thread list rows (UI design §2.2)", () => {
  const threads = [
    entry("t_main", "main", "Main chat", "Three slots work with your Tuesday block.", 2),
    entry("t_trip", "side", "Lisbon trip", "Flights on the 14th are cheapest.", 90),
    entry("t_tax", "side", "Taxes", undefined, 3000),
  ];

  it("shows title, time and the last line, and filters by title or last line", async () => {
    setup(threads);
    const list = await screen.findByRole("list", { name: "Threads list" });
    expect(within(list).getByText("Lisbon trip")).toBeTruthy();
    expect(within(list).getByText("Flights on the 14th are cheapest.")).toBeTruthy();
    const trip = threads[1]?.lastMessage?.at ?? "";
    expect(within(list).getByText(rowTime(trip))).toBeTruthy();
    expect(within(list).getAllByRole("listitem")).toHaveLength(3);

    fireEvent.change(screen.getByLabelText("Search threads"), { target: { value: "flights" } });
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);
    expect(within(list).getByText("Lisbon trip")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Search threads"), { target: { value: "nothing" } });
    expect(screen.getByText("No threads match “nothing”.")).toBeTruthy();
  });

  it("updates a row's last line when a message arrives", async () => {
    const { emit } = setup(threads);
    await screen.findByText("Taxes");
    const message: Message = {
      id: "m1",
      threadId: "t_tax",
      seq: 9,
      role: "user",
      blocks: [{ type: "text", md: "**Find** my 2025 `1099` forms" }],
      providerNative: null,
      provenance: "owner",
      replyToMessageId: null,
      channelRef: null,
      runId: null,
      createdAt: new Date().toISOString(),
    } as Message;
    emit("chat.message", { message });
    expect(await screen.findByText("You: Find my 2025 1099 forms")).toBeTruthy();
    expect(lastLineOf(message)).toBe("Find my 2025 1099 forms");
  });
});
