import type { Message, Run } from "@psyche/protocol";
import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToolRun } from "../src/blocks/ToolRun.tsx";
import { FollowUpQueue } from "../src/chat/FollowUpQueue.tsx";
import {
  clearChatFocus,
  getChatFocusRequestForTest,
  requestChatFocus,
} from "../src/chat/focus-request.ts";
import { ChatThread } from "../src/chat/Thread.tsx";
import { GatewayProvider, GatewayStore, useThread } from "../src/data/index.ts";
import { MockGateway } from "../src/data/mock-gateway.ts";
import { dropSettledStreaming, INITIAL_STATE } from "../src/data/state.ts";
import { IDS } from "../src/fixtures/index.ts";
import { STORY_NOW, StoryWorld } from "../src/stories/harness.tsx";

const THREAD = IDS.threads.dentist;
const NOW = "2026-10-18T10:12:00Z";

/** `count` older messages, seq 1..count (the thread's own messages are shifted past them). */
function olderMessages(count: number): Message[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `old-${i + 1}`,
    threadId: THREAD,
    seq: i + 1,
    role: i % 2 === 0 ? ("user" as const) : ("agent" as const),
    blocks: [{ type: "text" as const, md: `earlier message ${i + 1}` }],
    providerNative: null,
    provenance: i % 2 === 0 ? ("owner" as const) : ("agent" as const),
    replyToMessageId: null,
    channelRef: null,
    runId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
  }));
}

// jsdom has no IntersectionObserver: a stand-in the test can fire.
const observers: { cb: IntersectionObserverCallback; el: Element | null }[] = [];
class FakeObserver {
  readonly entry: { cb: IntersectionObserverCallback; el: Element | null };
  constructor(cb: IntersectionObserverCallback) {
    this.entry = { cb, el: null };
    observers.push(this.entry);
  }
  observe(el: Element) {
    this.entry.el = el;
  }
  disconnect() {
    const at = observers.indexOf(this.entry);
    if (at >= 0) observers.splice(at, 1);
  }
  unobserve() {}
  takeRecords() {
    return [];
  }
}
function sentinelInView() {
  for (const o of [...observers]) {
    if (o.el?.getAttribute("data-testid") === "earlier-sentinel") {
      o.cb([{ isIntersecting: true, target: o.el } as IntersectionObserverEntry], {} as never);
    }
  }
}

let gateway: MockGateway | undefined;
function mount() {
  const scrollIntoView = vi.fn();
  Element.prototype.scrollIntoView = scrollIntoView;
  render(
    <StoryWorld
      edit={(world) => {
        for (const m of world.messages) if (m.threadId === THREAD) m.seq += 250;
        world.messages.push(...olderMessages(250));
      }}
      onGateway={(g) => {
        gateway = g;
      }}
    >
      <div style={{ height: 900 }}>
        <ChatThread threadId={THREAD} now={STORY_NOW} />
      </div>
    </StoryWorld>,
  );
  return scrollIntoView;
}

beforeEach(() => {
  observers.length = 0;
  vi.stubGlobal("IntersectionObserver", FakeObserver);
});
afterEach(() => {
  vi.unstubAllGlobals();
  gateway = undefined;
});

const historyCalls = () => gateway?.calls.filter((c) => c.method === "chat.history") ?? [];

