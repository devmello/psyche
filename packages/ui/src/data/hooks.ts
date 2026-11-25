import type {
  ApprovalRequest,
  Artifact,
  ArtifactOp,
  ArtifactVersion,
  Automation,
  Block,
  ChatContextRef,
  CompactionResult,
  ContextLimits,
  FeedPost,
  Goal,
  GoalLink,
  GoalMilestone,
  GrantScope,
  Idea,
  IdeaDismissReason,
  InputRequest,
  LibraryItem,
  LinkPaymentMethod,
  LinkSetupStatus,
  Message,
  MethodName,
  MethodParams,
  MethodResult,
  Notification,
  QueueMode,
  Receipt,
  Run,
  SearchHit,
  SearchScope,
  Task,
  TaskAction,
  ThreadListEntry,
  ToolCall,
  VaultPayment,
  VmUpdatedPayload,
  Widget,
} from "@psyche/protocol";
import { pinId } from "@psyche/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { t } from "../i18n/core.ts";
import { errorCode as codeOf, describeError } from "../i18n/errors.ts";
import type { ConnectionState } from "./client.ts";
import { isEmptyUserChat } from "./empty-chat.ts";
import type { OutboxItem } from "./outbox.ts";
import { useStore, useStoreState } from "./provider.tsx";
import {
  type ArtifactContent,
  put,
  putMany,
  type QueuedFollowUp,
  replaceLibraryWindow,
  type StreamingMessage,
  type ThreadContextEntry,
  type UiState,
  type WidgetDraftState,
  withThreadCleared,
} from "./state.ts";
import type { GatewayStore } from "./store.ts";
import {
  applyHeadPage,
  loadAllThreadPages,
  loadNextThreadPage,
  threadPageKey,
} from "./thread-pages.ts";

/**
 * Typed hooks over the Gateway (S12 data layer). Each hook loads its collection on mount,
 * registers a refresher for gaps and reconnects, and exposes actions. Mutations that the user
 * expects to see at once are optimistic and reconciled when the request settles.
 */

/**
 * Why a loader runs: `mount` is a fresh start or the owner's reload; `refresh` is the store
 * rerunning every loader after an event gap or a reconnect. A loader whose data cannot have
 * changed behind the client's back (a finished run's steps) may skip a `refresh`.
 */
export type LoadCause = "mount" | "refresh";

export interface LoadState {
  loading: boolean;
  error: string | null;
  /** The Gateway's error code behind `error` (`rate_limited`, `unknown_method`, …), when it has one. */
  errorCode?: string | null;
  reload: () => void;
}

/** What a failed load shows: the error through the catalogue (`describeError`). */
const messageOf = (err: unknown) => describeError(err);

/**
 * Runs `load` on mount and whenever `key` changes; reruns it after gaps and reconnects. Mounted
 * before the first pairing, it stays loading (skeletons, §5.10) and runs when the connection
 * settles, so a load only shows an error for a failure after that (#592).
 */
