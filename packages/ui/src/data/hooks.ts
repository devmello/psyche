import type {
  ApprovalRequest,
  Artifact,
  Automation,
  FeedPost,
  Goal,
  GoalMilestone,
  GrantScope,
  Idea,
  IdeaDismissReason,
  InputRequest,
  LibraryItem,
  Message,
  MethodName,
  MethodParams,
  MethodResult,
  Notification,
  QueueMode,
  Receipt,
  SearchHit,
  SearchScope,
  Task,
  TaskAction,
  ThreadListEntry,
  ToolCall,
} from "@psyche/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ConnectionState } from "./client.ts";
import { useStore, useStoreState } from "./provider.tsx";
import { put, putMany, type QueuedFollowUp, type StreamingMessage, type UiState } from "./state.ts";
import type { GatewayStore } from "./store.ts";

/**
 * Typed hooks over the Gateway (S12 data layer). Each hook loads its collection on mount,
 * registers a refresher for gaps and reconnects, and exposes actions. Mutations that the user
 * expects to see at once are optimistic and reconciled when the request settles.
 */

export interface LoadState {
  loading: boolean;
  error: string | null;
  reload: () => void;
}

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Runs `load` on mount and whenever `key` changes; reruns it after gaps and reconnects. */
export function useLoader(
  key: string | null,
  load: (store: GatewayStore) => Promise<void>,
): LoadState {
  const store = useStore();
  const [loading, setLoading] = useState(key !== null);
  const [error, setError] = useState<string | null>(null);
  const loadRef = useRef(load);
  loadRef.current = load;
  const [tick, setTick] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `tick` forces a reload from `reload()`
  useEffect(() => {
    if (key === null) {
      setLoading(false);
      return;
    }
    let live = true;
    const run = async () => {
      setLoading(true);
      try {
        await loadRef.current(store);
        if (live) setError(null);
      } catch (err) {
        if (live) setError(messageOf(err));
        throw err;
      } finally {
        if (live) setLoading(false);
      }
    };
    void run().catch(() => {});
    const unregister = store.registerRefresher(key, run);
    return () => {
      live = false;
      unregister();
    };
  }, [key, store, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { loading, error, reload };
}

// --- Connection -----------------------------------------------------------------------------

export function useConnection(): {
  state: ConnectionState;
  refreshing: boolean;
  stateVersion: number;
  retry: () => Promise<void>;
} {
  const store = useStore();
  const state = useStoreState((s) => s.connection);
  const refreshing = useStoreState((s) => s.refreshing);
  const stateVersion = useStoreState((s) => s.stateVersion);
  return { state, refreshing, stateVersion, retry: () => store.refreshAll() };
}

/** The raw request function, with idempotency keys added for side-effecting methods. */
export function useCall(): <M extends MethodName>(
  method: M,
  params: MethodParams<M>,
) => Promise<MethodResult<M>> {
  const store = useStore();
  return useCallback((method, params) => store.call(method, params), [store]);
}

// --- Generic queries --------------------------------------------------------------------------

/**
 * A cached read for methods without a dedicated collection (grants, devices, connectors, …).
 * Events that affect a family invalidate it (see `invalidate` in the store).
 */
export function useGatewayQuery<M extends MethodName>(
  method: M,
  params: MethodParams<M>,
  options: { enabled?: boolean } = {},
): LoadState & { data: MethodResult<M> | undefined } {
  const key = `${method}:${JSON.stringify(params)}`;
  const enabled = options.enabled ?? true;
  const entry = useStoreState((s) => s.queries[key]);
  const paramsRef = useRef(params);
  paramsRef.current = params;
  const load = useLoader(enabled ? `query:${key}` : null, async (store) => {
    const version = store.version();
    const data = await store.call(method, paramsRef.current);
    store.update((s) => ({
      ...s,
      queries: { ...s.queries, [key]: { data, error: null, loading: false, version } },
    }));
  });
  const invalidated = entry?.version === -1;
  const { reload } = load;
  useEffect(() => {
    if (invalidated) reload();
  }, [invalidated, reload]);
  return { ...load, data: entry?.data as MethodResult<M> | undefined };
}

// --- Threads ----------------------------------------------------------------------------------

export function useThreads(options: { includeArchived?: boolean } = {}) {
  const includeArchived = options.includeArchived ?? true;
  const threadsDict = useStoreState((s) => s.threads);
  const load = useLoader(`threads:${includeArchived}`, async (store) => {
    const version = store.version();
    const { threads } = await store.call("threads.list", { includeArchived });
    store.update((s) => {
      const next: Record<string, ThreadListEntry> = { ...s.threads };
      for (const t of threads) {
        // A thread.updated event after the request started is newer than this list.
        if ((s.touched[`threads:${t.thread.id}`] ?? -1) > version) continue;
        next[t.thread.id] = t;
      }
      return { ...s, threads: next, threadsLoaded: true };
    });
  });
  const store = useStore();
  const all = useMemo(
    () =>
      Object.values(threadsDict).sort((a, b) =>
        (b.thread.lastMessageAt ?? b.thread.updatedAt).localeCompare(
          a.thread.lastMessageAt ?? a.thread.updatedAt,
        ),
      ),
    [threadsDict],
  );
  const main = all.find((t) => t.thread.kind === "main") ?? null;
  const active = all.filter((t) => t.thread.archivedAt == null && t.thread.kind !== "main");
  const archived = all.filter((t) => t.thread.archivedAt != null);

  const putThread = (s: UiState, thread: ThreadListEntry["thread"]): UiState => ({
    ...s,
    threads: {
      ...s.threads,
      [thread.id]: {
        thread,
        activity: s.threads[thread.id]?.activity ?? {
          running: 0,
          awaitingInput: 0,
          awaitingApproval: 0,
        },
      },
    },
  });
  const patch = (id: string, fields: Partial<ThreadListEntry["thread"]>) => (s: UiState) => {
    const t = s.threads[id];
    return t === undefined ? s : putThread(s, { ...t.thread, ...fields });
  };

  return {
    ...load,
    all,
    main,
    active,
    archived,
    create: async (params: MethodParams<"threads.create"> = { kind: "side" }) => {
      const { thread } = await store.call("threads.create", params);
      store.update((s) => putThread(s, thread));
      return thread;
    },
    rename: (threadId: string, title: string) =>
      store.mutate({
        optimistic: patch(threadId, { title, titleSource: "user" }),
        run: () => store.call("threads.rename", { threadId, title }),
        commit: (s, r) => putThread(s, r.thread),
      }),
    archive: (threadId: string, archivedAt = new Date().toISOString()) =>
      store.mutate({
        optimistic: patch(threadId, { archivedAt }),
        run: () => store.call("threads.archive", { threadId }),
        commit: (s, r) => putThread(s, r.thread),
      }),
    restore: (threadId: string) =>
      store.mutate({
        optimistic: patch(threadId, { archivedAt: null }),
        run: () => store.call("threads.restore", { threadId }),
        commit: (s, r) => putThread(s, r.thread),
      }),
    pin: (threadId: string, pinned: boolean) =>
      store.mutate({
        optimistic: patch(threadId, { pinned }),
        run: () => store.call("threads.pin", { threadId, pinned }),
        commit: (s, r) => putThread(s, r.thread),
      }),
    fork: async (threadId: string, messageId: string, title?: string) => {
      const { thread } = await store.call("threads.fork", {
        threadId,
        messageId,
        ...(title === undefined ? {} : { title }),
      });
      store.update((s) => putThread(s, thread));
      return thread;
    },
    remove: async (threadId: string, alsoForget = false) => {
      await store.call("threads.delete", { threadId, alsoForget });
      store.update((s) => {
        const { [threadId]: _gone, ...threads } = s.threads;
        return { ...s, threads };
      });
    },
  };
}

export interface ThreadView {
  thread: ThreadListEntry | null;
  messages: readonly Message[];
  /** Streaming agent text not yet committed, in arrival order. */
  streaming: readonly StreamingMessage[];
  queue: readonly QueuedFollowUp[];
  /** True while a run in this thread is working. */
  running: boolean;
  hasMore: boolean;
}

/** One thread's transcript, streaming text and follow-up queue. */
export function useThread(threadId: string | null) {
  const store = useStore();
  const select = useCallback(
    (s: UiState): ThreadView => {
      const id = threadId ?? "";
      const runs = Object.values(s.runs).filter((r) => r.threadId === id);
      // A freshly loaded thread knows its active run only from `activeWriterRunId`.
      const active = s.threads[id]?.thread.activeWriterRunId ?? null;
      const activeRun = active === null ? undefined : s.runs[active];
      const running =
        runs.some((r) => r.status === "running") ||
        (active !== null && (activeRun === undefined || activeRun.status === "running"));
      return {
        thread: s.threads[id] ?? null,
        messages: s.messages[id] ?? EMPTY,
        streaming: Object.values(s.streaming).filter((m) => m.threadId === id),
        queue: s.queue.filter((q) => q.threadId === id),
        running,
        hasMore: (s.historyCursor[id] ?? null) !== null,
      };
    },
    [threadId],
  );
  const view = useStoreStateShallow(select);

  const load = useLoader(threadId === null ? null : `thread:${threadId}`, async (st) => {
    if (threadId === null) return;
    const version = st.version();
    const [entry, history] = await Promise.all([
      st.call("threads.get", { threadId }),
      st.call("chat.history", { threadId, limit: 100 }),
    ]);
    st.update((s) => {
      const known = s.messages[threadId] ?? [];
      const fetched = history.messages.filter(
        (m) => (s.touched[`messages:${m.id}`] ?? -1) <= version,
      );
      const byId = new Map(known.map((m) => [m.id, m]));
      for (const m of fetched) byId.set(m.id, m);
      return {
        ...s,
        threads:
          (s.touched[`threads:${threadId}`] ?? -1) > version
            ? s.threads
            : { ...s.threads, [threadId]: entry },
        messages: { ...s.messages, [threadId]: [...byId.values()].sort((a, b) => a.seq - b.seq) },
        historyCursor: { ...s.historyCursor, [threadId]: history.nextCursor ?? null },
      };
    });
  });

  const sendNow = useCallback(
    async (content: string, mode: QueueMode | undefined, replyToMessageId?: string | null) => {
      if (threadId === null) return;
      return store.call("chat.send", {
        threadId,
        content,
        ...(mode ? { mode } : {}),
        ...(replyToMessageId ? { replyToMessageId } : {}),
      });
    },
    [store, threadId],
  );

  /**
   * Sends a message. While the agent is mid-turn, `followUp` messages wait in the client-side
   * queue (shown above the composer, removable) and are sent when the run settles; `steer` and
   * `interrupt` go to the Gateway at once (architecture §4.2).
   */
  const send = useCallback(
    async (
      content: string,
      options: { mode?: QueueMode; replyToMessageId?: string | null } = {},
    ) => {
      if (threadId === null) return;
      const mode = options.mode ?? "followUp";
      if (view.running && mode === "followUp") {
        const item: QueuedFollowUp = {
          id: `queued-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
          threadId,
          content,
          mode,
          replyToMessageId: options.replyToMessageId ?? null,
        };
        store.update((s) => ({ ...s, queue: [...s.queue, item] }));
        return;
      }
      await sendNow(content, view.running ? mode : undefined, options.replyToMessageId ?? null);
    },
    [store, threadId, view.running, sendNow],
  );

  // Drain the follow-up queue once the run settles.
  const queued = view.queue;
  const running = view.running;
  // The store hands each item to one caller only, so several components watching the same
  // thread never send it twice; a failure parks the item (marked failed) instead of retrying.
  useEffect(() => {
    if (running || threadId === null || queued.length === 0) return;
    const next = store.takeQueued(threadId);
    if (next === null) return;
    void sendNow(next.content, undefined, next.replyToMessageId).then(
      () => store.sentQueued(next),
      () => store.failQueued(next),
    );
  }, [running, queued, store, sendNow, threadId]);

  return {
    ...view,
    ...load,
    send,
    retryQueued: (id: string) => store.retryQueued(id),
    removeQueued: (id: string) =>
      store.update((s) => ({ ...s, queue: s.queue.filter((q) => q.id !== id) })),
    cancel: async () => {
      if (threadId === null) return;
      await store.call("chat.cancel", { threadId });
    },
    loadOlder: async () => {
      if (threadId === null) return;
      const cursor = store.getState().historyCursor[threadId];
      if (cursor == null) return;
      const page = await store.call("chat.history", { threadId, cursor, limit: 100 });
      store.update((s) => {
        const byId = new Map((s.messages[threadId] ?? []).map((m) => [m.id, m]));
        for (const m of page.messages) if (!byId.has(m.id)) byId.set(m.id, m);
        return {
          ...s,
          messages: { ...s.messages, [threadId]: [...byId.values()].sort((a, b) => a.seq - b.seq) },
          historyCursor: { ...s.historyCursor, [threadId]: page.nextCursor ?? null },
        };
      });
    },
    exportAs: (format: "markdown" | "json") =>
      threadId === null
        ? Promise.reject(new Error("no thread"))
        : store.call("chat.export", { threadId, format }),
  };
}

const EMPTY: readonly Message[] = [];

/** Like `useStoreState`, but keeps the previous object when every field is identical. */
function useStoreStateShallow<T extends object>(select: (s: UiState) => T): T {
  const last = useRef<T | null>(null);
  const stable = useCallback(
    (s: UiState) => {
      const next = select(s);
      const prev = last.current;
      if (prev !== null && shallowEqual(prev, next)) return prev;
      last.current = next;
      return next;
    },
    [select],
  );
  return useStoreState(stable);
}

function shallowEqual(a: object, b: object): boolean {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) {
    const va = (a as Record<string, unknown>)[k];
    const vb = (b as Record<string, unknown>)[k];
    if (Array.isArray(va) && Array.isArray(vb)) {
      if (va.length !== vb.length || va.some((x, i) => x !== vb[i])) return false;
    } else if (va !== vb) return false;
  }
  return true;
}

// --- Approvals ------------------------------------------------------------------------------

export interface ApprovalView {
  approval: ApprovalRequest;
  /** This surface may answer (it holds an unused answer token). */
  canAnswer: boolean;
  /** Shown before a reconnect and not yet re-issued. */
  stale: boolean;
}

export function useApprovals() {
  const store = useStore();
  const approvals = useStoreState((s) => s.approvals);
  const tokens = useStoreState((s) => s.answerTokens);
  const stale = useStoreState((s) => s.staleApprovals);
  const load = useLoader("approvals", async (st) => {
    const version = st.version();
    const res = await st.call("approvals.list", {
      status: ["pending", "approved", "denied", "expired", "invalidated"],
    });
    st.update((s) => {
      const next = putMany(s, "approvals", res.approvals, version);
      const staleNext: Record<string, true> = { ...next.staleApprovals };
      for (const a of res.approvals) if (a.status === "pending") delete staleNext[a.id];
      return {
        ...next,
        answerTokens: { ...next.answerTokens, ...(res.answerTokens ?? {}) },
        staleApprovals: staleNext,
      };
    });
  });
  const views = useMemo(() => {
    const list = Object.values(approvals)
      .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt))
      .map(
        (approval): ApprovalView => ({
          approval,
          canAnswer: tokens[approval.id] !== undefined && stale[approval.id] === undefined,
          stale: stale[approval.id] !== undefined,
        }),
      );
    return {
      all: list,
      pending: list.filter((v) => v.approval.status === "pending"),
      recent: list.filter((v) => v.approval.status !== "pending"),
    };
  }, [approvals, tokens, stale]);

  return {
    ...load,
    ...views,
    answer: (id: string, decision: "approve" | "deny", scope?: GrantScope) =>
      answerApproval(store, id, decision, scope),
  };
}

export async function answerApproval(
  store: GatewayStore,
  approvalId: string,
  decision: "approve" | "deny",
  scope?: GrantScope,
) {
  const token = store.getState().answerTokens[approvalId];
  if (token === undefined) {
    throw new Error(
      "This device has no answer token for that approval. Answer it where it was sent.",
    );
  }
  return store.mutate({
    run: () =>
      store.call("approvals.answer", {
        approvalId,
        answerToken: token,
        decision,
        ...(decision === "approve" && scope !== undefined ? { scope } : {}),
      }),
    commit: (s, r) => {
      const { [approvalId]: _used, ...answerTokens } = s.answerTokens;
      return { ...put(s, "approvals", r.approval), answerTokens };
    },
  });
}

/** One approval (for blocks and notification rows); loads it when it is not in the store. */
export function useApproval(approvalId: string | null) {
  const store = useStore();
  const approval = useStoreState((s) =>
    approvalId === null ? undefined : s.approvals[approvalId],
  );
  const canAnswer = useStoreState(
    (s) =>
      approvalId !== null &&
      s.answerTokens[approvalId] !== undefined &&
      s.staleApprovals[approvalId] === undefined,
  );
  const stale = useStoreState((s) => approvalId !== null && s.staleApprovals[approvalId] === true);
  const missing = approvalId !== null && approval === undefined;
  const load = useLoader(missing ? `approval:${approvalId}` : null, async (st) => {
    if (approvalId === null) return;
    const res = await st.call("approvals.get", { approvalId });
    st.update((s) => ({
      ...put(s, "approvals", res.approval),
      answerTokens:
        res.answerToken === undefined
          ? s.answerTokens
          : { ...s.answerTokens, [approvalId]: res.answerToken },
    }));
  });
  return {
    ...load,
    approval: approval ?? null,
    canAnswer,
    stale,
    answer: (decision: "approve" | "deny", scope?: GrantScope) =>
      approvalId === null
        ? Promise.reject(new Error("no approval"))
        : answerApproval(store, approvalId, decision, scope),
  };
}

// --- Questions --------------------------------------------------------------------------------

export type QuestionAnswer = Record<string, string | string[]>;

export function useQuestion(inputRequestId: string | null) {
  const store = useStore();
  const request = useStoreState((s) =>
    inputRequestId === null ? undefined : s.inputRequests[inputRequestId],
  );
  const missing = inputRequestId !== null && request === undefined;
  const load = useLoader(missing ? `question:${inputRequestId}` : null, async (st) => {
    if (inputRequestId === null) return;
    const res = await st.call("questions.get", { inputRequestId });
    st.update((s) => put(s, "inputRequests", res.inputRequest));
  });
  return {
    ...load,
    request: request ?? null,
    answer: (answer: QuestionAnswer) => {
      if (inputRequestId === null) return Promise.reject(new Error("no question"));
      return store.mutate({
        optimistic: (s) => {
          const r = s.inputRequests[inputRequestId];
          return r === undefined
            ? s
            : put(s, "inputRequests", { ...r, status: "answered", answer });
        },
        run: () => store.call("questions.answer", { inputRequestId, answer }),
        commit: (s, r) => put(s, "inputRequests", r.inputRequest),
      });
    },
  };
}

export function useQuestions(filter: { threadId?: string } = {}) {
  const requests = useStoreState((s) => s.inputRequests);
  const load = useLoader(`questions:${filter.threadId ?? "*"}`, async (st) => {
    const version = st.version();
    const res = await st.call("questions.list", {
      status: ["open"],
      ...(filter.threadId === undefined ? {} : { threadId: filter.threadId }),
    });
    st.update((s) => putMany(s, "inputRequests", res.inputRequests, version));
  });
  const open = useMemo(
    () =>
      Object.values(requests)
        .filter(
          (r): r is InputRequest =>
            r.status === "open" &&
            (filter.threadId === undefined || r.threadId === filter.threadId),
        )
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [requests, filter.threadId],
  );
  return { ...load, open };
}

// --- Tasks ------------------------------------------------------------------------------------

export function useTasks(filter: { threadId?: string } = {}) {
  const store = useStore();
  const tasks = useStoreState((s) => s.tasks);
  const load = useLoader(`tasks:${filter.threadId ?? "*"}`, async (st) => {
    const version = st.version();
    const res = await st.call("tasks.list", {
      ...(filter.threadId === undefined ? {} : { threadId: filter.threadId }),
    });
    st.update((s) => putMany(s, "tasks", res.tasks, version));
  });
  const all = useMemo(
    () =>
      Object.values(tasks)
        .filter((t) => filter.threadId === undefined || t.threadId === filter.threadId)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [tasks, filter.threadId],
  );
  const running = all.filter((t) => t.status === "running" || t.status === "queued");
  const needsYou = all.filter(
    (t) => t.status === "awaiting_approval" || t.status === "awaiting_input",
  );
  return { ...load, all, running, needsYou, ...taskActions(store) };
}

function taskActions(store: GatewayStore) {
  const act =
    (method: "tasks.pause" | "tasks.resume" | "tasks.cancel", status: Task["status"]) =>
    (taskId: string) =>
      store.mutate({
        optimistic: (s) => {
          const t = s.tasks[taskId];
          return t === undefined ? s : put(s, "tasks", { ...t, status });
        },
        run: () => store.call(method, { taskId }),
        commit: (s, r) => put(s, "tasks", r.task),
      });
  return {
    pause: act("tasks.pause", "paused"),
    resume: act("tasks.resume", "running"),
    cancel: act("tasks.cancel", "cancelled"),
    retry: async (taskId: string, fromStepId?: string) => {
      const r = await store.call("tasks.retry", {
        taskId,
        ...(fromStepId === undefined ? {} : { fromStepId }),
      });
      store.update((s) => put(s, "tasks", r.task));
      return r.task;
    },
  };
}

export function useTask(taskId: string | null, options: { withActions?: boolean } = {}) {
  const store = useStore();
  const task = useStoreState((s) => (taskId === null ? undefined : s.tasks[taskId]));
  const actions = useStoreState((s) =>
    taskId === null ? EMPTY_ACTIONS : (s.taskActions[taskId] ?? EMPTY_ACTIONS),
  );
  const load = useLoader(
    taskId === null ? null : `task:${taskId}:${options.withActions === true}`,
    async (st) => {
      if (taskId === null) return;
      const [t, a] = await Promise.all([
        st.call("tasks.get", { taskId }),
        options.withActions === true ? st.call("tasks.actions", { taskId }) : Promise.resolve(null),
      ]);
      st.update((s) => {
        let next = put(s, "tasks", t.task);
        if (a !== null) {
          const byId = new Map((s.taskActions[taskId] ?? []).map((x) => [x.id, x]));
          for (const x of a.actions) byId.set(x.id, x);
          next = {
            ...next,
            taskActions: {
              ...next.taskActions,
              [taskId]: [...byId.values()].sort((x, y) => x.idx - y.idx),
            },
          };
        }
        return next;
      });
    },
  );
  return { ...load, task: task ?? null, actions, ...taskActions(store) };
}

const EMPTY_ACTIONS: readonly TaskAction[] = [];

// --- Lookups for blocks -----------------------------------------------------------------------

function useEntity<T>(
  key: string,
  id: string | null,
  select: (s: UiState, id: string) => T | undefined,
  fetch: (store: GatewayStore, id: string) => Promise<void>,
) {
  const value = useStoreState((s) => (id === null ? undefined : select(s, id)));
  const load = useLoader(id !== null && value === undefined ? `${key}:${id}` : null, (st) =>
    id === null ? Promise.resolve() : fetch(st, id),
  );
  return { ...load, value: value ?? null };
}

export function useReceipt(receiptId: string | null): LoadState & { receipt: Receipt | null } {
  const r = useEntity(
    "receipt",
    receiptId,
    (s, id) => s.receipts[id],
    async (st, id) => {
      const res = await st.call("receipts.get", { receiptId: id });
      st.update((s) => put(s, "receipts", res.receipt));
    },
  );
  return { ...r, receipt: r.value };
}

export function useArtifact(artifactId: string | null): LoadState & { artifact: Artifact | null } {
  const r = useEntity(
    "artifact",
    artifactId,
    (s, id) => s.artifacts[id],
    async (st, id) => {
      const res = await st.call("artifacts.get", { artifactId: id });
      st.update((s) => put(s, "artifacts", res.artifact));
    },
  );
  return { ...r, artifact: r.value };
}

export function useLibraryItem(itemId: string | null): LoadState & { item: LibraryItem | null } {
  const r = useEntity(
    "library",
    itemId,
    (s, id) => s.library[id],
    async (st, id) => {
      const res = await st.call("library.get", { itemId: id });
      st.update((s) => put(s, "library", res.item));
    },
  );
  return { ...r, item: r.value };
}

export function useToolCall(toolCallId: string | null): ToolCall | null {
  return useStoreState((s) => (toolCallId === null ? null : (s.toolCalls[toolCallId] ?? null)));
}

export function useLibrary(filter: MethodParams<"library.list"> = {}) {
  const items = useStoreState((s) => s.library);
  const key = JSON.stringify(filter);
  const load = useLoader(`library:${key}`, async (st) => {
    const version = st.version();
    const res = await st.call("library.list", filter);
    st.update((s) => putMany(s, "library", res.items, version));
  });
  const list = useMemo(
    () =>
      Object.values(items)
        .filter((i) => filter.kind === undefined || i.kind === filter.kind)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [items, filter.kind],
  );
  return { ...load, items: list };
}

// --- Proactive surfaces -----------------------------------------------------------------------

export function useFeed() {
  const store = useStore();
  const feed = useStoreState((s) => s.feed);
  const nextBriefAt = useStoreState((s) => s.nextBriefAt);
  const load = useLoader("feed", async (st) => {
    const version = st.version();
    const res = await st.call("feed.list", {});
    st.update((s) => ({
      ...putMany(s, "feed", res.posts, version),
      nextBriefAt: res.nextBriefAt ?? null,
    }));
  });
  const posts = useMemo(
    () =>
      Object.values(feed)
        .filter((p) => p.feedback !== "not_interested" && p.feedback !== "hide_source")
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [feed],
  );
  return {
    ...load,
    posts,
    nextBriefAt,
    /** Generates the first (or next) brief now (`feed.generate`). */
    generate: async () => {
      const version = store.version();
      const res = await store.call("feed.generate", {});
      store.update((s) => putMany(s, "feed", res.posts, version));
    },
    /** Optimistic; call again with `null` to undo (UI design §3.9 undo toast). */
    feedback: (postId: string, feedback: FeedPost["feedback"], topic?: string) =>
      store.mutate({
        optimistic: (s) => {
          const p = s.feed[postId];
          return p === undefined ? s : put(s, "feed", { ...p, feedback: feedback ?? null });
        },
        run: () =>
          store.call("feed.feedback", {
            postId,
            feedback: feedback ?? null,
            ...(topic === undefined ? {} : { topic }),
          }),
        commit: (s, r) => put(s, "feed", r.post),
      }),
  };
}

export function useIdeas() {
  const store = useStore();
  const ideas = useStoreState((s) => s.ideas);
  const load = useLoader("ideas", async (st) => {
    const version = st.version();
    const res = await st.call("ideas.list", {});
    st.update((s) => putMany(s, "ideas", res.ideas, version));
  });
  const proposed = useMemo(
    () =>
      Object.values(ideas)
        .filter((i) => i.status === "proposed")
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [ideas],
  );
  const setStatus = (ideaId: string, status: Idea["status"]) => (s: UiState) => {
    const i = s.ideas[ideaId];
    return i === undefined ? s : put(s, "ideas", { ...i, status });
  };
  return {
    ...load,
    proposed,
    accept: (ideaId: string, options: { recurring?: boolean; brief?: string } = {}) =>
      store.mutate({
        optimistic: setStatus(ideaId, options.brief === undefined ? "accepted" : "edited"),
        run: () => store.call("ideas.accept", { ideaId, ...options }),
        commit: (s, r) => put(s, "ideas", r.idea),
      }),
    dismiss: (ideaId: string, reason: IdeaDismissReason) =>
      store.mutate({
        optimistic: setStatus(ideaId, "dismissed"),
        run: () => store.call("ideas.dismiss", { ideaId, reason }),
        commit: (s, r) => put(s, "ideas", r.idea),
      }),
  };
}

export function useGoals() {
  const store = useStore();
  const goals = useStoreState((s) => s.goals);
  const load = useLoader("goals", async (st) => {
    const version = st.version();
    const res = await st.call("goals.list", { status: ["candidate", "active", "paused", "done"] });
    st.update((s) => putMany(s, "goals", res.goals, version));
  });
  const list = useMemo(
    () => Object.values(goals).sort((a, b) => a.title.localeCompare(b.title)),
    [goals],
  );
  return {
    ...load,
    goals: list.filter((g) => g.status !== "candidate" && g.status !== "archived"),
    candidates: list.filter((g) => g.status === "candidate"),
    decide: (goalId: string, decision: "confirm" | "reject" | "later") =>
      store.mutate({
        optimistic: (s) => {
          const g = s.goals[goalId];
          if (g === undefined || decision === "later") return s;
          return put(s, "goals", { ...g, status: decision === "confirm" ? "active" : "archived" });
        },
        run: () => store.call("goals.decide", { goalId, decision }),
        commit: (s, r) => put(s, "goals", r.goal),
      }),
  };
}

export function useGoal(
  goalId: string | null,
): LoadState & { goal: Goal | null; taskIds: string[]; milestones: GoalMilestone[] | null } {
  const goal = useStoreState((s) => (goalId === null ? undefined : s.goals[goalId]));
  // Keyed by goal id, so a slow response for the previous goal never shows under this one.
  const [detail, setDetail] = useState<{
    goalId: string;
    taskIds: string[];
    milestones: GoalMilestone[] | null;
  } | null>(null);
  const load = useLoader(goalId === null ? null : `goal:${goalId}`, async (st) => {
    if (goalId === null) return;
    const res = await st.call("goals.get", { goalId });
    st.update((s) => put(s, "goals", res.goal));
    setDetail({ goalId, taskIds: res.taskIds, milestones: res.milestones ?? null });
  });
  const current = detail?.goalId === goalId ? detail : null;
  return {
    ...load,
    goal: goal ?? null,
    taskIds: current?.taskIds ?? [],
    milestones: current?.milestones ?? null,
  };
}

// --- Inbox, settings, automations, search, memory ---------------------------------------------

export function useNotifications() {
  const store = useStore();
  const notifications = useStoreState((s) => s.notifications);
  const load = useLoader("notifications", async (st) => {
    const version = st.version();
    const res = await st.call("notifications.list", {});
    st.update((s) => putMany(s, "notifications", res.notifications, version));
  });
  const all = useMemo(
    () => Object.values(notifications).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [notifications],
  );
  const unread = all.filter((n) => n.readAt == null);
  const mark = (ids: string[], readAt: string) => (s: UiState) => {
    let next = s;
    for (const id of ids) {
      const n = next.notifications[id];
      if (n !== undefined) next = put(next, "notifications", { ...n, readAt });
    }
    return next;
  };
  return {
    ...load,
    all,
    unread,
    unresolved: all.filter((n) => n.resolvedAt == null),
    markRead: (ids: string[]) =>
      store.mutate({
        optimistic: mark(ids, new Date().toISOString()),
        run: () => store.call("notifications.markRead", { notificationIds: ids }),
        commit: (s) => mark(ids, new Date().toISOString())(s),
      }),
    resolve: (notificationId: string, actionId?: string) =>
      store.mutate({
        run: () =>
          store.call("notifications.resolve", {
            notificationId,
            ...(actionId === undefined ? {} : { actionId }),
          }),
        commit: (s, r) => put(s, "notifications", r.notification as Notification),
      }),
  };
}

export function useSettings() {
  const store = useStore();
  const settings = useStoreState((s) => s.settings);
  const load = useLoader("settings", async (st) => {
    const version = st.version();
    const res = await st.call("settings.get", {});
    st.update((s) => {
      // Keys a settings.changed event touched after the request started are newer than the
      // snapshot; every other key takes the snapshot's value.
      const settings: Record<string, unknown> = { ...res.settings };
      for (const [key, value] of Object.entries(s.settings)) {
        if ((s.touched[`settings:${key}`] ?? -1) > Math.max(version, res.stateVersion)) {
          settings[key] = value;
        }
      }
      return { ...s, settings, stateVersion: Math.max(s.stateVersion, res.stateVersion) };
    });
  });
  return {
    ...load,
    settings,
    set: (key: string, value: unknown) =>
      store.mutate({
        optimistic: (s) => ({ ...s, settings: { ...s.settings, [key]: value } }),
        run: () => store.call("settings.set", { key, value }),
        commit: (s, r) => ({
          ...s,
          settings: { ...s.settings, [r.entry.key]: r.entry.value },
          stateVersion: Math.max(s.stateVersion, r.stateVersion),
        }),
      }),
  };
}

export function useAutomations() {
  const store = useStore();
  const q = useGatewayQuery("automations.list", {});
  const automations: readonly Automation[] = q.data?.automations ?? [];
  return {
    ...q,
    automations,
    runNow: (automationId: string) => store.call("automations.run", { automationId }),
    setEnabled: async (automationId: string, enabled: boolean) => {
      await store.call("automations.update", { automationId, enabled });
      q.reload();
    },
    remove: async (automationId: string) => {
      await store.call("automations.delete", { automationId });
      q.reload();
    },
  };
}

export function useSearch(query: string, scopes?: SearchScope[]) {
  const trimmed = query.trim();
  const q = useGatewayQuery(
    "search.query",
    { query: trimmed === "" ? " " : trimmed, ...(scopes === undefined ? {} : { scopes }) },
    { enabled: trimmed !== "" },
  );
  const hits: readonly SearchHit[] = trimmed === "" ? [] : (q.data?.hits ?? []);
  const groups = useMemo(() => {
    const out = new Map<SearchScope, SearchHit[]>();
    for (const h of hits) out.set(h.scope, [...(out.get(h.scope) ?? []), h]);
    return out;
  }, [hits]);
  return { ...q, hits, groups };
}

export function useMemoryFile(path: string | null) {
  const store = useStore();
  const etag = useStoreState((s) => (path === null ? undefined : s.memoryEtags[path]));
  // Keyed by path, so a slow read of the previous file never shows (or saves) under this one.
  const [loaded, setFile] = useState<{
    path: string;
    content: string;
    etag: string | null;
    updatedAt: string;
  } | null>(null);
  const load = useLoader(path === null ? null : `memory:${path}:${etag ?? ""}`, async (st) => {
    if (path === null) return;
    const res = await st.call("memory.read", { path });
    setFile({ path, content: res.content, etag: res.etag ?? null, updatedAt: res.updatedAt });
  });
  const file = loaded !== null && loaded.path === path ? loaded : null;
  return {
    ...load,
    file,
    /** Saves with if-match; a `conflict` error means the file changed since it was read. */
    save: async (content: string) => {
      if (path === null) return;
      const res = await store.call("memory.write", {
        path,
        content,
        ...(file?.etag == null ? {} : { etag: file.etag }),
      });
      setFile({ path, content, etag: res.etag ?? null, updatedAt: res.updatedAt });
    },
  };
}

/** Streaming text of an agent message, if any (for the typing indicator and partial render). */
export function useStreamingText(messageId: string): string | null {
  return useStoreState((s) => s.streaming[messageId]?.text ?? null);
}
