import type { ThreadListEntry } from "@psyche/protocol";
import { act, cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { useThreads } from "../src/data/hooks.ts";
import { GatewayProvider, GatewayStore } from "../src/data/index.ts";
import { MockGateway } from "../src/data/mock-gateway.ts";
import { ThreadRow } from "../src/shell/ThreadList.tsx";

afterEach(cleanup);

const NOW = "2026-11-24T10:00:00Z";

function side(over: Partial<ThreadListEntry["thread"]> = {}): ThreadListEntry {
  return {
    thread: {
      id: "thr_side",
      kind: "side",
      title: "",
      titleSource: "auto",
      parentThreadId: null,
      forkedFromMessageId: null,
      sessionKey: "owner:side:thr_side",
      personaOverlay: null,
      permissionMode: "balanced",
      modelRef: null,
      pinned: false,
      archivedAt: null,
      expiresAt: null,
      userCreated: true,
      lastMessageAt: null,
      createdAt: NOW,
      updatedAt: NOW,
      ...over,
    } as ThreadListEntry["thread"],
    activity: { running: 0, awaitingInput: 0, awaitingApproval: 0 },
  } as ThreadListEntry;
}

describe("ThreadRow rename", () => {
  it("opens the input with the current title, not the one the row mounted with", async () => {
    const row = (entry: ThreadListEntry) => (
      <ul>
        <ThreadRow
          entry={entry}
          active={false}
          now={Date.parse(NOW)}
          onOpen={() => {}}
          onRename={() => {}}
        />
      </ul>
    );
    const { rerender } = render(row(side({ title: "" })));
    // The auto-title arrives after the row mounted with an empty title.
    rerender(row(side({ title: "Trip to Lisbon" })));
    await userEvent.click(screen.getByRole("button", { name: /More for/ }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Rename" }));
    const input = await screen.findByRole("textbox");
    await waitFor(() => expect((input as HTMLInputElement).value).toBe("Trip to Lisbon"));
  });
});

describe("threads.list entries keep their preview and automation", () => {
  const withExtras = (): ThreadListEntry => ({
    ...side({ id: "thr_keep", title: "Plan", lastMessageAt: NOW }),
    lastMessage: { role: "agent", text: "Here is the plan", at: NOW },
    automation: {
      automationId: "aut_1",
      runCount: 4,
      lastRun: {
        id: "run_1",
        status: "failed",
        startedAt: NOW,
        endedAt: NOW,
        summary: "Could not reach the calendar",
      },
    },
  });

  it("keeps lastMessage and automation through a rename", async () => {
    const gateway = new MockGateway({ threads: [withExtras()] }, { now: () => NOW, latency: 0 });
    const store = new GatewayStore(gateway, { now: () => NOW });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <GatewayProvider client={gateway} store={store}>
        {children}
      </GatewayProvider>
    );
    const { result } = renderHook(() => useThreads(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      await result.current.rename("thr_keep", "Renamed plan");
    });
    const entry = result.current.all.find((e) => e.thread.id === "thr_keep");
    expect(entry?.thread.title).toBe("Renamed plan");
    expect(entry?.lastMessage?.text).toBe("Here is the plan");
    expect(entry?.automation?.runCount).toBe(4);
    expect(entry?.automation?.lastRun?.status).toBe("failed");
  });
});
