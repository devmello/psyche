import type { ApprovalRequest, InputRequest, Run, ThreadListEntry } from "@psyche/protocol";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  GatewayProvider,
  GatewayStore,
  useApprovals,
  useConnection,
  useFeed,
  useQuestion,
  useTasks,
  useThread,
  useThreads,
} from "../src/data/index.ts";
import { MockGateway } from "../src/data/mock-gateway.ts";

const NOW = "2026-10-18T10:12:00Z";
const HASH = `sha256:${"9f".repeat(32)}`;

const thread: ThreadListEntry = {
  thread: {
    id: "thr_main",
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
    createdAt: NOW,
    updatedAt: NOW,
    lastMessageAt: NOW,
  },
  activity: { running: 0, awaitingInput: 0, awaitingApproval: 0 },
};

function approval(id: string, extra: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id,
    kind: "send_email",
    summary: "Send an email to jane.ortiz@example.com",
    details: { to: ["jane.ortiz@example.com"], subject: "Confirming Tuesday 2:30" },
    bindingHash: HASH,
    grantKey: "email.send|example.com",
    requestedBy: { runId: null, taskId: null, threadId: "thr_main" },
    surfaces: ["desktop"],
    scopesOffered: ["once", "task", "always"],
    deviceOnly: false,
    requiresAuthentication: false,
    taint: false,
    status: "pending",
    scopeGranted: null,
    decidedBy: null,
    requestedAt: NOW,
    expiresAt: "2099-01-01T00:00:00Z",
    decidedAt: null,
    grantId: null,
    ...extra,
  };
}

const question: InputRequest = {
  id: "ir_1",
  taskId: null,
  threadId: "thr_main",
  questions: [
    {
      question: "Which slot should I hold?",
      header: "SLOT",
      multiSelect: false,
      options: [{ label: "Tue 2:30" }, { label: "Wed 9:00" }],
    },
  ],
  status: "open",
  answer: null,
  createdAt: NOW,
  answeredAt: null,
  answeredByDeviceId: null,
};

const run = (status: Run["status"]): Run => ({
  id: "run_1",
  threadId: "thr_main",
  status,
  modelRef: "anthropic/claude-sonnet-5-5",
  attempt: 1,
  startedAt: NOW,
  endedAt: null,
  error: null,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0 },
});

function setup(world: ConstructorParameters<typeof MockGateway>[0] = {}) {
  const gateway = new MockGateway({ threads: [thread], ...world }, { now: () => NOW });
  const store = new GatewayStore(gateway, { now: () => NOW });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <GatewayProvider client={gateway} store={store}>
      {children}
    </GatewayProvider>
  );
  return { gateway, store, wrapper };
}

describe("useThread", () => {
  it("streams deltas, then replaces them with the committed message", async () => {
    const { gateway, wrapper } = setup();
    const { result } = renderHook(() => useThread("thr_main"), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      gateway.emit("chat.delta", { threadId: "thr_main", messageId: "m1", delta: "Three slots " });
      gateway.emit("chat.delta", { threadId: "thr_main", messageId: "m1", delta: "work." });
    });
    expect(result.current.streaming.map((s) => s.text)).toEqual(["Three slots work."]);

    act(() => {
      gateway.commitMessage("thr_main", "agent", [{ type: "text", md: "Three slots work." }], {
        id: "m1",
      });
    });
    expect(result.current.streaming).toEqual([]);
    expect(result.current.messages.map((m) => m.id)).toEqual(["m1"]);
  });

  it("inserts structured blocks whole, on a placeholder when the message is not loaded", async () => {
    const { gateway, wrapper } = setup();
    const { result } = renderHook(() => useThread("thr_main"), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => {
      gateway.emit("chat.block", {
        threadId: "thr_main",
        messageId: "m2",
        block: { type: "approval", approvalId: "ap_1" },
      });
    });
    expect(result.current.messages[0]?.blocks).toEqual([{ type: "approval", approvalId: "ap_1" }]);
  });

  it("queues follow-ups while a run works and sends them when it settles", async () => {
    const { gateway, wrapper } = setup({ runs: [run("running")] });
    const { result } = renderHook(() => useThread("thr_main"), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => gateway.setRun(run("running")));
    expect(result.current.running).toBe(true);

    await act(() => result.current.send("also check Thursday"));
    expect(result.current.queue.map((q) => q.content)).toEqual(["also check Thursday"]);
    expect(gateway.calls.some((c) => c.method === "chat.send")).toBe(false);

    act(() => gateway.setRun({ ...run("done"), endedAt: NOW }));
    await waitFor(() => expect(gateway.calls.some((c) => c.method === "chat.send")).toBe(true));
    await waitFor(() => expect(result.current.queue).toEqual([]));
    expect(result.current.messages.at(-1)?.blocks[0]).toEqual({
      type: "text",
      md: "also check Thursday",
    });
  });

  it("removes a queued follow-up without sending it", async () => {
    const { gateway, wrapper } = setup({ runs: [run("running")] });
    const { result } = renderHook(() => useThread("thr_main"), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => gateway.setRun(run("running")));
    await act(() => result.current.send("never mind"));
    const id = result.current.queue[0]?.id as string;
    act(() => result.current.removeQueued(id));
    act(() => gateway.setRun({ ...run("done"), endedAt: NOW }));
    expect(result.current.queue).toEqual([]);
    expect(gateway.calls.some((c) => c.method === "chat.send")).toBe(false);
  });

  it("sends chat.send with an idempotency key", async () => {
    const { gateway, wrapper } = setup();
    const { result } = renderHook(() => useThread("thr_main"), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(() => result.current.send("Book the dentist next week"));
    const call = gateway.calls.find((c) => c.method === "chat.send");
    expect(call?.idempotencyKey).toBeTruthy();
  });
});