describe("older history", () => {
  it("loads the next page when the top sentinel comes into view and keeps the reader in place", async () => {
    mount();
    const viewport = await screen.findByTestId("chat-viewport");
    // Layout stand-in: every rendered message is 10px tall; the reader sits 50px from the top.
    let top = 50;
    Object.defineProperty(viewport, "scrollHeight", {
      configurable: true,
      get: () => 10 * document.querySelectorAll('[id^="message-"]').length,
    });
    Object.defineProperty(viewport, "scrollTop", {
      configurable: true,
      get: () => top,
      set: (v: number) => {
        top = v;
      },
    });
    await screen.findByTestId("earlier-sentinel");
    expect(historyCalls()).toHaveLength(1);
    const before = document.querySelectorAll('[id^="message-"]').length;

    act(() => sentinelInView());
    await waitFor(() => expect(historyCalls()).toHaveLength(2));
    expect(historyCalls()[1]?.params).toMatchObject({ threadId: THREAD, limit: 100 });
    await waitFor(() =>
      expect(document.querySelectorAll('[id^="message-"]').length).toBeGreaterThan(before),
    );
    const added = document.querySelectorAll('[id^="message-"]').length - before;
    // The page went in above: the scroll position moved by exactly the height it added.
    expect(top).toBe(50 + 10 * added);
  });

  it("does not ask again while a page is loading", async () => {
    mount();
    await screen.findByTestId("earlier-sentinel");
    act(() => {
      sentinelInView();
      sentinelInView();
    });
    await waitFor(() => expect(historyCalls().length).toBeGreaterThanOrEqual(2));
    expect(historyCalls()).toHaveLength(2);
  });

  it("pages back until an old message is found, then scrolls to it", async () => {
    const scrollIntoView = mount();
    await screen.findByRole("log", { name: "Conversation" });
    const request = { threadId: THREAD, messageId: "old-3", artifactId: null };
    act(() => requestChatFocus(request));
    await waitFor(() =>
      expect(document.getElementById("message-old-3")?.getAttribute("data-flash")).toBe("true"),
    );
    expect(historyCalls().length).toBeGreaterThan(2);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "center" });
    expect(getChatFocusRequestForTest()).toBeNull();
  });

  it("says so when the message is not in this chat", async () => {
    mount();
    await screen.findByRole("log", { name: "Conversation" });
    const request = { threadId: THREAD, messageId: "no-such-message", artifactId: null };
    act(() => requestChatFocus(request));
    await screen.findByText("Couldn't find that message in this chat.");
    expect(getChatFocusRequestForTest()).toBeNull();
    clearChatFocus(request);
  });
});

const run = (status: Run["status"], id = "run_1"): Run => ({
  id,
  threadId: "thr_main",
  status,
  modelRef: "anthropic/claude-sonnet-5-5",
  attempt: 1,
  startedAt: NOW,
  endedAt: null,
  error: null,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0 },
});

function storeWorld(runs: Run[] = []) {
  const g = new MockGateway({ runs }, { now: () => NOW });
  const store = new GatewayStore(g, { now: () => NOW });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <GatewayProvider client={g} store={store}>
      {children}
    </GatewayProvider>
  );
  return { g, store, wrapper };
}

describe("a partial reply whose run ended", () => {
  const streaming = (runId: string | null, messageId = "m1") => ({
    ...INITIAL_STATE,
    streaming: { [messageId]: { threadId: "thr_main", messageId, runId, text: "half a sent" } },
    runs: { run_1: run("cancelled"), run_2: run("running", "run_2") },
  });

  it("is dropped when the run's terminal update arrives (and kept for a run still going)", () => {
    const { store } = storeWorld();
    const state = { ...streaming("run_1"), runs: {} };
    for (const status of ["cancelled", "failed", "done"] as const) {
      const next = store.reduce(state, {
        event: "run.updated",
        seq: 1,
        stateVersion: 1,
        payload: { run: run(status) },
      } as never);
      expect(Object.keys(next.streaming), status).toEqual([]);
    }
    // Positive control: a run that is still working keeps its partial reply.
    const live = store.reduce(state, {
      event: "run.updated",
      seq: 1,
      stateVersion: 1,
      payload: { run: run("running") },
    } as never);
    expect(Object.keys(live.streaming)).toEqual(["m1"]);
  });

  it("is kept when its message was committed, and when another run ended", () => {
    const committed = {
      ...streaming("run_1"),
      messages: {
        thr_main: [{ id: "m1", threadId: "thr_main", seq: 1 } as unknown as Message],
      },
    };
    expect(Object.keys(dropSettledStreaming(committed).streaming)).toEqual(["m1"]);
    expect(Object.keys(dropSettledStreaming(streaming("run_2")).streaming)).toEqual(["m1"]);
    expect(Object.keys(dropSettledStreaming(streaming("run_1"), "run_2").streaming)).toEqual([
      "m1",
    ]);
    expect(Object.keys(dropSettledStreaming(streaming("run_1")).streaming)).toEqual([]);
  });

  it("is dropped after a reconnect finds its run ended while the client was away", async () => {
    const { g, store } = storeWorld([run("running")]);
    store.update((s) => ({
      ...s,
      runs: { run_1: run("running") },
      streaming: {
        m1: { threadId: "thr_main", messageId: "m1", runId: "run_1", text: "half a sent" },
      },
    }));
    // The Gateway restarted: the run failed while no event reached this client.
    g.world.runs[0] = { ...run("failed"), error: "gateway_restart" };
    await (store as unknown as { settleStaleRuns(): Promise<void> }).settleStaleRuns();
    expect(store.getState().runs.run_1?.status).toBe("failed");
    expect(store.getState().streaming).toEqual({});
  });
});