export function useLoader(
  key: string | null,
  load: (store: GatewayStore, cause: LoadCause) => Promise<void>,
): LoadState {
  const store = useStore();
  const [loading, setLoading] = useState(key !== null && !store.detached);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const loadRef = useRef(load);
  loadRef.current = load;
  const [tick, setTick] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `tick` forces a reload from `reload()`
  useEffect(() => {
    // Without a Gateway (rendered outside a provider) there is nothing to load: stay idle.
    if (key === null || store.detached) {
      setLoading(false);
      return;
    }
    let live = true;
    const run = async (cause: LoadCause = "mount") => {
      setLoading(true);
      try {
        await loadRef.current(store, cause);
        if (live) {
          setError(null);
          setErrorCode(null);
        }
      } catch (err) {
        if (live) {
          setError(messageOf(err));
          setErrorCode(codeOf(err));
        }
        throw err;
      } finally {
        if (live) setLoading(false);
      }
    };
    // Before the first pairing, wait and run once the connection settles (#592).
    const start = () => void run().catch(() => {});
    const unsettled = store.awaitingConnection ? store.onSettled(start) : undefined;
    if (unsettled === undefined) start();
    const unregister = store.registerRefresher(key, () => run("refresh"));
    return () => {
      live = false;
      unsettled?.();
      unregister();
    };
  }, [key, store, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { loading, error, errorCode, reload };
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

/** What `usePayments` keeps: Stripe Link's methods and recent spends, or "not set up". */
export interface PaymentsData {
  /** True once Link is connected and signed in; false while it is being set up. */
  configured: boolean;
  /** Where the guided Link setup stands (`payments.link.status`); absent on an older Gateway. */
  setup?: LinkSetupStatus;
  methods: LinkPaymentMethod[];
  payments: VaultPayment[];
}

function notConfigured(err: unknown): boolean {
  const e = err as { code?: unknown; details?: { reason?: unknown } } | null;
  return e?.code === "unavailable" && e.details?.reason === "payments_not_configured";
}

/** An older Gateway without the guided setup answers `unknown_method` or `not_implemented`. */
function noGuidedSetup(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === "unknown_method" || code === "not_implemented";
}

/**
 * Stripe Link payments (G12) for Settings → Credentials: the guided setup status, then
 * `vault.payments.methods` and `vault.payments.list` once Link is connected. Reloads on
 * `vault.payment.updated` and `payments.link.changed`.
 */
export function usePayments(limit = 20): LoadState & { data: PaymentsData | undefined } {
  const key = `vault.payments:${limit}`;
  const entry = useStoreState((s) => s.queries[key]);
  const load = useLoader(`query:${key}`, async (store) => {
    const version = store.version();
    let data: PaymentsData;
    let setup: LinkSetupStatus | undefined;
    try {
      setup = await store.call("payments.link.status", {});
    } catch (err) {
      if (!noGuidedSetup(err)) throw err;
    }
    if (setup !== undefined && setup.state !== "connected") {
      data = { configured: false, setup, methods: [], payments: [] };
    } else {
      try {
        const [m, l] = await Promise.all([
          store.call("vault.payments.methods", {}),
          store.call("vault.payments.list", { limit }),
        ]);
        data = {
          configured: true,
          ...(setup === undefined ? {} : { setup }),
          methods: m.methods,
          payments: l.payments,
        };
      } catch (err) {
        if (!notConfigured(err)) throw err;
        data = {
          configured: false,
          ...(setup === undefined ? {} : { setup }),
          methods: [],
          payments: [],
        };
      }
    }
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
  return { ...load, data: entry?.data as PaymentsData | undefined };
}

/** The hidden thread one automation run works in: its automation's chat lists the run instead. */
const isRunThread = (e: ThreadListEntry): boolean =>
  e.thread.kind === "automation" && e.thread.sessionKey.startsWith("cron:");

// --- Threads ----------------------------------------------------------------------------------

export function useThreads(options: { includeArchived?: boolean } = {}) {
  const includeArchived = options.includeArchived ?? true;
  const pageKey = threadPageKey(includeArchived);
  const threadsDict = useStoreState((s) => s.threads);
  const page = useStoreState((s) => s.threadPages[pageKey]);
  // The first page only; later pages load through `loadMore` / `loadAll` (thread-pages.ts).
  const load = useLoader(`threads:${includeArchived}`, async (store) => {
    const version = store.version();
    const res = await store.call("threads.list", { includeArchived });
    store.update((s) => applyHeadPage(s, pageKey, res, version));
  });
  const store = useStore();
  const all = useMemo(
    () =>
      Object.values(threadsDict)
        .filter((e) => !isEmptyUserChat(e) && !isRunThread(e))
        .sort((a, b) =>
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
      // Keep lastMessage and automation: rename, pin and archive must not wipe them.
      [thread.id]: {
        ...s.threads[thread.id],
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
    /** The Gateway holds threads past the loaded pages. */
    hasMore: page !== undefined && page.cursor !== null,
    loadingMore: page?.loading === true,
    /** Loads the next page; false when there is none or it failed (the cursor stays). */
    loadMore: () => loadNextThreadPage(store, includeArchived),
    /** Loads every remaining page, so a search can reach all threads. */
    loadAll: () => loadAllThreadPages(store, includeArchived),
    /**
     * New chat: the empty chat the owner already has (the one on screen first), else a new one.
     * It is not listed until it has a message.
     */
    newChat: async (kind: "side" | "incognito" = "side", preferThreadId?: string) => {
      const { thread } = await store.call("threads.newChat", {
        kind,
        ...(preferThreadId === undefined ? {} : { preferThreadId }),
      });
      store.update((s) => putThread(s, thread));
      return thread;
    },
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
    /** Clear chat: empties the thread in place (the main chat cannot be deleted). */
    clear: (threadId: string, alsoForget = false) => clearThread(store, threadId, alsoForget),
  };
}

/**
 * Empties a thread in place (`threads.clear`): its messages go and the agent starts fresh, while
 * the thread, receipts and the activity log stay. `alsoForget` also stages a retraction of the
 * memory derived from it (confirmed in Memory). The window drops the transcript at once; the
 * Gateway's `thread.cleared` does the same in every other window.
 */
export async function clearThread(
  store: GatewayStore,
  threadId: string,
  alsoForget = false,
): Promise<void> {
  await store.call("threads.clear", { threadId, ...(alsoForget ? { alsoForget: true } : {}) });
  store.update((s) => withThreadCleared(s, threadId));
}

export interface ThreadView {
  thread: ThreadListEntry | null;
  messages: readonly Message[];
  /** Streaming agent text not yet committed, in arrival order. */
  streaming: readonly StreamingMessage[];
  queue: readonly QueuedFollowUp[];
  /** True while a run in this thread is working. */
  running: boolean;
  /** Runs of this thread that failed (#539: their error shows in the transcript). */
  failedRuns: readonly Run[];
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
        failedRuns: runs.filter((r) => r.status === "failed"),
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
    async (
      content: string,
      mode: QueueMode | undefined,
      replyToMessageId?: string | null,
      attachments?: readonly string[],
      context?: SendContext,
      attachedFiles?: readonly { path: string }[],
      resolveSkills?: boolean,
    ) => {
      if (threadId === null) return;
      const pendingId = `pending-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      const createdAt = new Date().toISOString();
      const baseSeq = store.getState().messages[threadId]?.at(-1)?.seq ?? -1;
      // The message shows in the same frame as Return (smoothness-2026 C1); the overlay drops once
      // the request settles, and a failed send leaves nothing behind for the caller to retry.
      return store.mutate({
        optimistic: (s) =>
          withPendingUserMessage(
            s,
            threadId,
            pendingId,
            content,
            createdAt,
            baseSeq,
            context?.block,
          ),
        run: () =>
          store.call("chat.send", {
            threadId,
            content,
            ...(mode ? { mode } : {}),
            ...(replyToMessageId ? { replyToMessageId } : {}),
            ...(attachments && attachments.length > 0 ? { attachments: [...attachments] } : {}),
            ...(attachedFiles && attachedFiles.length > 0
              ? { attachedFiles: attachedFiles.map((f) => ({ path: f.path })) }
              : {}),
            ...(context ? { context: context.ref } : {}),
            ...(resolveSkills ? { resolveSkills: true } : {}),
          }),
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
      options: {
        mode?: QueueMode;
        replyToMessageId?: string | null;
        /** Library item ids (finished uploads) sent with the message. */
        attachments?: readonly string[];
        /** Files from disk the owner attached (desktop); `chat.attachFiles` granted them. */
        attachedFiles?: readonly { path: string }[];
        /** What the message is about (Feed "Ask about this"); sent at once, never queued. */
        context?: SendContext;
        /**
         * The composer's own submit: `$name` references read their skills. Buttons, prefills and
         * other senders leave it off.
         */
        resolveSkills?: boolean;
        /**
         * Sending one queued message by hand ("Send now") leaves the others held after a Stop.
         * Any other send is the owner carrying on, so what Stop held goes out after it.
         */
        keepQueueParked?: boolean;
      } = {},
    ) => {
      if (threadId === null) return;
      if (options.keepQueueParked !== true) store.resumeQueued(threadId);
      const mode = options.mode ?? "followUp";
      // Remote windows: while the Gateway can't be reached the message waits in the outbox and
      // goes out on reconnect, once (its key is kept). Messages with a file or a context chip
      // need the connection to be built, so they never get here offline.
      if (
        store.outbox !== undefined &&
        store.getState().connection !== "open" &&
        !options.context &&
        (options.attachments ?? []).length === 0 &&
        (options.attachedFiles ?? []).length === 0
      ) {
        store.outbox.enqueue({
          threadId,
          content,
          ...(options.replyToMessageId ? { replyToMessageId: options.replyToMessageId } : {}),
          ...(options.resolveSkills ? { resolveSkills: true } : {}),
        });
        return;
      }
      if (options.context) {
        await sendNow(
          content,
          view.running ? mode : undefined,
          options.replyToMessageId ?? null,
          options.attachments,
          options.context,
          options.attachedFiles,
          options.resolveSkills,
        );
        return;
      }
      if (view.running && mode === "followUp") {
        const item: QueuedFollowUp = {
          id: `queued-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
          threadId,
          content,
          mode,
          replyToMessageId: options.replyToMessageId ?? null,
          ...(options.attachments && options.attachments.length > 0
            ? { attachments: options.attachments }
            : {}),
          ...(options.attachedFiles && options.attachedFiles.length > 0
            ? { attachedFiles: options.attachedFiles }
            : {}),
        };
        store.update((s) => ({ ...s, queue: [...s.queue, item] }));
        return;
      }
      await sendNow(
        content,
        view.running ? mode : undefined,
        options.replyToMessageId ?? null,
        options.attachments,
        undefined,
        options.attachedFiles,
        options.resolveSkills,
      );
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
    void sendNow(
      next.content,
      undefined,
      next.replyToMessageId,
      next.attachments,
      undefined,
      next.attachedFiles,
    ).then(
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
      // Stop means stop: the follow-ups waiting behind this run do not start the moment it ends.
      store.parkQueued(threadId);
      await store.call("chat.cancel", { threadId });
    },
    /** Sends a follow-up Stop held; `undefined` releases every held one of this thread. */
    resumeQueued: (id?: string) => {
      if (threadId !== null) store.resumeQueued(threadId, id);
    },
    loadOlder: async (): Promise<boolean> => {
      if (threadId === null) return false;
      return loadOlderMessages(store, threadId);
    },
    exportAs: (format: "markdown" | "json") =>
      threadId === null
        ? Promise.reject(new Error("no thread"))
        : store.call("chat.export", { threadId, format }),
  };
}

const EMPTY: readonly Message[] = [];

/** Loads the page of a thread's history before what is loaded; false when there is none. */
export function loadOlderMessages(store: GatewayStore, threadId: string): Promise<boolean> {
  // One page at a time: the scroll sentinel and a focus request may ask together.
  return sharedLoad(store, `older:${threadId}`, async () => {
    const cursor = store.getState().historyCursor[threadId];
    if (cursor == null) return false;
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
    return true;
  });
}

const NO_CONTEXT: ThreadContextEntry = { usage: null };

/** Reads a thread's context usage and limits into the store. */
export async function refreshThreadContext(store: GatewayStore, threadId: string): Promise<void> {
  const version = store.version();
  const res = await store.call("threads.contextUsage", { threadId });
  store.update((s) => {
    const prev = s.threadContext[threadId];
    // A turn that ended after the request started reported newer usage than the answer.
    const newer = (s.touched[`threadContext:${threadId}`] ?? -1) > version ? prev : undefined;
    return {
      ...s,
      threadContext: {
        ...s.threadContext,
        [threadId]: {
          usage: newer?.usage ?? res.usage ?? null,
          ...((newer?.limits ?? res.limits) ? { limits: newer?.limits ?? res.limits } : {}),
          threadLimits: res.threadLimits ?? {},
        },
      },
    };
  });
}

/** Compacts a thread's earlier turns now, then rereads its usage; null when nothing to compact. */
export async function compactThread(
  store: GatewayStore,
  threadId: string,
): Promise<CompactionResult | null> {
  const { compaction } = await store.call("threads.compact", { threadId });
  await refreshThreadContext(store, threadId).catch(() => undefined);
  return compaction;
}

/**
 * Removes one standing instruction from a thread's summary (the owner's own control), and from
 * the compaction blocks already loaded, which would otherwise keep showing it.
 */
export async function removeSummaryPin(
  store: GatewayStore,
  threadId: string,
  instruction: string,
): Promise<void> {
  const id = pinId(instruction);
  await store.call("threads.summary.pins.remove", { threadId, pinId: id });
  store.update((s) => ({
    ...s,
    messages: {
      ...s.messages,
      [threadId]: (s.messages[threadId] ?? []).map((m) => ({
        ...m,
        blocks: m.blocks.map((b) =>
          b.type === "compaction"
            ? {
                ...b,
                summary: {
                  ...b.summary,
                  pinnedInstructions: b.summary.pinnedInstructions.filter((i) => pinId(i) !== id),
                },
              }
            : b,
        ),
      })),
    },
  }));
}

/**
 * A thread's context usage and limits (the header meter, "Compact now", the per-chat limits):
 * `threads.contextUsage` on open, then `thread.context.updated` after every turn.
 */
export function useThreadContext(threadId: string | null) {
  const store = useStore();
  const entry = useStoreState((s) =>
    threadId === null ? NO_CONTEXT : (s.threadContext[threadId] ?? NO_CONTEXT),
  );
  const load = useLoader(threadId === null ? null : `threadContext:${threadId}`, (st) =>
    threadId === null ? Promise.resolve() : refreshThreadContext(st, threadId),
  );
  const [compacting, setCompacting] = useState(false);
  return {
    ...load,
    ...entry,
    compacting,
    /** Compacts the thread's earlier turns now; null when there was nothing to compact. */
    compact: async () => {
      if (threadId === null) return null;
      setCompacting(true);
      try {
        return await compactThread(store, threadId);
      } finally {
        setCompacting(false);
      }
    },
    /** Sets this thread's own limits; null clears them and the thread follows Settings again. */
    setLimits: async (limits: ContextLimits | null) => {
      if (threadId === null) return;
      const res = await store.call("threads.setContextLimits", { threadId, limits });
      store.update((s) => {
        const prev = s.threadContext[threadId] ?? NO_CONTEXT;
        return {
          ...s,
          threadContext: {
            ...s.threadContext,
            [threadId]: { ...prev, limits: res.limits, threadLimits: res.threadLimits },
          },
        };
      });
    },
  };
}

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

/**
 * Runs `work` once per store and key while one is in flight; a second caller (another mounted
 * consumer of the same list) shares its result instead of paging the Gateway again. Once it
 * settles, the next caller (a refresh, a remount) loads afresh.
 */
const sharedLoads = new WeakMap<GatewayStore, Map<string, Promise<unknown>>>();
function sharedLoad<T>(store: GatewayStore, key: string, work: () => Promise<T>): Promise<T> {
  let byKey = sharedLoads.get(store);
  if (byKey === undefined) {
    byKey = new Map();
    sharedLoads.set(store, byKey);
  }
  const running = byKey.get(key);
  if (running !== undefined) return running as Promise<T>;
  const promise = work().finally(() => {
    if (byKey.get(key) === promise) byKey.delete(key);
  });
  byKey.set(key, promise);
  return promise;
}

/** Resolved approvals are history: one page at a time. Pending ones always load in full. */
const RESOLVED_STATUSES = ["approved", "denied", "expired", "invalidated"] as const;
const APPROVAL_PAGE = 100;
/** A runaway cursor chain stops here (500 pages of 500). */
const MAX_PAGES = 500;

export function useApprovals() {
  const store = useStore();
  const approvals = useStoreState((s) => s.approvals);
  const tokens = useStoreState((s) => s.answerTokens);
  const stale = useStoreState((s) => s.staleApprovals);
  // Cursor for the next page of resolved approvals; null once the history is complete.
  const [recentCursor, setRecentCursor] = useState<string | null>(null);
  const beyondHead = useRef(false);
  const [loadingMoreRecent, setLoadingMoreRecent] = useState(false);
  const load = useLoader("approvals", async (st) => {
    const headCursor = await sharedLoad(st, "approvals", async () => {
      // Every pending approval, however old: an unlisted one has no card and no answer token, so
      // it could never be answered and its run would wait forever. The pending set is small.
      let cursor: string | undefined;
      for (let page = 0; page < MAX_PAGES; page++) {
        const version = st.version();
        const res = await st.call("approvals.list", {
          status: ["pending"],
          limit: 500,
          ...(cursor === undefined ? {} : { cursor }),
        });
        st.update((s) => {
          const next = putMany(s, "approvals", res.approvals, version);
          const staleNext: Record<string, true> = { ...next.staleApprovals };
          for (const a of res.approvals) delete staleNext[a.id];
          return {
            ...next,
            answerTokens: { ...next.answerTokens, ...(res.answerTokens ?? {}) },
            staleApprovals: staleNext,
          };
        });
        if (res.nextCursor == null) break;
        cursor = res.nextCursor;
      }
      // Decided history: the head page only.
      const version = st.version();
      const head = await st.call("approvals.list", {
        status: [...RESOLVED_STATUSES],
        limit: APPROVAL_PAGE,
      });
      st.update((s) => putMany(s, "approvals", head.approvals, version));
      return head.nextCursor ?? null;
    });
    // A reload keeps the cursor of pages already loaded beyond the head.
    if (!beyondHead.current) setRecentCursor(headCursor);
  });
  const loadMoreRecent = useCallback(async () => {
    if (recentCursor === null || loadingMoreRecent) return;
    setLoadingMoreRecent(true);
    try {
      const version = store.version();
      const res = await store.call("approvals.list", {
        status: [...RESOLVED_STATUSES],
        limit: APPROVAL_PAGE,
        cursor: recentCursor,
      });
      store.update((s) => putMany(s, "approvals", res.approvals, version));
      beyondHead.current = true;
      setRecentCursor(res.nextCursor ?? null);
    } finally {
      setLoadingMoreRecent(false);
    }
  }, [store, recentCursor, loadingMoreRecent]);
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
    /** More decided approvals exist beyond the ones loaded. */
    hasMoreRecent: recentCursor !== null,
    loadMoreRecent,
    loadingMoreRecent,
    answer: (
      id: string,
      decision: "approve" | "deny",
      scope?: GrantScope,
      extras?: ApprovalExtras,
    ) => answerApproval(store, id, decision, scope, extras),
  };
}

/** What an answer carries besides the decision: the folder the owner picked (`folder_access`). */
export interface ApprovalExtras {
  folderPath?: string;
  /** `folder_access`: read-only although the agent asked to change files. */
  folderMode?: "ro";
  /** `exec_host`: the owner typed UNSANDBOXED to run this one command without srt. */
  unsandboxed?: "UNSANDBOXED";
  /** `messages_send` card: the text left in the editor and the recipient picked. */
  editedText?: string;
  recipientChoice?: string;
  /** "Approve all routine ones": the Gateway refuses it on any card it did not class routine. */
  bulk?: true;
  /** "Always for this site" (with scope `once`) on a first-read card that offered it. */
  trustSite?: "origin" | "subdomains";
  /** "Always allow <program> in <folder>" on a host-command card (sent with scope `once`). */
  hostProgram?: true;
  /** "Allow in this Space" on a folder card that offers it (sent with scope `once`). */
  inSpace?: true;
}

export async function answerApproval(
  store: GatewayStore,
  approvalId: string,
  decision: "approve" | "deny",
  scope?: GrantScope,
  extras?: ApprovalExtras,
) {
  const token = store.getState().answerTokens[approvalId];
  if (token === undefined) {
    throw new Error(
      "This device has no answer token for that approval. Answer it where it was sent.",
    );
  }
  // Approving a card that requires authentication carries the host's presence assertion
  // (a passkey on the web); without a host verifier the Gateway decides whether one is needed.
  const approval = store.getState().approvals[approvalId];
  const commit = (s: ReturnType<GatewayStore["getState"]>, r: { approval: ApprovalRequest }) => {
    const { [approvalId]: _used, ...answerTokens } = s.answerTokens;
    return { ...put(s, "approvals", r.approval), answerTokens };
  };
  // The window's own presence: Touch ID through the helper (macOS, Windows) or the owner's
  // password in the system dialog (Linux). A host offers one of them.
  const byPassword = store.client.approveWithPassword !== undefined;
  const touchId = byPassword
    ? store.client.approveWithPassword?.bind(store.client)
    : store.client.approveWithTouchId?.bind(store.client);
  if (
    decision === "approve" &&
    approval?.requiresAuthentication &&
    touchId &&
    !store.client.presence
  ) {
    // Once, and never UNSANDBOXED: neither is in the challenge the helper signs (security §3.7).
    if (extras?.unsandboxed !== undefined) {
      throw new Error(
        byPassword
          ? t("blocks.approval.password.noUnsandboxed")
          : t("blocks.approval.touchId.noUnsandboxed"),
      );
    }
    return store.mutate({
      run: () => touchId({ approvalId, answerToken: token }),
      commit,
    });
  }
  const presence =
    decision === "approve" && approval?.requiresAuthentication && store.client.presence
      ? await store.client.presence(approval, token, scope)
      : undefined;
  return store.mutate({
    run: () =>
      store.call("approvals.answer", {
        approvalId,
        answerToken: token,
        decision,
        ...(decision === "approve" && scope !== undefined ? { scope } : {}),
        ...(decision === "approve" && extras?.folderPath !== undefined
          ? { folderPath: extras.folderPath }
          : {}),
        ...(decision === "approve" && extras?.folderMode !== undefined
          ? { folderMode: extras.folderMode }
          : {}),
        ...(decision === "approve" && extras?.unsandboxed !== undefined
          ? { unsandboxed: extras.unsandboxed }
          : {}),
        ...(decision === "approve" && extras?.editedText !== undefined
          ? { editedText: extras.editedText }
          : {}),
        ...(decision === "approve" && extras?.recipientChoice !== undefined
          ? { recipientChoice: extras.recipientChoice }
          : {}),
        ...(decision === "approve" && extras?.bulk === true ? { bulk: true as const } : {}),
        ...(decision === "approve" && extras?.trustSite !== undefined
          ? { trustSite: extras.trustSite }
          : {}),
        ...(decision === "approve" && extras?.inSpace === true ? { inSpace: true as const } : {}),
        ...(decision === "approve" && extras?.hostProgram === true
          ? { hostProgram: true as const }
          : {}),
        ...(presence === undefined ? {} : { presence }),
      }),
    commit,
  });
}

/**
 * The messages of one thread waiting in the outbox (a remote window while offline), oldest first,
 * and a way to take one back. Empty and inert where no outbox is configured.
 */
export function useOutbox(threadId: string | null): {
  waiting: readonly OutboxItem[];
  remove: (key: string) => void;
  /** "Send now" for a message that waited a day. */
  sendNow: (key: string) => void;
  enabled: boolean;
} {
  const store = useStore();
  const outbox = store.outbox;
  const read = useCallback(
    () => (outbox === undefined || threadId === null ? EMPTY_OUTBOX : outbox.items(threadId)),
    [outbox, threadId],
  );
  const [waiting, setWaiting] = useState<readonly OutboxItem[]>(read);
  useEffect(() => {
    setWaiting(read());
    return outbox?.subscribe(() => setWaiting(read()));
  }, [outbox, read]);
  const remove = useCallback((key: string) => void outbox?.remove(key), [outbox]);
  const sendNow = useCallback((key: string) => void store.confirmOutbox(key), [store]);
  return { waiting, remove, sendNow, enabled: outbox !== undefined };
}

const EMPTY_OUTBOX: readonly OutboxItem[] = [];

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
    answer: (decision: "approve" | "deny", scope?: GrantScope, extras?: ApprovalExtras) =>
      approvalId === null
        ? Promise.reject(new Error("no approval"))
        : answerApproval(store, approvalId, decision, scope, extras),
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

/**
 * Cursor state for a Gateway list the hooks page through (`nextCursor`). The cursor belongs to one
 * filter `key`: a cursor from another filter reads as "no more pages".
 */
function usePaging(key: string) {
  const [state, setState] = useState<{ key: string; cursor: string | null; loading: boolean }>({
    key,
    cursor: null,
    loading: false,
  });
  const current = state.key === key ? state : { key, cursor: null, loading: false };
  const set = useCallback(
    (cursor: string | null) =>
      setState((s) => ({ key, cursor, loading: s.key === key ? s.loading : false })),
    [key],
  );
  const setLoading = useCallback(
    (loading: boolean) => setState((s) => ({ ...s, key, loading })),
    [key],
  );
  return { cursor: current.cursor, loading: current.loading, set, setLoading };
}

/**
 * Loads the rest of a paged list one page after another, capped at `maxPages` (a picker or a
 * title lookup, not a full list). A failed page stops the chain: the list keeps what it has, and
 * the hook does not retry in a loop. Screens that show a list page it with a "Load older" button.
 */
export function useLoadRemaining(
  page: { hasMore: boolean; loadingMore: boolean; loadMore: () => Promise<void> },
  maxPages = 10,
): void {
  const failed = useRef(false);
  const pages = useRef(0);
  useEffect(() => {
    if (!page.hasMore || page.loadingMore || failed.current || pages.current >= maxPages) return;
    pages.current += 1;
    page.loadMore().catch(() => {
      failed.current = true;
    });
  });
}

export function useTasks(filter: { threadId?: string } = {}) {
  const store = useStore();
  const tasks = useStoreState((s) => s.tasks);
  const key = `tasks:${filter.threadId ?? "*"}`;
  const paging = usePaging(key);
  const load = useLoader(key, async (st) => {
    const version = st.version();
    const res = await st.call("tasks.list", {
      ...(filter.threadId === undefined ? {} : { threadId: filter.threadId }),
    });
    paging.set(res.nextCursor ?? null);
    st.update((s) => putMany(s, "tasks", res.tasks, version));
  });
  /** Fetches the page after the one held and merges it by id (the Gateway caps a page at 50). */
  const loadMore = async () => {
    if (paging.cursor === null || paging.loading) return;
    paging.setLoading(true);
    try {
      const version = store.version();
      const res = await store.call("tasks.list", {
        ...(filter.threadId === undefined ? {} : { threadId: filter.threadId }),
        cursor: paging.cursor,
      });
      paging.set(res.nextCursor ?? null);
      store.update((s) => putMany(s, "tasks", res.tasks, version));
    } finally {
      paging.setLoading(false);
    }
  };
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
  return {
    ...load,
    all,
    running,
    needsYou,
    /** More tasks after the loaded pages (`tasks.list` `nextCursor`). */
    hasMore: paging.cursor !== null,
    loadingMore: paging.loading,
    loadMore,
    ...taskActions(store),
  };
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

/**
 * A generative-UI widget snapshot by id (docs/design/generative-ui-2026.md §5.5). Loaded once with
 * `widgets.get`, kept current by `widget.updated`; a dropped snapshot (rev gap) loads again, and a
 * reconnect refreshes it through the loader.
 */
export function useWidget(widgetId: string | null): LoadState & { widget: Widget | null } {
  const widget = useStoreState((s) => (widgetId === null ? undefined : s.widgets[widgetId]));
  const missing = widgetId !== null && widget === undefined;
  const load = useLoader(missing ? `widget:${widgetId}` : null, async (st) => {
    if (widgetId === null) return;
    const version = st.version();
    const res = await st.call("widgets.get", { widgetIds: [widgetId] });
    st.update((s) => putMany(s, "widgets", res.widgets, version));
  });
  return { ...load, widget: widget ?? null };
}

/** Previews of the widgets the model is writing in this thread right now (P9). */
export function useWidgetDrafts(threadId: string | null): readonly WidgetDraftState[] {
  const all = useStoreState((s) => s.widgetDrafts);
  return Object.values(all).filter((d) => d.threadId === threadId);
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

/**
 * A canvas artifact's content at a version (the latest when `version` is null), loaded with
 * `artifacts.read` and kept by `id@version`: versions never change, so a load happens once.
 */
export function useArtifactContent(
  artifactId: string | null,
  version: number | null,
): LoadState & { content: ArtifactContent | null } {
  const { artifact } = useArtifact(artifactId);
  const v = version ?? artifact?.version ?? null;
  const key = artifactId === null || v === null ? null : `${artifactId}@${v}`;
  const content = useStoreState((s) => (key === null ? undefined : s.artifactContent[key]));
  const load = useLoader(
    key !== null && content === undefined ? `artifact-content:${key}` : null,
    async (st) => {
      if (artifactId === null || v === null) return;
      const res = await st.call("artifacts.read", { artifactId, version: v });
      st.update((s) => ({
        ...s,
        artifactContent: { ...s.artifactContent, [`${artifactId}@${res.version}`]: res },
      }));
    },
  );
  return { ...load, content: content ?? null };
}

/** Every version of an artifact for the version picker, oldest first. */
export function useArtifactVersions(
  artifactId: string | null,
): LoadState & { versions: readonly ArtifactVersion[] } {
  const versions = useStoreState((s) =>
    artifactId === null ? undefined : s.artifactVersions[artifactId],
  );
  const load = useLoader(
    artifactId !== null && versions === undefined ? `artifact-versions:${artifactId}` : null,
    async (st) => {
      if (artifactId === null) return;
      const res = await st.call("artifacts.versions", { artifactId });
      st.update((s) => ({
        ...s,
        artifactVersions: { ...s.artifactVersions, [artifactId]: res.versions },
      }));
    },
  );
  return { ...load, versions: versions ?? EMPTY_VERSIONS };
}

const EMPTY_VERSIONS: readonly ArtifactVersion[] = [];
const EMPTY_IDS: readonly string[] = [];

/** A thread's canvas artifacts, most recently updated first (the canvas recents). */
export function useThreadArtifacts(
  threadId: string | null,
): LoadState & { artifacts: readonly Artifact[] } {
  const ids = useStoreState((s) => (threadId === null ? undefined : s.threadArtifacts[threadId]));
  const all = useStoreState((s) => s.artifacts);
  const load = useLoader(
    threadId !== null && ids === undefined ? `thread-artifacts:${threadId}` : null,
    async (st) => {
      if (threadId === null) return;
      const res = await st.call("artifacts.list", { threadId, limit: 20 });
      st.update((s) => {
        let next = s;
        for (const a of res.artifacts) next = put(next, "artifacts", a);
        return {
          ...next,
          threadArtifacts: { ...next.threadArtifacts, [threadId]: res.artifacts.map((a) => a.id) },
        };
      });
    },
  );
  const artifacts = useMemo(
    () => (ids ?? EMPTY_IDS).map((id) => all[id]).filter((a): a is Artifact => a !== undefined),
    [ids, all],
  );
  return { ...load, artifacts };
}

/** Canvas writes: the user's edits and restores become new versions authored by `user`. */
export function useArtifactActions(): {
  update(
    artifactId: string,
    base: number,
    ops: ArtifactOp[],
  ): Promise<MethodResult<"artifacts.update">>;
  restore(artifactId: string, version: number): Promise<MethodResult<"artifacts.restore">>;
  /** Renders a doc, workbook or deck as a file (nothing is written to disk). */
  export(
    artifactId: string,
    format: string,
    version?: number,
  ): Promise<MethodResult<"artifacts.export">>;
} {
  const store = useStore();
  return useMemo(
    () => ({
      async update(artifactId, base, ops) {
        const res = await store.call("artifacts.update", { artifactId, base, ops });
        store.update((s) => put(s, "artifacts", res.artifact));
        return res;
      },
      async restore(artifactId, version) {
        const res = await store.call("artifacts.restore", { artifactId, version });
        store.update((s) => put(s, "artifacts", res.artifact));
        return res;
      },
      export: (artifactId, format, version) =>
        store.call("artifacts.export", {
          artifactId,
          format,
          ...(version === undefined ? {} : { version }),
        }),
    }),
    [store],
  );
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

/** Sandbox Mac guests from `vm.updated` (VM mode, L1–L5), most recently changed first. */
export function useVmGuests(): VmUpdatedPayload[] {
  const guests = useStoreState((s) => s.vmGuests);
  return useMemo(() => Object.values(guests).sort((a, b) => b.at.localeCompare(a.at)), [guests]);
}

export function useLibrary(filter: MethodParams<"library.list"> = {}) {
  const store = useStore();
  const items = useStoreState((s) => s.library);
  const key = JSON.stringify(filter);
  const paging = usePaging(`library:${key}`);
  const load = useLoader(`library:${key}`, async (st) => {
    const version = st.version();
    const res = await st.call("library.list", filter);
    const filtered =
      filter.threadId !== undefined ||
      filter.taskId !== undefined ||
      filter.query !== undefined ||
      filter.quarantined !== undefined ||
      filter.cursor !== undefined;
    // A head reload replaces the loaded window (rows the Gateway dropped go away) and resets the
    // cursor to the head's, so "Load older" starts again from the same place the window ends.
    paging.set(res.nextCursor ?? null);
    st.update((s) =>
      replaceLibraryWindow(
        s,
        res.items,
        {
          ...(filter.kind === undefined ? {} : { kind: filter.kind }),
          filtered,
          hasMore: res.nextCursor !== null && res.nextCursor !== undefined,
        },
        version,
      ),
    );
  });
  /** Fetches the page after the one held and merges it by id (the Gateway caps a page at 200). */
  const loadMore = async () => {
    if (paging.cursor === null || paging.loading) return;
    paging.setLoading(true);
    try {
      const version = store.version();
      const res = await store.call("library.list", { ...filter, cursor: paging.cursor });
      paging.set(res.nextCursor ?? null);
      store.update((s) => putMany(s, "library", res.items, version));
    } finally {
      paging.setLoading(false);
    }
  };
  const list = useMemo(
    () =>
      Object.values(items)
        .filter((i) => filter.kind === undefined || i.kind === filter.kind)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [items, filter.kind],
  );
  return {
    ...load,
    items: list,
    /** More Library items after the loaded pages (`library.list` `nextCursor`). */
    hasMore: paging.cursor !== null,
    loadingMore: paging.loading,
    loadMore,
  };
}

// --- Proactive surfaces -----------------------------------------------------------------------

export function useFeed() {
  const store = useStore();
  const feed = useStoreState((s) => s.feed);
  const nextBriefAt = useStoreState((s) => s.nextBriefAt);
  const paging = usePaging("feed");
  const load = useLoader("feed", async (st) => {
    const version = st.version();
    const res = await st.call("feed.list", {});
    paging.set(res.nextCursor ?? null);
    st.update((s) => ({
      ...putMany(s, "feed", res.posts, version),
      nextBriefAt: res.nextBriefAt ?? null,
    }));
  });
  /** The next page of posts (`feed.list` `nextCursor`), merged by id; the brief time is kept. */
  const loadMore = async () => {
    if (paging.cursor === null || paging.loading) return;
    paging.setLoading(true);
    try {
      const version = store.version();
      const res = await store.call("feed.list", { cursor: paging.cursor });
      paging.set(res.nextCursor ?? null);
      store.update((s) => putMany(s, "feed", res.posts, version));
    } finally {
      paging.setLoading(false);
    }
  };
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
    /** More posts after the loaded pages; `loadMore` fetches the next one. */
    hasMore: paging.cursor !== null,
    loadingMore: paging.loading,
    loadMore,
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
    /** A stated goal, active at once (`goals.create`). */
    create: (title: string, category: Goal["category"]) =>
      store
        .mutate({
          run: () => store.call("goals.create", { title, category }),
          commit: (s, r) => put(s, "goals", r.goal),
        })
        .then((r) => r.goal),
  };
}

export function useGoal(goalId: string | null): LoadState & {
  goal: Goal | null;
  taskIds: string[];
  milestones: GoalMilestone[] | null;
  /** The goal's links (tasks, automations, watches), as `goals.get` returns them. */
  links: GoalLink[];
} {
  const goal = useStoreState((s) => (goalId === null ? undefined : s.goals[goalId]));
  // Keyed by goal id, so a slow response for the previous goal never shows under this one.
  const [detail, setDetail] = useState<{
    goalId: string;
    taskIds: string[];
    milestones: GoalMilestone[] | null;
    links: GoalLink[];
  } | null>(null);
  const load = useLoader(goalId === null ? null : `goal:${goalId}`, async (st) => {
    if (goalId === null) return;
    const res = await st.call("goals.get", { goalId });
    st.update((s) => put(s, "goals", res.goal));
    setDetail({
      goalId,
      taskIds: res.taskIds,
      milestones: res.milestones ?? null,
      links: res.links ?? [],
    });
  });
  const current = detail?.goalId === goalId ? detail : null;
  return {
    ...load,
    goal: goal ?? null,
    taskIds: current?.taskIds ?? [],
    milestones: current?.milestones ?? null,
    links: current?.links ?? [],
  };
}

// --- Inbox, settings, automations, search, memory ---------------------------------------------

const NOTIFICATION_PAGE = 50;

type NotificationListParams = { unreadOnly?: boolean; unresolvedOnly?: boolean };

/** Pages one filtered `notifications.list` to the end, handing each page to `each`. */
async function eachNotificationPage(
  st: GatewayStore,
  filter: NotificationListParams,
  each: (page: Notification[], version: number) => void,
): Promise<void> {
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const version = st.version();
    const res = await st.call("notifications.list", {
      ...filter,
      limit: 500,
      ...(cursor === undefined ? {} : { cursor }),
    });
    each(res.notifications as Notification[], version);
    if (res.nextCursor == null) return;
    cursor = res.nextCursor;
  }
}

export function useNotifications() {
  const store = useStore();
  const notifications = useStoreState((s) => s.notifications);
  // Cursor for the next page of the inbox list; null once it is complete.
  const [cursor, setCursor] = useState<string | null>(null);
  const beyondHead = useRef(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const load = useLoader("notifications", async (st) => {
    const headCursor = await sharedLoad(st, "notifications", async () => {
      const merge = (page: Notification[], version: number) =>
        st.update((s) => putMany(s, "notifications", page, version));
      // Everything unresolved or unread loads in full, so the Needs-you and unread counts are
      // right however old the notification is. Both sets are bounded by what the owner left open.
      await eachNotificationPage(st, { unresolvedOnly: true }, merge);
      await eachNotificationPage(st, { unreadOnly: true }, merge);
      // The inbox list itself pages: the head here, older ones on `loadMore`.
      const version = st.version();
      const head = await st.call("notifications.list", { limit: NOTIFICATION_PAGE });
      merge(head.notifications as Notification[], version);
      return head.nextCursor ?? null;
    });
    if (!beyondHead.current) setCursor(headCursor);
  });
  const loadMore = useCallback(async () => {
    if (cursor === null || loadingMore) return;
    setLoadingMore(true);
    try {
      const version = store.version();
      const res = await store.call("notifications.list", { limit: NOTIFICATION_PAGE, cursor });
      store.update((s) =>
        putMany(s, "notifications", res.notifications as Notification[], version),
      );
      beyondHead.current = true;
      setCursor(res.nextCursor ?? null);
    } finally {
      setLoadingMore(false);
    }
  }, [store, cursor, loadingMore]);
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
  /**
   * Marks every unread notification read, including the ones this client never loaded: the
   * Gateway has no mark-all method, so it pages the unread ids and marks them 500 at a time.
   */
  const markAllRead = async () => {
    // An id can vanish between listing and marking (the Gateway refuses the whole batch for an
    // unknown id): list again and carry on with what is still there.
    for (let attempt = 0; ; attempt++) {
      const ids: string[] = [];
      await eachNotificationPage(store, { unreadOnly: true }, (page) => {
        for (const n of page) ids.push(n.id);
      });
      try {
        for (let i = 0; i < ids.length; i += 500) {
          const batch = ids.slice(i, i + 500);
          await store.mutate({
            optimistic: mark(batch, new Date().toISOString()),
            run: () => store.call("notifications.markRead", { notificationIds: batch }),
            commit: (s) => mark(batch, new Date().toISOString())(s),
          });
        }
        return;
      } catch (err) {
        if (codeOf(err) !== "not_found" || attempt >= 3) throw err;
      }
    }
  };
  return {
    ...load,
    all,
    /** More (older) notifications exist beyond the ones listed. */
    hasMore: cursor !== null,
    loadMore,
    loadingMore,
    markAllRead,
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
    /**
     * `approvalId`: the retry after a security setting's `approval_required` (security §10;
     * the optional `settings.set.approvalId` param arrives with S05's devmello/psyche#178).
     */
    set: (key: string, value: unknown, approvalId?: string) =>
      store.mutate({
        optimistic: (s) => ({ ...s, settings: { ...s.settings, [key]: value } }),
        run: () =>
          store.call("settings.set", {
            key,
            value,
            ...(approvalId === undefined ? {} : { approvalId }),
          }),
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

export function useSearch(
  query: string,
  scopes?: SearchScope[],
  dropChips?: string[],
  from?: string,
) {
  const trimmed = query.trim();
  // A sender filter alone (`from:alice`) is a search too, with a blank text.
  const active = trimmed !== "" || from !== undefined;
  const q = useGatewayQuery(
    "search.query",
    {
      query: trimmed === "" ? " " : trimmed,
      ...(scopes === undefined ? {} : { scopes }),
      ...(dropChips === undefined || dropChips.length === 0 ? {} : { dropChips }),
      ...(from === undefined ? {} : { from }),
    },
    { enabled: active },
  );
  const hits: readonly SearchHit[] = !active ? [] : (q.data?.hits ?? []);
  const groups = useMemo(() => {
    const out = new Map<SearchScope, SearchHit[]>();
    for (const h of hits) out.set(h.scope, [...(out.get(h.scope) ?? []), h]);
    return out;
  }, [hits]);
  const understood = !active ? undefined : q.data?.understood;
  return { ...q, hits, groups, understood };
}

/** Index size and backfill progress, live through `search.status.updated`; `reindex` rebuilds. */
export function useSearchIndexStatus() {
  const store = useStore();
  const q = useGatewayQuery("search.status", {});
  const [requested, setRequested] = useState(false);
  return {
    ...q,
    status: q.data,
    reindexing: requested || q.data?.backfill.state === "running",
    reindex: async () => {
      setRequested(true);
      try {
        await store.call("search.reindex", {});
        q.reload();
      } finally {
        setRequested(false);
      }
    },
  };
}

/**
 * Which speech engine dictation uses and, on Windows, the on-device whisper.cpp setup; live
 * through `speech.model_download`. `download` is the owner's one click (`speech.engine.download`).
 */
export function useSpeechEngine() {
  const store = useStore();
  const q = useGatewayQuery("speech.engine.status", {});
  const [requested, setRequested] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return {
    ...q,
    status: q.data,
    downloading: requested || q.data?.whisper?.state === "downloading",
    downloadError: error,
    download: async () => {
      setRequested(true);
      setError(null);
      try {
        await store.call("speech.engine.download", {});
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setRequested(false);
        q.reload();
      }
    },
  };
}

/** Local search sources (Settings → Search sources): live status, switches, exclusions, Rebuild. */
export function useSearchSources() {
  const store = useStore();
  const q = useGatewayQuery("search.sources", {});
  const apply = (res: MethodResult<"search.sources">) => {
    store.update((s) => ({
      ...s,
      queries: {
        ...s.queries,
        [`search.sources:${JSON.stringify({})}`]: {
          data: res,
          error: null,
          loading: false,
          version: store.version(),
        },
      },
    }));
    return res;
  };
  return {
    ...q,
    status: q.data,
    configure: async (p: MethodParams<"search.sources.configure">) =>
      apply(await store.call("search.sources.configure", p)),
    /** Resolves with the status right after it started (the source indexing from zero); rejects with why it was refused. */
    rebuild: async (source: MethodParams<"search.sources.rebuild">["source"]) =>
      apply(await store.call("search.sources.rebuild", { source })),
  };
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

/** What a message is about: the ref the Gateway resolves, and the card shown before it answers. */
export interface SendContext {
  ref: ChatContextRef;
  block: Extract<Block, { type: "context" }>;
}

/** A user message the Gateway has not echoed yet; skipped once the real one is in the store. */
function withPendingUserMessage(
  s: UiState,
  threadId: string,
  id: string,
  content: string,
  createdAt: string,
  baseSeq: number,
  context?: Extract<Block, { type: "context" }>,
): UiState {
  const list = s.messages[threadId] ?? EMPTY;
  const echoed = list.some(
    (m) =>
      m.role === "user" &&
      m.seq > baseSeq &&
      m.blocks.some((b) => b.type === "text" && b.md === content),
  );
  if (echoed) return s;
  const pending: Message = {
    id,
    threadId,
    seq: Math.max(baseSeq, list[list.length - 1]?.seq ?? -1) + 1,
    role: "user",
    blocks: [...(context ? [context] : []), { type: "text", md: content }],
    providerNative: null,
    provenance: "owner",
    replyToMessageId: null,
    channelRef: null,
    runId: null,
    createdAt,
  };
  return { ...s, messages: { ...s.messages, [threadId]: [...list, pending] } };
}
