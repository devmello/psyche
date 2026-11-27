import type { Message, Run, ThreadListEntry } from "@psyche/protocol";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewayProvider, GatewayStore, useThread } from "../src/data/index.ts";
import { MockGateway } from "../src/data/mock-gateway.ts";
import { seedRun, useRunSteps } from "../src/data/runs.ts";
import { putMany, runsOfThread } from "../src/data/state.ts";
import { KEEP_RECENT_THREADS } from "../src/data/store.ts";

const NOW = "2026-10-18T10:12:00Z";

afterEach(() => vi.useRealTimers());

function threadEntry(id: string, activeWriterRunId: string | null = null): ThreadListEntry {
  return {
    thread: {
      id,
      kind: "side",
      title: id,
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
      activeWriterRunId,
      createdAt: NOW,
      updatedAt: NOW,
      lastMessageAt: NOW,
    },
    activity: { running: 0, awaitingInput: 0, awaitingApproval: 0 },
  } as ThreadListEntry;
}

const run = (id: string, threadId: string, status: Run["status"]): Run => ({
  id,
  threadId,
  status,
  modelRef: "anthropic/claude-sonnet-5-5",
  attempt: 1,
  startedAt: NOW,
  endedAt: null,
  error: null,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0 },
});

function message(id: string, threadId: string, seq = 0): Message {
  return {
    id,
    threadId,
    seq,
    role: "agent",
    blocks: [{ type: "text", md: id }],
    providerNative: null,
    provenance: "agent",
    replyToMessageId: null,
    channelRef: null,
    runId: null,
    createdAt: NOW,
  };
}

/** A client whose requests wait until the test answers them. */
function manualClient() {
  const pending: Array<(v: unknown) => void> = [];
  const client = {
    connectionState: () => "open",
    onConnectionState: () => () => {},
    subscribe: () => () => {},
    request: () => new Promise((resolve) => pending.push(resolve)),
  };
  let n = 0;
  const store = new GatewayStore(client as never, { now: () => NOW });
  const emit = (event: string, payload: unknown, stateVersion = ++n) => {
    n = Math.max(n, stateVersion);
    (store as unknown as { onEvent(e: unknown): void }).onEvent({
      event,
      payload,
      seq: n,
      stateVersion,
    });
  };
  return { store, emit, pending, client };
}

const post = (feedback: "like" | "save" | null) => ({
  id: "p1",
  title: "t",
  bodyMd: "",
  citations: [],
  cluster: null,
  score: 1,
  reasons: [],
  exploration: false,
  briefingId: null,
  feedback,
  createdAt: NOW,
});

describe("the version guard (touched) stays correct while it is pruned", () => {
  it("a stale response that arrives after a newer event loses, even across a prune", async () => {
    const { store, emit, pending } = manualClient();
    emit("feed.post", { post: post(null) }, 10);
    const version = store.version();
    const inFlight = store.call("feed.list" as never, {} as never).catch(() => {});
    await new Promise((r) => setTimeout(r, 0));
    // The request is out at version 10; an event then changes the post, and a prune runs.
    emit("feed.post", { post: post("like") }, 11);
    store.maintain();
    expect(store.getState().touched["feed:p1"]).toBe(11);
    // Older entries (<= 10) are gone only when nothing pending needs them; this one is needed.
    store.update((s) => putMany(s, "feed", [post(null)], version));
    expect(store.getState().feed.p1?.feedback).toBe("like");
    pending[0]?.({});
    await inFlight;
  });

  it("drops entries no request can need, and a later stale response still loses to newer events", async () => {
    vi.useFakeTimers();
    const { store, emit } = manualClient();
    emit("feed.post", { post: post("like") }, 10);
    vi.advanceTimersByTime(60_000);
    store.maintain();
    // Nothing is pending: the guard is empty, which is safe because every later request starts at >= 10.
    expect(store.getState().touched).toEqual({});
    const version = store.version();
    expect(version).toBe(10);
    emit("feed.post", { post: post("save") }, 12);
    store.update((s) => putMany(s, "feed", [post("like")], version));
    expect(store.getState().feed.p1?.feedback).toBe("save");
  });

  it("a request pending across several prunes keeps every entry newer than its start", async () => {
    const { store, emit, pending } = manualClient();
    emit("feed.post", { post: post(null) }, 5);
    const version = store.version();
    const inFlight = store.call("feed.list" as never, {} as never).catch(() => {});
    await new Promise((r) => setTimeout(r, 0));
    for (let i = 0; i < 300; i += 1)
      emit("chat.message", { message: message(`m${i}`, "t") }, 6 + i);
    emit("feed.post", { post: post("like") }, 400);
    store.maintain();
    store.maintain();
    expect(store.getState().touched["feed:p1"]).toBe(400);
    store.update((s) => putMany(s, "feed", [post(null)], version));
    expect(store.getState().feed.p1?.feedback).toBe("like");
    pending[0]?.({});
    await inFlight;
  });
});