describe("useThread optimistic send", () => {
  it("shows the user message before the round trip, once, and drops it on failure", async () => {
    const gateway = new MockGateway({ threads: [thread] }, { now: () => NOW, latency: 30 });
    const store = new GatewayStore(gateway, { now: () => NOW });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <GatewayProvider client={gateway} store={store}>
        {children}
      </GatewayProvider>
    );
    const { result } = renderHook(() => useThread("thr_main"), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    let sending: Promise<unknown> = Promise.resolve();
    act(() => {
      sending = result.current.send("Book the dentist");
    });
    expect(result.current.messages.map((m) => m.role)).toEqual(["user"]);
    await act(async () => {
      await sending;
    });
    const users = result.current.messages.filter((m) => m.role === "user");
    expect(users).toHaveLength(1);
    expect(users[0]?.id.startsWith("pending-")).toBe(false);

    gateway.failNext("chat.send", "unavailable");
    let failing: Promise<unknown> = Promise.resolve();
    act(() => {
      failing = result.current.send("second").catch(() => "failed");
    });
    expect(result.current.messages.filter((m) => m.role === "user")).toHaveLength(2);
    await act(async () => {
      expect(await failing).toBe("failed");
    });
    expect(result.current.messages.filter((m) => m.role === "user")).toHaveLength(1);
  });
});