describe("Stop and the follow-up queue", () => {
  it("parks queued follow-ups on Stop instead of sending them when the run ends", async () => {
    const { g, wrapper } = storeWorld([run("running")]);
    const { result } = renderHook(() => useThread("thr_main"), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => g.setRun(run("running")));
    await act(() => result.current.send("also check Thursday"));
    expect(result.current.queue).toHaveLength(1);

    await act(() => result.current.cancel());
    expect(result.current.queue[0]?.parked).toBe(true);
    act(() => g.setRun({ ...run("cancelled"), endedAt: NOW }));
    await new Promise((r) => setTimeout(r, 50));
    expect(g.calls.some((c) => c.method === "chat.send")).toBe(false);
    expect(result.current.queue.map((q) => q.content)).toEqual(["also check Thursday"]);

    // "Send queued" releases it.
    act(() => result.current.resumeQueued(result.current.queue[0]?.id));
    await waitFor(() => expect(g.calls.some((c) => c.method === "chat.send")).toBe(true));
    await waitFor(() => expect(result.current.queue).toEqual([]));
  });

  it("resumes the queue when the owner sends a message themselves", async () => {
    const { g, wrapper } = storeWorld([run("running")]);
    const { result } = renderHook(() => useThread("thr_main"), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => g.setRun(run("running")));
    await act(() => result.current.send("held one"));
    await act(() => result.current.cancel());
    act(() => g.setRun({ ...run("cancelled"), endedAt: NOW }));
    await act(() => result.current.send("a new message"));
    await waitFor(() =>
      expect(g.calls.filter((c) => c.method === "chat.send").length).toBeGreaterThanOrEqual(2),
    );
    await waitFor(() => expect(result.current.queue).toEqual([]));
  });

  it("removing a parked follow-up drops it", async () => {
    const { g, wrapper } = storeWorld([run("running")]);
    const { result } = renderHook(() => useThread("thr_main"), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => g.setRun(run("running")));
    await act(() => result.current.send("drop me"));
    await act(() => result.current.cancel());
    act(() => result.current.removeQueued(result.current.queue[0]?.id as string));
    act(() => g.setRun({ ...run("cancelled"), endedAt: NOW }));
    expect(result.current.queue).toEqual([]);
    expect(g.calls.some((c) => c.method === "chat.send")).toBe(false);
  });

  it("shows a parked item with Send queued and Remove", () => {
    const onSendQueued = vi.fn();
    const onRemove = vi.fn();
    render(
      <FollowUpQueue
        items={[
          {
            id: "q1",
            threadId: "thr_main",
            content: "also check Thursday",
            mode: "followUp",
            replyToMessageId: null,
            parked: true,
          },
        ]}
        onRemove={onRemove}
        onSendQueued={onSendQueued}
      />,
    );
    expect(screen.getByText("paused after Stop")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Send queued message/ }));
    expect(onSendQueued).toHaveBeenCalledWith("q1");
    fireEvent.click(screen.getByRole("button", { name: /Remove queued message/ }));
    expect(onRemove).toHaveBeenCalledWith("q1");
  });
});

describe("a tool row after its run ended", () => {
  const item = (settled: boolean) => ({
    block: {
      type: "tool_call" as const,
      toolCallId: "tc1",
      tool: "browser.navigate",
      status: "running" as const,
      level1: "Opening example.test",
    },
    settled,
  });

  it("stops spinning: a running call of a settled run shows as stopped", () => {
    const { container } = render(<ToolRun items={[item(true)]} />);
    expect(container.querySelector('[data-status="running"]')).toBeNull();
    expect(container.querySelector('[data-status="cancelled"]')).not.toBeNull();
  });

  it("still spins while its run is working", () => {
    const { container } = render(<ToolRun items={[item(false)]} />);
    expect(container.querySelector('[data-status="running"]')).not.toBeNull();
    expect(container.querySelector('[data-status="cancelled"]')).toBeNull();
  });
});