describe("closed threads are evicted and reload when opened", () => {
  function hookWorld(count: number) {
    const ids = Array.from({ length: count }, (_, i) => `t${i}`);
    const gateway = new MockGateway(
      {
        threads: ids.map((id) => threadEntry(id)),
        messages: ids.map((id) => message(`m_${id}`, id)),
      },
      { now: () => NOW },
    );
    const store = new GatewayStore(gateway, { now: () => NOW });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <GatewayProvider client={gateway} store={store}>
        {children}
      </GatewayProvider>
    );
    return { gateway, store, wrapper, ids };
  }

  it("re-opening an evicted thread reloads its history; its run rows were kept", async () => {
    const { gateway, store, wrapper, ids } = hookWorld(10);
    store.start();
    const first = renderHook(() => useThread("t0"), { wrapper });
    await waitFor(() => expect(first.result.current.messages).toHaveLength(1));
    act(() => gateway.setRun(run("r_failed", "t0", "failed")));
    expect(first.result.current.failedRuns).toHaveLength(1);
    first.unmount();

    // Other threads become the recent ones.
    act(() => {
      for (const id of ids.slice(1))
        gateway.commitMessage(id, "agent", [{ type: "text", md: "x" }]);
    });
    store.maintain();
    expect(store.getState().messages.t0).toBeUndefined();
    expect(store.getState().runs.r_failed?.status).toBe("failed");

    const again = renderHook(() => useThread("t0"), { wrapper });
    await waitFor(() => expect(again.result.current.messages).toHaveLength(1));
    await waitFor(() =>
      expect(again.result.current.failedRuns.map((r) => r.id)).toEqual(["r_failed"]),
    );
    again.unmount();
  });

  it("never evicts the open thread, a thread that is streaming, or one with a running run", async () => {
    const { gateway, store, wrapper, ids } = hookWorld(12);
    store.start();
    const open = renderHook(() => useThread("t0"), { wrapper });
    await waitFor(() => expect(open.result.current.messages).toHaveLength(1));
    act(() => {
      gateway.setRun(run("r_live", "t0", "running"));
      gateway.emit("chat.delta", { threadId: "t0", messageId: "mx", delta: "half a sent" });
      gateway.setRun(run("r_bg", "t1", "running"));
      for (const id of ids.slice(2))
        gateway.commitMessage(id, "agent", [{ type: "text", md: "x" }]);
    });
    await waitFor(() => expect(open.result.current.streaming).toHaveLength(1));
    store.maintain();
    const s = store.getState();
    expect(s.messages.t0).toHaveLength(1);
    expect(s.runs.r_live?.status).toBe("running");
    expect(s.streaming.mx?.text).toBe("half a sent");
    // t1 is not open but its run is still going.
    expect(s.runs.r_bg?.status).toBe("running");
    open.unmount();
  });
});