describe("useApprovals", () => {
  it("answers with this surface's token and the chosen scope", async () => {
    const { gateway, wrapper } = setup({
      approvals: [approval("ap_1")],
      answerTokens: { ap_1: "at_1" },
    });
    const { result } = renderHook(() => useApprovals(), { wrapper });
    await waitFor(() => expect(result.current.pending).toHaveLength(1));
    expect(result.current.pending[0]?.canAnswer).toBe(true);

    await act(() => result.current.answer("ap_1", "approve", "task"));
    const call = gateway.calls.find((c) => c.method === "approvals.answer");
    expect(call?.params).toEqual({
      approvalId: "ap_1",
      answerToken: "at_1",
      decision: "approve",
      scope: "task",
    });
    expect(result.current.pending).toHaveLength(0);
    expect(result.current.recent[0]?.approval.scopeGranted).toBe("task");
  });

  it("adds the host's presence when approving a card that requires authentication", async () => {
    const { gateway, wrapper } = setup({
      approvals: [
        approval("ap_auth", { kind: "purchase", requiresAuthentication: true }),
        approval("ap_plain"),
      ],
      answerTokens: { ap_auth: "at_auth", ap_plain: "at_plain" },
    });
    const presence = vi.fn(async (a: ApprovalRequest, token: string) => ({
      kind: "webauthn" as const,
      deviceId: "dev_web",
      signature: `sig-${a.id}-${token}`,
    }));
    gateway.presence = presence;
    const { result } = renderHook(() => useApprovals(), { wrapper });
    await waitFor(() => expect(result.current.pending).toHaveLength(2));

    await act(() => result.current.answer("ap_plain", "approve", "once"));
    expect(presence).not.toHaveBeenCalled();
    await act(() => result.current.answer("ap_auth", "approve", "once"));
    expect(presence).toHaveBeenCalledTimes(1);
    const answers = gateway.calls.filter((c) => c.method === "approvals.answer");
    expect(answers[0]?.params).not.toHaveProperty("presence");
    expect(answers[1]?.params).toMatchObject({
      approvalId: "ap_auth",
      presence: { kind: "webauthn", deviceId: "dev_web", signature: "sig-ap_auth-at_auth" },
    });
  });

  it("denies a card that requires authentication without asking for presence", async () => {
    const { gateway, wrapper } = setup({
      approvals: [approval("ap_auth", { requiresAuthentication: true })],
      answerTokens: { ap_auth: "at_auth" },
    });
    const presence = vi.fn();
    gateway.presence = presence;
    const { result } = renderHook(() => useApprovals(), { wrapper });
    await waitFor(() => expect(result.current.pending).toHaveLength(1));
    await act(() => result.current.answer("ap_auth", "deny"));
    expect(presence).not.toHaveBeenCalled();
  });

  it("cannot answer without a token (answered elsewhere / not delivered here)", async () => {
    const { wrapper } = setup({ approvals: [approval("ap_2")] });
    const { result } = renderHook(() => useApprovals(), { wrapper });
    await waitFor(() => expect(result.current.pending).toHaveLength(1));
    expect(result.current.pending[0]?.canAnswer).toBe(false);
    await expect(result.current.answer("ap_2", "deny")).rejects.toThrow(/no answer token/);
  });

  it("shows new approvals from events and drops the token when decided elsewhere", async () => {
    const { gateway, store, wrapper } = setup();
    const { result } = renderHook(() => useApprovals(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => {
      gateway.requestApproval(approval("ap_3"));
    });
    expect(result.current.pending[0]?.canAnswer).toBe(true);
    act(() => {
      gateway.emit("approval.updated", {
        approval: approval("ap_3", {
          status: "approved",
          scopeGranted: "once",
          decidedBy: { deviceId: "dev_phone", surface: "notification" },
          decidedAt: NOW,
        }),
      });
    });
    expect(result.current.pending).toHaveLength(0);
    expect(store.getState().answerTokens.ap_3).toBeUndefined();
  });

  it("marks pending cards stale after a reconnect until the Gateway re-issues them", async () => {
    const { gateway, wrapper } = setup({
      approvals: [approval("ap_4"), approval("ap_5")],
      answerTokens: { ap_4: "at_4", ap_5: "at_5" },
    });
    const { result } = renderHook(() => useApprovals(), { wrapper });
    await waitFor(() => expect(result.current.pending).toHaveLength(2));

    // ap_5 expires while this window is offline; ap_4 is re-issued after the restart.
    act(() => gateway.setConnection("offline"));
    gateway.world.approvals = [approval("ap_4"), approval("ap_5", { status: "expired" })];
    act(() => gateway.setConnection("open"));
    await waitFor(() => expect(result.current.pending.map((v) => v.approval.id)).toEqual(["ap_4"]));
    expect(result.current.pending[0]?.stale).toBe(false);
    expect(result.current.recent[0]?.approval.status).toBe("expired");
  });
});

describe("useQuestion", () => {
  it("answers optimistically and keeps the server's answer", async () => {
    const { gateway, wrapper } = setup({ inputRequests: [question] });
    const { result } = renderHook(() => useQuestion("ir_1"), { wrapper });
    await waitFor(() => expect(result.current.request?.status).toBe("open"));
    await act(() => result.current.answer({ SLOT: "Tue 2:30" }));
    expect(result.current.request?.status).toBe("answered");
    expect(result.current.request?.answer).toEqual({ SLOT: "Tue 2:30" });
    expect(gateway.calls.find((c) => c.method === "questions.answer")?.idempotencyKey).toBeTruthy();
  });

  it("rolls back when the Gateway rejects the answer", async () => {
    const { gateway, wrapper } = setup({ inputRequests: [question] });
    const { result } = renderHook(() => useQuestion("ir_1"), { wrapper });
    await waitFor(() => expect(result.current.request?.status).toBe("open"));
    gateway.failNext("questions.answer", "conflict", "already answered");
    await act(async () => {
      await expect(result.current.answer({ SLOT: "Wed 9:00" })).rejects.toThrow(/already answered/);
    });
    expect(result.current.request?.status).toBe("open");
  });
});

describe("stateVersion reconciliation", () => {
  it("refreshes loaded collections when an event gap is detected", async () => {
    const task = {
      id: "task_1",
      threadId: "thr_main",
      title: "Dentist booking",
      goal: "Book",
      status: "running" as const,
      createdFrom: "chat" as const,
      plan: null,
      checklist: [],
      currentStepId: null,
      attempt: 1,
      leaseOwner: null,
      leaseUntil: null,
      browserSessionId: null,
      sandboxId: null,
      summary: null,
      outcome: null,
      createdAt: NOW,
      updatedAt: NOW,
      completedAt: null,
    };
    const { gateway, wrapper } = setup({ tasks: [task] });
    const { result } = renderHook(() => ({ tasks: useTasks(), conn: useConnection() }), {
      wrapper,
    });
    await waitFor(() => expect(result.current.tasks.all).toHaveLength(1));
    act(() => gateway.emit("task.updated", { task }));

    // The task finishes, but its event is lost: the next event's seq skips one.
    gateway.world.tasks = [{ ...task, status: "done", updatedAt: "2026-10-18T10:13:00Z" }];
    gateway.skipEvents(1);
    act(() =>
      gateway.emit("notification.created", {
        notification: {
          id: "n1",
          kind: "task_done",
          title: "Dentist booking",
          body: "Booked",
          taskId: "task_1",
          approvalId: null,
          route: "/agent/activity/task_1",
          actions: [],
          surfaces: ["desktop"],
          delivered: {},
          readAt: null,
          resolvedAt: null,
          createdAt: NOW,
        },
      }),
    );
    await waitFor(() => expect(result.current.tasks.all[0]?.status).toBe("done"));
  });

  it("keeps an entity an event touched after a list was requested", async () => {
    const { gateway, store } = setup();
    store.start();
    const post = {
      id: "p1",
      title: "Two things before your 10:00",
      bodyMd: "…",
      citations: [],
      cluster: null,
      score: 1,
      reasons: [],
      exploration: false,
      briefingId: null,
      feedback: null,
      createdAt: NOW,
    };
    gateway.world.feed = [post];
    const version = store.version();
    // An event (stateVersion > version) likes the post while the list is in flight.
    gateway.emit("feed.post", { post: { ...post, feedback: "like" } });
    const { putMany } = await import("../src/data/state.ts");
    store.update((s) => putMany(s, "feed", [post], version));
    expect(store.getState().feed.p1?.feedback).toBe("like");
  });

  it("applies optimistic feed feedback and undo", async () => {
    const post = {
      id: "p2",
      title: "Robotics",
      bodyMd: "…",
      citations: [],
      cluster: null,
      score: 1,
      reasons: [],
      exploration: true,
      briefingId: null,
      feedback: null,
      createdAt: NOW,
    };
    const { wrapper } = setup({ feed: [post] });
    const { result } = renderHook(() => useFeed(), { wrapper });
    await waitFor(() => expect(result.current.posts).toHaveLength(1));
    await act(() => result.current.feedback("p2", "not_interested"));
    expect(result.current.posts).toHaveLength(0);
    await act(() => result.current.feedback("p2", null));
    expect(result.current.posts).toHaveLength(1);
  });
});

describe("loading before the first pairing (#592)", () => {
  function connecting(world: ConstructorParameters<typeof MockGateway>[0] = {}) {
    const gateway = new MockGateway(
      { threads: [thread], ...world },
      { now: () => NOW, connection: "connecting" },
    );
    const store = new GatewayStore(gateway, { now: () => NOW });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <GatewayProvider client={gateway} store={store}>
        {children}
      </GatewayProvider>
    );
    return { gateway, wrapper };
  }

  it("stays loading while the handshake runs, then loads once paired", async () => {
    const { gateway, wrapper } = connecting();
    const { result } = renderHook(() => useThreads(), { wrapper });
    await new Promise((r) => setTimeout(r, 20));
    expect(result.current.loading).toBe(true);
    expect(result.current.error).toBeNull();
    expect(gateway.calls.filter((c) => c.method === "threads.list")).toHaveLength(0);
    act(() => gateway.setConnection("open"));
    await waitFor(() => expect(result.current.main).not.toBeNull());
    expect(result.current.error).toBeNull();
    expect(gateway.calls.filter((c) => c.method === "threads.list")).toHaveLength(1);
    // The first pairing is not a reconnect.
    expect(gateway.calls.filter((c) => c.method === "events.subscribe")).toHaveLength(0);
  });

  it("settles every component that waited, even two on the same query", async () => {
    const { gateway, wrapper } = connecting();
    const { result } = renderHook(() => ({ a: useThreads(), b: useThreads() }), { wrapper });
    act(() => gateway.setConnection("open"));
    await waitFor(() => expect(result.current.a.loading).toBe(false));
    await waitFor(() => expect(result.current.b.loading).toBe(false));
  });

  it("shows the error when the first connection fails, and loads after a later pairing", async () => {
    const { gateway, wrapper } = connecting();
    const { result } = renderHook(() => useThreads(), { wrapper });
    act(() => gateway.setConnection("offline"));
    await waitFor(() => expect(result.current.error).not.toBeNull());
    act(() => gateway.setConnection("connecting"));
    act(() => gateway.setConnection("open"));
    await waitFor(() => expect(result.current.main).not.toBeNull());
    expect(result.current.error).toBeNull();
  });
});