describe("memory stays bounded", () => {
  it("thousands of events over many threads leave a small guard map and a small thread cache", () => {
    const { store, emit } = manualClient();
    const threads = 400;
    let maxTouched = 0;
    for (let i = 0; i < 6000; i += 1) {
      const threadId = `t${i % threads}`;
      emit("chat.message", { message: message(`m${i}`, threadId, i) });
      emit("run.updated", { run: run(`r${i}`, threadId, "done" as Run["status"]) });
      maxTouched = Math.max(maxTouched, store.memoryStats().touched);
    }
    store.maintain();
    const s = store.getState();
    // Guard: between sweeps it holds at most the events since the last one.
    expect(maxTouched).toBeLessThan(400);
    expect(store.memoryStats().touched).toBe(0);
    // Cache: only the recent threads keep messages and settled runs.
    expect(Object.keys(s.messages).length).toBeLessThanOrEqual(KEEP_RECENT_THREADS);
    // Run rows are small and Overview lists read them live, so they are kept (steps are not).
    expect(Object.keys(s.runSteps).length).toBeLessThanOrEqual(KEEP_RECENT_THREADS);
    expect(store.memoryStats().recentThreads).toBeLessThanOrEqual(KEEP_RECENT_THREADS);
  });

  it("indexes runs by thread", () => {
    const runs = { a: run("a", "t1", "done" as Run["status"]), b: run("b", "t2", "running") };
    expect(runsOfThread(runs, "t1").map((r) => r.id)).toEqual(["a"]);
    expect(runsOfThread(runs, "none")).toEqual([]);
    // Same object, same index: no rescan.
    expect(runsOfThread(runs, "t2")).toBe(runsOfThread(runs, "t2"));
  });
});

describe("run views and run rows survive eviction", () => {
  const step = (seq: number) =>
    ({ id: `s${seq}`, runId: "rA", seq, kind: "tool", status: "done" }) as never;
  /** Seeds a settled run `rA` with two steps and a tool call in thread `tA`, then pushes `tA` out of the cache. */
  function setupClosedThread() {
    const m = manualClient();
    m.emit("chat.message", { message: message("mA", "tA") });
    seedRun(m.store, run("rA", "tA", "done" as Run["status"]), [step(1), step(2)]);
    m.store.update((s) => ({
      ...s,
      toolCalls: { tc1: { id: "tc1", runId: "rA", tool: "x" } as never },
    }));
    const sweep = () => {
      for (let i = 0; i < KEEP_RECENT_THREADS + 2; i += 1)
        m.emit("chat.message", { message: message(`o${i}`, `other${i}`) });
      m.store.maintain();
    };
    return { ...m, sweep };
  }

  it("A: a mounted run timeline keeps its steps across sweeps, and loses them once closed", () => {
    const { store, client, sweep } = setupClosedThread();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <GatewayProvider client={client as never} store={store}>
        {children}
      </GatewayProvider>
    );
    const view = renderHook(() => useRunSteps("rA"), { wrapper });
    sweep();
    sweep();
    expect(store.getState().messages.tA).toBeUndefined();
    expect(view.result.current.steps).toHaveLength(2);
    view.unmount();
    sweep();
    expect(store.getState().runSteps.rA).toBeUndefined();
  });

  it("B: a run that finished does not go back to running after a sweep", () => {
    const { store, emit, sweep } = setupClosedThread();
    emit("run.updated", { run: run("rB", "tA", "running") });
    emit("run.updated", { run: { ...run("rB", "tA", "done" as Run["status"]), endedAt: NOW } });
    sweep();
    expect(store.getState().runs.rB?.status).toBe("done");
  });

  it("C: a run that arrived live in a closed thread stays in the store", () => {
    const { store, emit, sweep } = setupClosedThread();
    emit("run.updated", { run: run("rC", "tA", "done" as Run["status"]) });
    sweep();
    sweep();
    expect(Object.keys(store.getState().runs).sort()).toEqual(["rA", "rC"]);
  });

  it("D: tool calls survive eviction and re-opening", () => {
    const { store, emit, sweep } = setupClosedThread();
    sweep();
    expect(store.getState().runSteps.rA).toBeUndefined();
    emit("chat.message", { message: message("mA", "tA") });
    expect(store.getState().toolCalls.tc1?.tool).toBe("x");
  });

  it("forgets the changed mark of a run whose steps were evicted", () => {
    const { store, emit, sweep } = setupClosedThread();
    emit("run.step", { runId: "rA", step: step(3) });
    expect(store.memoryStats().changedRuns).toBeGreaterThan(0);
    sweep();
    expect(store.memoryStats().changedRuns).toBe(0);
  });
});