describe("review regressions", () => {
  it("treats open → offline → connecting → open as a reconnect", async () => {
    const { gateway, wrapper } = setup({
      approvals: [approval("ap_r1")],
      answerTokens: { ap_r1: "at_r1" },
    });
    const { result } = renderHook(() => useApprovals(), { wrapper });
    await waitFor(() => expect(result.current.pending[0]?.canAnswer).toBe(true));
    gateway.world.answerTokens = {};
    act(() => gateway.setConnection("offline"));
    act(() => gateway.setConnection("connecting"));
    act(() => gateway.setConnection("open"));
    await waitFor(() =>
      expect(gateway.calls.filter((c) => c.method === "events.subscribe")).toHaveLength(1),
    );
    // The pre-restart token is dropped; the re-issued card has no token for this surface.
    await waitFor(() => expect(result.current.pending[0]?.canAnswer).toBe(false));
  });

  it("sends a queued follow-up once even when two components watch the thread", async () => {
    const { gateway, wrapper } = setup({ runs: [run("running")] });
    const { result } = renderHook(() => ({ a: useThread("thr_main"), b: useThread("thr_main") }), {
      wrapper,
    });
    await waitFor(() => expect(result.current.a.loading).toBe(false));
    act(() => gateway.setRun(run("running")));
    await act(() => result.current.a.send("also check Thursday"));
    act(() => gateway.setRun({ ...run("done"), endedAt: NOW }));
    await waitFor(() => expect(result.current.a.queue).toEqual([]));
    await new Promise((r) => setTimeout(r, 30));
    expect(gateway.calls.filter((c) => c.method === "chat.send")).toHaveLength(1);
  });

  it("parks a follow-up whose send fails instead of retrying in a loop", async () => {
    const { gateway, wrapper } = setup({ runs: [run("running")] });
    const { result } = renderHook(() => useThread("thr_main"), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => gateway.setRun(run("running")));
    await act(() => result.current.send("also check Thursday"));
    gateway.failNext("chat.send", "unavailable");
    act(() => gateway.setRun({ ...run("done"), endedAt: NOW }));
    await waitFor(() => expect(result.current.queue[0]?.failed).toBe(true));
    await new Promise((r) => setTimeout(r, 50));
    expect(gateway.calls.filter((c) => c.method === "chat.send")).toHaveLength(1);
    act(() => result.current.retryQueued(result.current.queue[0]?.id as string));
    await waitFor(() => expect(result.current.queue).toEqual([]));
    expect(gateway.calls.filter((c) => c.method === "chat.send")).toHaveLength(2);
  });

  it("keeps refreshing a shared loader key after one of its users unmounts", async () => {
    const { gateway, wrapper } = setup({ approvals: [approval("ap_r2")] });
    const first = renderHook(() => useApprovals(), { wrapper });
    const second = renderHook(() => useApprovals(), { wrapper });
    await waitFor(() => expect(second.result.current.pending).toHaveLength(1));
    second.unmount();
    act(() => gateway.requestApproval(approval("ap_r4")));
    const before = gateway.calls.filter((c) => c.method === "approvals.list").length;
    gateway.skipEvents(1);
    act(() => gateway.requestApproval(approval("ap_r3")));
    await waitFor(() =>
      expect(gateway.calls.filter((c) => c.method === "approvals.list").length).toBeGreaterThan(
        before,
      ),
    );
    first.unmount();
  });

  it("does not let an older thread list overwrite a newer thread.updated", async () => {
    const gateway = new MockGateway({ threads: [thread] }, { now: () => NOW, latency: 40 });
    const store = new GatewayStore(gateway, { now: () => NOW });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <GatewayProvider client={gateway} store={store}>
        {children}
      </GatewayProvider>
    );
    const { result } = renderHook(() => useThreads(), { wrapper });
    // The rename lands while threads.list is in flight; the list still has the old title.
    act(() => gateway.emit("thread.updated", { thread: { ...thread.thread, title: "Renamed" } }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.main?.thread.title).toBe("Renamed");
  });
});
