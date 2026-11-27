import {
  AGENT_NOTES_DIR,
  type AutomationRun,
  applyWidgetOps,
  type MethodName,
  type MethodParams,
  type MethodResult,
  PsycheError,
  requiresIdempotencyKey,
  type ThreadListEntry,
} from "@psyche/protocol";
import { modelBudgetMinutes, modelBudgetRetryMs } from "../i18n/errors.ts";
import {
  type ConnectionState,
  type GatewayClient,
  type GatewayEvent,
  GatewayRequestError,
  newIdempotencyKey,
} from "./client.ts";
import type { ChatOutbox, OutboxItem } from "./outbox.ts";
import { RequestGate, retryAfterSecOf } from "./request-gate.ts";
import {
  appendBlock,
  dropSettledStreaming,
  INITIAL_STATE,
  isOwnedTouched,
  isUnsettled,
  ownTouched,
  pruneTouched,
  put,
  putMany,
  type QueuedFollowUp,
  runsOfThread,
  touch,
  type UiState,
  upsertMessage,
  upsertRunSteps,
  withThreadCleared,
  withThreadEvicted,
} from "./state.ts";

/** Events between two maintenance sweeps (guard pruning and eviction of closed threads). */
const MAINTAIN_EVERY_EVENTS = 128;
/** Closed threads whose data stays loaded: the most recently used ones. */
export const KEEP_RECENT_THREADS = 5;
/** How long a `version()` read protects the guard before its request registers (a safety net). */
const VERSION_LEASE_MS = 10_000;

type Overlay = { id: number; apply: (s: UiState) => UiState };
type Refresher = () => Promise<void>;

/**
 * Normalized client state fed by Gateway events (architecture §4.2 step 5; data model §11).
 *
 * - Events reduce into `UiState`; structured blocks are inserted whole.
 * - `seq` gaps and reconnects trigger a refresh of every loaded collection; list results never
 *   overwrite an entity that an event touched after the list was requested.
 * - Mutations may carry an optimistic overlay, removed when the request settles (the server's
 *   answer or the events it caused replace it; a failure rolls it back).
 */
const scheduleFrame = (cb: () => void): number =>
  typeof requestAnimationFrame === "function"
    ? requestAnimationFrame(() => cb())
    : (setTimeout(cb, 16) as unknown as number);
const cancelFrame = (id: number): void =>
  typeof cancelAnimationFrame === "function" ? cancelAnimationFrame(id) : clearTimeout(id);

/**
 * A seq gap refreshes every loader, but at most one refresh runs at a time, one more waits behind
 * it, and a refresh never starts sooner than `GAP_REFRESH_MIN_MS` after the last one began.
 */
const GAP_REFRESH_DEBOUNCE_MS = 250;
const GAP_REFRESH_MIN_MS = 2_000;

/** A read is sent at most this many times while the device keeps answering `rate_limited`. */
const MAX_RATE_LIMIT_ATTEMPTS = 3;

function toRequestError(method: string, err: unknown): GatewayRequestError {
  if (err instanceof GatewayRequestError) return err;
  if (err instanceof PsycheError)
    return new GatewayRequestError(method, err.code, err.message, err.details);
  const message = err instanceof Error ? err.message : String(err);
  return new GatewayRequestError(method, "internal", message);
}

export class GatewayStore {
  readonly client: GatewayClient;
  /**
   * A store with no Gateway behind it, used when a kit component renders outside a
   * `<GatewayProvider>` (stories, tests, previews): loaders stay idle and calls reject.
   */
  readonly detached: boolean;
  /**
   * Messages typed while the connection is down wait here and go out on reconnect (remote
   * windows; remote-gateway design §4.5). Absent elsewhere, where the composer is simply off.
   */
  readonly outbox: ChatOutbox | undefined;
  private base: UiState;
  private overlays: Overlay[] = [];
  private snapshot: UiState;
  private listeners = new Set<() => void>();
  private refreshers = new Map<string, Set<Refresher>>();
  private refreshing = 0;
  /** True once the connection has been open; any later transition to open is a reconnect. */
  private hasOpened: boolean;
  /** True until the connection first leaves "connecting" (the first handshake is in flight). */
  private settled: boolean;
  private settleListeners = new Set<() => void>();
  /** Queued follow-up ids being sent right now (single owner per item). */
  private sending = new Set<string>();
  private nextOverlayId = 1;
  private unsubscribe: Array<() => void> = [];
  private insightsTimer: ReturnType<typeof setTimeout> | undefined;
  private mapTimer: ReturnType<typeof setTimeout> | undefined;
  private gapTimer: ReturnType<typeof setTimeout> | undefined;
  private gapRunning = false;
  private gapQueued = false;
  private gapLastStart = Number.NEGATIVE_INFINITY;
  private readonly now: () => string;
  /** Holds non-urgent reads while the device is rate limited; shared by every loader. */
  private readonly gate = new RequestGate();
  /**
   * Runs an event changed (`run.step`, `run.updated`) or that a gap may have hid, since their trace
   * was last loaded. A settled run is re-read on refresh only when it is in this set.
   */
  private readonly changedRuns = new Set<string>();
  /** Start versions of the requests in flight (see `pruneTouched` for why only the minimum matters). */
  private readonly inflight = new Map<number, number>();
  private nextRequestId = 1;
  /** `version()` reads that no request has registered for yet: `[version, expiry in ms]`. */
  private leases: Array<[number, number]> = [];
  /** Threads open in a view right now, with how many views. Never evicted. */
  private readonly retained = new Map<string, number>();
  /** When each thread was last opened or got an event, for the recent-threads cache. */
  private readonly lastUsed = new Map<string, number>();
  private useClock = 0;
  /** Runs whose trace a view shows right now, with how many views. Their steps are never evicted. */
  private readonly retainedRuns = new Map<string, number>();
  private eventsSinceMaintain = 0;
  /** The outbox's retry after a send gave up on `rate_limited` (one at a time; see `scheduleOutboxRetry`). */
  private outboxRetryTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    client: GatewayClient,
    options: { now?: () => string; detached?: boolean; outbox?: ChatOutbox } = {},
  ) {
    this.client = client;
    this.detached = options.detached ?? false;
    this.outbox = options.outbox;
    this.now = options.now ?? (() => new Date().toISOString());
    this.base = {
      ...INITIAL_STATE,
      touched: ownTouched({}),
      connection: client.connectionState(),
    };
    this.hasOpened = this.base.connection === "open";
    this.settled = this.base.connection !== "connecting";
    this.snapshot = this.base;
  }

  private starts = 0;

  /** Starts listening to the client. Reference-counted: each `start()` needs one `stop()`. */
  start(): void {
    this.starts += 1;
    if (this.unsubscribe.length > 0) return;
    this.unsubscribe.push(this.client.subscribe((e) => this.onEvent(e)));
    this.unsubscribe.push(this.client.onConnectionState((s) => this.onConnection(s)));
    // Messages left from an earlier session go out as soon as there is a connection (and, in a
    // remote window, once the outbox knows whose they are).
    if (this.outbox !== undefined) {
      this.unsubscribe.push(
        this.outbox.subscribe(() => {
          if (this.client.connectionState() === "open") void this.flushOutbox();
        }),
      );
    }
    if (this.client.connectionState() === "open") void this.flushOutbox();
  }

  /** True when an event (or a gap) says this run changed since its trace was last loaded. */
  runChanged(runId: string): boolean {
    return this.changedRuns.has(runId);
  }

  /** Called as a run's trace is loaded: events from now on count as changes again. */
  markRunLoaded(runId: string): void {
    this.changedRuns.delete(runId);
  }

  /** The owner's "Send now" for a message that waited a day: confirms it, then sends. */
  async confirmOutbox(key: string): Promise<void> {
    this.outbox?.confirm(key);
    await this.flushOutbox();
  }

  /**
   * Sends what the outbox holds, each under the key it was queued with. A message the Gateway
   * refuses for good comes back as a "not sent" follow-up, with Retry and Remove, rather than
   * vanishing.
   */
  async flushOutbox(): Promise<void> {
    const outbox = this.outbox;
    if (outbox === undefined) return;
    const result = await outbox.flush((item) => this.sendOutboxItem(item));
    if (result.dropped.length === 0) return;
    this.update((s) => ({
      ...s,
      queue: [
        ...result.dropped.map(
          ({ item }): QueuedFollowUp => ({
            id: `outbox-failed-${item.key}`,
            threadId: item.params.threadId,
            content: item.params.content,
            mode: "followUp",
            replyToMessageId: item.params.replyToMessageId ?? null,
            failed: true,
          }),
        ),
        ...s.queue,
      ],
    }));
  }

  /**
   * One attempt series for a queued send. Every attempt carries the key the message was queued
   * under, so the Gateway replays rather than re-runs it. A `rate_limited` reply waits out the
   * shared gate pause and tries again, a few times at most; any other answer goes back to the
   * outbox unchanged for it to classify.
   */
  private async sendOutboxItem(item: OutboxItem): Promise<unknown> {
    const method = "chat.send";
    const params = item.params as MethodParams<"chat.send">;
    for (let attempt = 1; ; attempt += 1) {
      await this.gate.admit(method);
      try {
        return await this.client.request(method, params, { idempotencyKey: item.key });
      } catch (err) {
        const code = (err as { code?: unknown } | null)?.code;
        if (code !== "rate_limited") throw err;
        // The model budget is this device's, not the shared request budget: it pauses nothing
        // else and the send is not retried in a loop. The message stays queued for the next flush.
        const budgetMs = modelBudgetRetryMs(err);
        if (budgetMs !== null) {
          this.scheduleOutboxRetry(Date.now() + budgetMs);
          throw err;
        }
        const until = this.gate.pause(retryAfterSecOf((err as { details?: unknown }).details));
        if (attempt >= MAX_RATE_LIMIT_ATTEMPTS) {
          // Still limited after a few tries: the message stays queued, and goes again once the pause is over.
          this.scheduleOutboxRetry(until);
          throw err;
        }
        await this.gate.waitUntil(until);
      }
    }
  }

  /** One timer for the outbox's own retry after it gave up on a limited send; a later one replaces it. */
  private scheduleOutboxRetry(at: number): void {
    clearTimeout(this.outboxRetryTimer);
    this.outboxRetryTimer = setTimeout(
      () => {
        this.outboxRetryTimer = undefined;
        if (this.client.connectionState() === "open") void this.flushOutbox();
      },
      Math.max(0, at - Date.now()),
    );
  }

  stop(): void {
    this.starts = Math.max(0, this.starts - 1);
    if (this.starts > 0) return;
    for (const u of this.unsubscribe) u();
    this.unsubscribe = [];
    clearTimeout(this.insightsTimer);
    this.insightsTimer = undefined;
    clearTimeout(this.mapTimer);
    this.mapTimer = undefined;
    clearTimeout(this.gapTimer);
    this.gapTimer = undefined;
    this.gapQueued = false;
    clearTimeout(this.outboxRetryTimer);
    this.outboxRetryTimer = undefined;
  }

  // --- Subscription (useSyncExternalStore) -----------------------------------------------------

  getState = (): UiState => this.snapshot;

  subscribeStore = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Applies a change to the base state and recomputes the visible snapshot. */
  update(fn: (s: UiState) => UiState): void {
    this.base = this.adopt(fn(this.base));
    this.recompute();
  }

  /** A caller that swapped in its own `touched` object hands it over: the store copies it once and owns that. */
  private adopt(s: UiState): UiState {
    return isOwnedTouched(s.touched) ? s : { ...s, touched: ownTouched({ ...s.touched }) };
  }

  private recompute(): void {
    this.snapshot = this.overlays.reduce((s, o) => o.apply(s), this.base);
    this.cancelPendingNotify();
    for (const l of this.listeners) l();
  }

  private notifyFrame: number | undefined;

  private cancelPendingNotify(): void {
    if (this.notifyFrame === undefined) return;
    cancelFrame(this.notifyFrame);
    this.notifyFrame = undefined;
  }

  /**
   * Streaming deltas can arrive hundreds of times a second. The state still folds each one in at
   * once (so reads are never stale), but subscribers are told at most once per animation frame, so
   * React renders once per frame however bursty the stream is. Any other update notifies at once
   * and takes the pending notification with it.
   */
  private updateCoalesced(fn: (s: UiState) => UiState): void {
    this.base = this.adopt(fn(this.base));
    this.snapshot = this.overlays.reduce((s, o) => o.apply(s), this.base);
    if (this.notifyFrame !== undefined) return;
    this.notifyFrame = scheduleFrame(() => {
      this.notifyFrame = undefined;
      for (const l of this.listeners) l();
    });
  }

  // --- Requests --------------------------------------------------------------------------------

  /**
   * Sends a request, adding an idempotency key when the method needs one. The device's request
   * budget is shared by every loader, so this is the one place that honours a `rate_limited`
   * reply: non-urgent reads wait out `retryAfterSec` (see `request-gate.ts`), and a read that was
   * limited is retried after that wait, a few times at most. A side effect is never sent twice.
   */
  async call<M extends MethodName>(
    method: M,
    params: MethodParams<M>,
    callOptions: { timeoutMs?: number } = {},
  ): Promise<MethodResult<M>> {
    const sideEffecting = requiresIdempotencyKey(method);
    const options = {
      ...(sideEffecting ? { idempotencyKey: newIdempotencyKey() } : {}),
      ...(callOptions.timeoutMs === undefined ? {} : { timeoutMs: callOptions.timeoutMs }),
    };
    // The request counts as in flight from here (even while the gate holds it): a response that
    // comes back must still lose against any event newer than this version.
    const requestId = this.nextRequestId++;
    this.inflight.set(requestId, this.base.stateVersion);
    try {
      for (let attempt = 1; ; attempt += 1) {
        await this.gate.admit(method);
        try {
          return await this.client.request(method, params, options);
        } catch (err) {
          const error = toRequestError(method, err);
          if (error.code !== "rate_limited") throw error;
          // A spent model budget is answered to the caller; it does not hold every other request.
          if (modelBudgetMinutes(error) !== null) throw error;
          const until = this.gate.pause(retryAfterSecOf(error.details));
          if (sideEffecting || attempt >= MAX_RATE_LIMIT_ATTEMPTS) throw error;
          await this.gate.waitUntil(until);
        }
      }
    } finally {
      this.inflight.delete(requestId);
    }
  }

  /**
   * Runs a mutation with an optional optimistic overlay. `commit` folds the result into the base
   * state before the overlay is dropped, so the UI never flickers back.
   */
  async mutate<T>(opts: {
    optimistic?: (s: UiState) => UiState;
    run: () => Promise<T>;
    commit?: (s: UiState, result: T) => UiState;
  }): Promise<T> {
    const overlay: Overlay | null =
      opts.optimistic === undefined ? null : { id: this.nextOverlayId++, apply: opts.optimistic };
    if (overlay !== null) {
      this.overlays.push(overlay);
      this.recompute();
    }
    const drop = () => {
      if (overlay !== null) this.overlays = this.overlays.filter((o) => o.id !== overlay.id);
    };
    try {
      const result = await opts.run();
      const commit = opts.commit;
      if (commit !== undefined) this.base = this.adopt(commit(this.base, result));
      drop();
      this.recompute();
      return result;
    } catch (err) {
      drop();
      this.recompute();
      throw err;
    }
  }

  /** The stateVersion a list request starts at; pass it to `putMany`. */
  version(): number {
    const v = this.base.stateVersion;
    // The caller's request starts a moment later: hold the guard at `v` until it has registered.
    this.leases.push([v, Date.now() + VERSION_LEASE_MS]);
    return v;
  }

  /**
   * The lowest stateVersion a pending request may have been issued at, or Infinity when none is.
   * `touched` entries at or below it can never block a response (see `touch` in state.ts).
   */
  private watermark(): number {
    const now = Date.now();
    this.leases = this.leases.filter(([, until]) => until > now);
    let low = Number.POSITIVE_INFINITY;
    for (const v of this.inflight.values()) low = Math.min(low, v);
    for (const [v] of this.leases) low = Math.min(low, v);
    return low;
  }

  // --- Bounded memory: guard pruning and closed threads -------------------------------------------

  /**
   * Marks a thread as open in a view: its data is never evicted until the returned release runs.
   * A view that opens an evicted thread loads it again (`useThread`).
   */
  retainThread(threadId: string): () => void {
    this.retained.set(threadId, (this.retained.get(threadId) ?? 0) + 1);
    this.lastUsed.set(threadId, ++this.useClock);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const n = (this.retained.get(threadId) ?? 1) - 1;
      if (n <= 0) this.retained.delete(threadId);
      else this.retained.set(threadId, n);
      this.lastUsed.set(threadId, ++this.useClock);
      this.maintain();
    };
  }

  /** Marks a run's trace as on screen: its steps and frames stay loaded until the release runs. */
  retainRun(runId: string): () => void {
    this.retainedRuns.set(runId, (this.retainedRuns.get(runId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const n = (this.retainedRuns.get(runId) ?? 1) - 1;
      if (n <= 0) this.retainedRuns.delete(runId);
      else this.retainedRuns.set(runId, n);
    };
  }

  /** Counts for tests and diagnostics: how much the store holds on to. */
  memoryStats(): { touched: number; recentThreads: number; changedRuns: number } {
    return {
      touched: Object.keys(this.base.touched).length,
      recentThreads: this.lastUsed.size,
      changedRuns: this.changedRuns.size,
    };
  }

  /** Drops guard entries no pending request can need, then evicts closed threads. */
  maintain(): void {
    this.eventsSinceMaintain = 0;
    pruneTouched(this.base.touched, this.watermark());
    this.evictClosedThreads();
  }

  private evictClosedThreads(): void {
    const s = this.base;
    // Threads that hold transcript or trace data (run rows alone are kept and need no sweep).
    const candidates = new Set<string>(Object.keys(s.messages));
    const traced = new Set([
      ...Object.keys(s.runSteps),
      ...Object.keys(s.runFrames),
      ...Object.keys(s.runStepDetails).map((k) => k.split("/")[0] ?? k),
    ]);
    for (const r of Object.values(s.runs)) if (traced.has(r.id)) candidates.add(r.threadId);
    if (candidates.size === 0) return;
    // Recent first: the last few used threads stay loaded, open or not.
    const recent = new Set(
      [...this.lastUsed.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, KEEP_RECENT_THREADS)
        .map(([id]) => id),
    );
    const streaming = new Set(Object.values(s.streaming).map((m) => m.threadId));
    const queued = new Set(s.queue.map((q) => q.threadId));
    const drop: string[] = [];
    for (const id of candidates) {
      if (this.retained.has(id) || recent.has(id) || streaming.has(id) || queued.has(id)) continue;
      if ((s.threads[id]?.thread.activeWriterRunId ?? null) !== null) continue;
      if (runsOfThread(s.runs, id).some(isUnsettled)) continue;
      drop.push(id);
    }
    // Forget bookkeeping of threads that fell out of the cache.
    for (const id of this.lastUsed.keys()) {
      if (!recent.has(id) && !this.retained.has(id)) this.lastUsed.delete(id);
    }
    if (drop.length === 0) return;
    const keepRun = (id: string) => this.retainedRuns.has(id);
    const before = this.base;
    this.base = drop.reduce((st, id) => withThreadEvicted(st, id, keepRun), this.base);
    // A run whose steps are gone has nothing to refresh: forget its "changed" mark.
    for (const id of [...this.changedRuns]) {
      if (this.base.runSteps[id] === undefined) this.changedRuns.delete(id);
    }
    if (this.base !== before) this.recompute();
  }

  private noteThreadUse(e: GatewayEvent): void {
    const p = e.payload as {
      threadId?: unknown;
      message?: { threadId?: unknown };
      run?: { threadId?: unknown };
    };
    const id = p.threadId ?? p.message?.threadId ?? p.run?.threadId;
    if (typeof id === "string") this.lastUsed.set(id, ++this.useClock);
  }

  // --- Follow-up queue ---------------------------------------------------------------------------

  /**
   * Takes the next sendable follow-up for a thread, once: several components may watch the same
   * thread, and only the first caller gets the item. Failed items stay put until retried.
   */
  takeQueued(threadId: string): QueuedFollowUp | null {
    // Items parked by Stop are skipped: they wait for the owner.
    const next = this.base.queue.find((q) => q.threadId === threadId && q.parked !== true);
    if (next === undefined || next.failed === true || this.sending.has(next.id)) return null;
    this.sending.add(next.id);
    this.update((s) => ({ ...s, queue: s.queue.filter((q) => q.id !== next.id) }));
    return next;
  }

  /** Puts a follow-up that failed to send back at the head of the queue, marked failed. */
  failQueued(item: QueuedFollowUp): void {
    this.sending.delete(item.id);
    this.update((s) => ({ ...s, queue: [{ ...item, failed: true }, ...s.queue] }));
  }

  sentQueued(item: QueuedFollowUp): void {
    this.sending.delete(item.id);
  }

  /** Stop: what waits in this thread's queue is held until the owner sends or removes it. */
  parkQueued(threadId: string): void {
    this.update((s) =>
      s.queue.some((q) => q.threadId === threadId && q.parked !== true)
        ? {
            ...s,
            queue: s.queue.map((q) => (q.threadId === threadId ? { ...q, parked: true } : q)),
          }
        : s,
    );
  }

  /** Lets held follow-ups go: one item (its "Send queued" button) or the whole thread's queue. */
  resumeQueued(threadId: string, id?: string): void {
    this.update((s) =>
      s.queue.some((q) => q.threadId === threadId && q.parked === true)
        ? {
            ...s,
            queue: s.queue.map((q) =>
              q.threadId === threadId && q.parked === true && (id === undefined || q.id === id)
                ? { ...q, parked: false }
                : q,
            ),
          }
        : s,
    );
  }

  /** Clears the failed mark so the queue drains again. */
  retryQueued(id: string): void {
    this.update((s) => ({
      ...s,
      queue: s.queue.map((q) => (q.id === id ? { ...q, failed: false } : q)),
    }));
  }

  // --- Refresh ---------------------------------------------------------------------------------

  /** Registers a loader to rerun after a gap or reconnect. Returns an unregister function. */
  registerRefresher(key: string, refresh: Refresher): () => void {
    // Several mounted components may share a key; each keeps its own registration.
    let set = this.refreshers.get(key);
    if (set === undefined) {
      set = new Set();
      this.refreshers.set(key, set);
    }
    set.add(refresh);
    return () => {
      const current = this.refreshers.get(key);
      current?.delete(refresh);
      if (current?.size === 0) this.refreshers.delete(key);
    };
  }

  /** Reruns every registered loader (event gap, reconnect, or an explicit retry). */
  async refreshAll(): Promise<void> {
    this.refreshing += 1;
    this.update((s) => ({ ...s, refreshing: true }));
    // One run per key is enough: registrations under a key load the same data.
    const once = [...this.refreshers.values()].flatMap((set) => [...set].slice(0, 1));
    const results = await Promise.allSettled(once.map((r) => r()));
    this.refreshing -= 1;
    if (this.refreshing === 0) this.update((s) => ({ ...s, refreshing: false }));
    const failed = results.find((r) => r.status === "rejected");
    if (failed !== undefined) throw (failed as PromiseRejectedResult).reason;
  }

  /**
   * The first handshake is still in flight (#592): a request now would fail with "can't reach the
   * Gateway" although pairing completes moments later. Loaders hold their loading state and run
   * once the connection first settles (`open`, or `offline` when the Gateway really is down).
   */
  get awaitingConnection(): boolean {
    return !this.settled;
  }

  /** Calls `listener` once when the connection first settles. Returns an unsubscribe function. */
  onSettled(listener: () => void): () => void {
    this.settleListeners.add(listener);
    return () => this.settleListeners.delete(listener);
  }

  private onConnection(state: ConnectionState): void {
    this.update((s) => ({ ...s, connection: state }));
    if (state === "offline") {
      // Stream deltas stop; the committed message replaces them after the refresh.
      this.update((s) => ({ ...s, lastSeq: null }));
    }
    if (state !== "connecting" && !this.settled) {
      // The first pairing (or the first failure) runs each loader that held for it.
      this.settled = true;
      if (state === "open") this.hasOpened = true;
      const held = [...this.settleListeners];
      this.settleListeners.clear();
      for (const l of held) l();
      return;
    }
    if (state === "open") void this.flushOutbox();
    if (state === "open") {
      // open → offline → connecting → open is the usual retry path: still a reconnect.
      if (this.hasOpened) void this.reconnected();
      else void this.refreshAll().catch(() => {});
      this.hasOpened = true;
    }
  }

  /** Every loaded run counts as changed: events may have been missed, so each is re-read once. */
  private markRunsChanged(): void {
    for (const id of Object.keys(this.base.runs)) this.changedRuns.add(id);
  }

  /** After a reconnect: old approval cards are stale until the Gateway re-issues them. */
  private async reconnected(): Promise<void> {
    // Events were missed while the connection was down: a run may have settled then.
    this.markRunsChanged();
    this.update((s) => {
      const stale: Record<string, true> = { ...s.staleApprovals };
      for (const a of Object.values(s.approvals)) if (a.status === "pending") stale[a.id] = true;
      return { ...s, staleApprovals: stale, answerTokens: {} };
    });
    try {
      const { stateVersion } = await this.call("events.subscribe", {});
      this.update((s) => ({ ...s, stateVersion: Math.max(s.stateVersion, stateVersion) }));
    } catch {
      // Refresh anyway: the version only tells us whether anything changed.
    }
    await this.refreshAll().catch(() => {});
    await this.settleStaleRuns();
  }

  /**
   * After a reconnect a run the client saw running may have ended while it was away (a restart
   * fails it, a Stop settles it): read each one again so the chat stops claiming work, then drop
   * the partial replies of runs that ended without a committed message.
   */
  private async settleStaleRuns(): Promise<void> {
    const open = Object.values(this.base.runs)
      .filter((r) => r.status === "running" || r.status === "awaiting_approval")
      .slice(0, 20);
    await Promise.all(
      open.map(async (r) => {
        try {
          const version = this.version();
          const res = await this.call("runs.get", { runId: r.id });
          this.update((s) => putMany(s, "runs", [res.run], version));
        } catch {
          // Unreachable now: the next refresh tries again.
        }
      }),
    );
    this.update((s) => dropSettledStreaming(s));
  }

  // --- Events ----------------------------------------------------------------------------------

  private onEvent(e: GatewayEvent): void {
    const last = this.base.lastSeq;
    // A duplicate or late event (seq ≤ last) is applied idempotently but never moves seq back.
    const gap = last !== null && e.seq > last + 1;
    const apply = e.event === "chat.delta" ? "updateCoalesced" : "update";
    this[apply]((s) =>
      this.reduce(
        {
          ...s,
          lastSeq: last === null ? e.seq : Math.max(last, e.seq),
          stateVersion: Math.max(s.stateVersion, e.stateVersion),
        },
        e,
      ),
    );
    this.noteThreadUse(e);
    if (++this.eventsSinceMaintain >= MAINTAIN_EVERY_EVENTS) this.maintain();
    if (e.event === "thread.deleted") {
      this.lastUsed.delete(e.payload.threadId);
      this.retained.delete(e.payload.threadId);
    }
    if (e.event === "run.step") this.changedRuns.add(e.payload.runId);
    if (e.event === "run.updated") this.changedRuns.add(e.payload.run.id);
    if (gap) {
      this.markRunsChanged();
      this.scheduleGapRefresh();
    }
    if (INSIGHTS_EVENTS.has(e.event)) this.invalidateInsightsSoon();
    if (MAP_EVENTS.has(e.event)) this.invalidateMapSoon();
    // The Library list and item loaders are not queries: rerun the open ones for a created or updated item.
    if (e.event === "library.item.changed" && e.payload.change !== "deleted") {
      void this.refreshKeys("library:");
    }
  }

  /** Reruns the registered loaders whose key starts with `prefix`; each loader shows its own error. */
  private async refreshKeys(prefix: string): Promise<void> {
    const once = [...this.refreshers.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .flatMap(([, set]) => [...set].slice(0, 1));
    await Promise.allSettled(once.map((r) => r()));
  }

  /** Coalesces gap refreshes: one in flight, one trailing, spaced `GAP_REFRESH_MIN_MS` apart. */
  private scheduleGapRefresh(): void {
    if (this.gapRunning) {
      this.gapQueued = true;
      return;
    }
    if (this.gapTimer !== undefined) return;
    const wait = Math.max(
      GAP_REFRESH_DEBOUNCE_MS,
      this.gapLastStart + GAP_REFRESH_MIN_MS - Date.now(),
    );
    this.gapTimer = setTimeout(() => {
      this.gapTimer = undefined;
      void this.runGapRefresh();
    }, wait);
  }

  private async runGapRefresh(): Promise<void> {
    this.gapRunning = true;
    this.gapLastStart = Date.now();
    try {
      await this.refreshAll();
    } catch {
      // Each loader shows its own error.
    } finally {
      this.gapRunning = false;
      if (this.gapQueued) {
        this.gapQueued = false;
        this.scheduleGapRefresh();
      }
    }
  }

  /**
   * `insights.summary` has no event of its own: the events that feed its inputs mark it stale,
   * at most once per `INSIGHTS_DEBOUNCE_MS` (agent-overview-2026 §6.2).
   */
  private invalidateInsightsSoon(): void {
    if (this.insightsTimer !== undefined) return;
    this.insightsTimer = setTimeout(() => {
      this.insightsTimer = undefined;
      this.update((s) => invalidate(s, ["insights.", "artifacts.list"]));
    }, INSIGHTS_DEBOUNCE_MS);
  }

  /**
   * `memory.graph.map` reads the whole graph, so the people-graph events mark it stale at most once
   * per `MAP_DEBOUNCE_MS`, not on every write of an ingest or a nightly pass.
   */
  private invalidateMapSoon(): void {
    if (this.mapTimer !== undefined) return;
    this.mapTimer = setTimeout(() => {
      this.mapTimer = undefined;
      this.update((s) => invalidate(s, ["memory.graph.map"]));
    }, MAP_DEBOUNCE_MS);
  }

  /** Pure event reducer. Exposed for tests. */
  reduce(s: UiState, e: GatewayEvent): UiState {
    const v = e.stateVersion;
    switch (e.event) {
      case "chat.delta": {
        const { threadId, messageId, delta, runId } = e.payload;
        const prev = s.streaming[messageId];
        return {
          ...s,
          streaming: {
            ...s.streaming,
            [messageId]: {
              threadId,
              messageId,
              runId: runId ?? prev?.runId ?? null,
              text: (prev?.text ?? "") + delta,
            },
          },
        };
      }
      case "chat.reasoning": {
        const { threadId, runId, stepId, delta, summary, done } = e.payload;
        const prev = s.reasoning[stepId];
        const at = this.now();
        return {
          ...s,
          reasoning: {
            ...s.reasoning,
            [stepId]: {
              threadId,
              runId,
              stepId,
              text: (prev?.text ?? "") + (delta ?? ""),
              summary: summary ?? prev?.summary ?? null,
              done: done === true || prev?.done === true,
              startedAt: prev?.startedAt ?? at,
              updatedAt: at,
            },
          },
        };
      }
      case "widget.draft": {
        const { threadId, callId, title, root, nodes, done } = e.payload;
        if (done === true) {
          const { [callId]: _gone, ...rest } = s.widgetDrafts;
          return { ...s, widgetDrafts: rest };
        }
        return {
          ...s,
          widgetDrafts: {
            ...s.widgetDrafts,
            [callId]: {
              threadId,
              callId,
              title: title ?? null,
              root: (root as Record<string, unknown> | undefined) ?? null,
              nodes,
            },
          },
        };
      }
      case "chat.message": {
        const m = e.payload.message;
        const next = touch(upsertMessage(s, m), `messages:${m.id}`, v);
        // A queued follow-up is done once its message is committed by the Gateway.
        return { ...next, queue: next.queue.filter((q) => q.id !== m.id) };
      }
      case "chat.block":
        return touch(
          appendBlock(s, e.payload.threadId, e.payload.messageId, e.payload.block, this.now()),
          `messages:${e.payload.messageId}`,
          v,
        );
      case "run.updated": {
        const put1 = touch(put(s, "runs", e.payload.run), `runs:${e.payload.run.id}`, v);
        // Reasoning lives only as long as its run is in progress (#633).
        const status = e.payload.run.status;
        if (status === "running" || status === "awaiting_approval" || status === "awaiting_input")
          return put1;
        const runId = e.payload.run.id;
        // A partial reply the run never committed (interrupt, forced stop) must not linger.
        const next = dropSettledStreaming(put1, runId);
        if (!Object.values(next.reasoning).some((r) => r.runId === runId)) return next;
        return {
          ...next,
          reasoning: Object.fromEntries(
            Object.entries(next.reasoning).filter(([, r]) => r.runId !== runId),
          ),
        };
      }
      case "run.step": {
        const { runId, step } = e.payload;
        let next = touch(upsertRunSteps(s, runId, [step]), `runSteps:${step.id}`, v);
        // A loaded detail follows the step; once the step ends its payloads are read again.
        const key = `${runId}/${step.id}`;
        const detail = next.runStepDetails[key];
        if (detail !== undefined) {
          const merged = (next.runSteps[runId] ?? []).find((x) => x.id === step.id) ?? step;
          const { [key]: _stale, ...rest } = next.runStepDetails;
          next = {
            ...next,
            runStepDetails:
              detail.step.status === step.status
                ? { ...next.runStepDetails, [key]: { ...detail, step: merged } }
                : rest,
          };
        }
        return next;
      }
      case "proposal.updated": {
        const proposal = e.payload.proposal;
        return {
          ...touch(s, `proposals:${proposal.id}`, v),
          proposals: { ...s.proposals, [proposal.id]: proposal },
        };
      }
      case "specialist.spawned": {
        const job = e.payload.job;
        return {
          ...touch(s, `specialistJobs:${job.taskId}`, v),
          specialistJobs: { ...s.specialistJobs, [job.taskId]: job },
        };
      }
      case "specialist.progress": {
        const { taskId, runId, step, budget } = e.payload;
        const job = s.specialistJobs[taskId];
        if (job === undefined) return s;
        return {
          ...s,
          specialistJobs: {
            ...s.specialistJobs,
            [taskId]: { ...job, runId, lastStep: step.label, budget },
          },
        };
      }
      case "specialist.result": {
        const { taskId, runId, result } = e.payload;
        const job = s.specialistJobs[taskId];
        if (job === undefined) return s;
        return {
          ...touch(s, `specialistJobs:${taskId}`, v),
          specialistJobs: {
            ...s.specialistJobs,
            [taskId]: {
              ...job,
              runId: runId ?? job.runId,
              status: result.outcome,
              queuePosition: null,
              result,
            },
          },
        };
      }
      case "tool_call.updated":
        return touch(
          put(s, "toolCalls", e.payload.toolCall),
          `toolCalls:${e.payload.toolCall.id}`,
          v,
        );
      case "research.progress": {
        const { toolCallId, event } = e.payload;
        return {
          ...touch(s, `research:${toolCallId}`, v),
          research: { ...s.research, [toolCallId]: [...(s.research[toolCallId] ?? []), event] },
        };
      }
      case "task.updated":
        return touch(put(s, "tasks", e.payload.task), `tasks:${e.payload.task.id}`, v);
      case "task.action": {
        const a = e.payload.action;
        const list = (s.taskActions[a.taskId] ?? []).filter((x) => x.id !== a.id);
        const next = [...list, a].sort((x, y) => x.idx - y.idx);
        return { ...s, taskActions: { ...s.taskActions, [a.taskId]: next } };
      }
      case "approval.created": {
        const { approval, answerToken } = e.payload;
        const { [approval.id]: _old, ...stale } = s.staleApprovals;
        const tokens =
          answerToken === undefined
            ? s.answerTokens
            : { ...s.answerTokens, [approval.id]: answerToken };
        return touch(
          { ...put(s, "approvals", approval), answerTokens: tokens, staleApprovals: stale },
          `approvals:${approval.id}`,
          v,
        );
      }
      case "approval.updated": {
        const a = e.payload.approval;
        let next = touch(put(s, "approvals", a), `approvals:${a.id}`, v);
        if (a.status !== "pending") {
          const { [a.id]: _t, ...tokens } = next.answerTokens;
          next = { ...next, answerTokens: tokens };
          // An answered, expired or invalidated approval no longer waits on the owner, even
          // before the Gateway's own `notification.resolved` arrives.
          const resolvedAt = a.decidedAt ?? new Date().toISOString();
          for (const n of Object.values(next.notifications)) {
            if (n.approvalId === a.id && n.resolvedAt == null)
              next = put(next, "notifications", { ...n, resolvedAt });
          }
        }
        return next;
      }
      case "question.created":
      case "question.updated":
        return touch(
          put(s, "inputRequests", e.payload.inputRequest),
          `inputRequests:${e.payload.inputRequest.id}`,
          v,
        );
      case "receipt.created":
        return put(s, "receipts", e.payload.receipt);
      case "artifact.updated": {
        // A new version (agent, user or specialist): the card, recents and picker follow it;
        // content loads by `id@version`, so the canvas fetches the new one on its next render.
        const { artifact, version } = e.payload;
        let next = put(s, "artifacts", artifact);
        const versions = next.artifactVersions[artifact.id];
        if (versions !== undefined && !versions.some((x) => x.version === version.version))
          next = {
            ...next,
            artifactVersions: { ...next.artifactVersions, [artifact.id]: [...versions, version] },
          };
        const thread = artifact.threadId;
        if (thread != null && next.threadArtifacts[thread] !== undefined) {
          const ids = [
            artifact.id,
            ...(next.threadArtifacts[thread] ?? []).filter((x) => x !== artifact.id),
          ];
          next = { ...next, threadArtifacts: { ...next.threadArtifacts, [thread]: ids } };
        }
        return next;
      }
      case "widget.updated": {
        // `rev` is the order (generative-ui-2026 §5.5): apply only the one that continues from the local rev, otherwise drop the
        // snapshot so the block refetches it with `widgets.get`.
        const { widgetId, rev, ops, state, pinned } = e.payload;
        const fromRev = e.payload.fromRev ?? rev - 1;
        // The pinned list (Overview) follows pins made anywhere, including widgets not loaded here.
        const base = pinned === undefined ? s : invalidate(s, ["widgets.list"]);
        const local = s.widgets[widgetId];
        if (local === undefined) return base;
        if (ops.length === 0 && rev === local.rev) {
          return put(base, "widgets", {
            ...local,
            ...(state === undefined ? {} : { state }),
            ...(pinned === undefined ? {} : { pinned }),
          });
        }
        const applied = fromRev === local.rev ? applyWidgetOps(local.spec, ops) : null;
        if (applied?.ok) {
          return put(s, "widgets", {
            ...local,
            rev,
            spec: applied.spec,
            ...(state === undefined ? {} : { state }),
          });
        }
        const { [widgetId]: _stale, ...rest } = s.widgets;
        return { ...s, widgets: rest };
      }
      case "notification.created":
      // Read, re-delivered or resolved elsewhere (another device, the Gateway): without these the
      // "waiting on you" count kept a card the owner had already answered.
      case "notification.updated":
      case "notification.resolved":
        return touch(
          put(s, "notifications", e.payload.notification),
          `notifications:${e.payload.notification.id}`,
          v,
        );
      case "settings.changed": {
        const settings: Record<string, unknown> = { ...s.settings };
        let next = s;
        for (const entry of e.payload.entries) {
          settings[entry.key] = entry.value;
          next = touch(next, `settings:${entry.key}`, v);
        }
        // Settings → Browser lists the effective signed-in sites, which these keys change.
        if (e.payload.entries.some((entry) => entry.key.startsWith("browser."))) {
          next = invalidate(next, ["browser.settings.get"]);
        }
        // `settings.get` reads (the helper banner, Devices) keep their own copy: reload the ones
        // that ask for a changed key, and the ones that ask for every key.
        next = invalidateSettingsReads(
          next,
          e.payload.entries.map((entry) => entry.key),
        );
        return { ...next, settings };
      }
      case "thread.updated": {
        const t = e.payload.thread;
        const prev = s.threads[t.id];
        const activity = prev?.activity ?? { running: 0, awaitingInput: 0, awaitingApproval: 0 };
        const lastMessage = prev?.lastMessage;
        const automation = prev?.automation;
        return touch(
          {
            ...s,
            threads: {
              ...s.threads,
              [t.id]: {
                thread: t,
                activity,
                ...(lastMessage === undefined ? {} : { lastMessage }),
                ...(automation === undefined ? {} : { automation }),
              },
            },
          },
          `threads:${t.id}`,
          v,
        );
      }
      case "thread.deleted": {
        // Another window, the empty-chat sweep or retention removed it.
        const id = e.payload.threadId;
        if (s.threads[id] === undefined) return s;
        const { [id]: _gone, ...threads } = s.threads;
        return touch({ ...s, threads }, `threads:${id}`, v);
      }
      case "thread.cleared":
        // The thread stays; its transcript was emptied here or in another window.
        return touch(withThreadCleared(s, e.payload.threadId), `threads:${e.payload.threadId}`, v);
      case "thread.context.updated": {
        const u = e.payload.usage;
        const prev = s.threadContext[u.threadId];
        return touch(
          {
            ...s,
            threadContext: {
              ...s.threadContext,
              [u.threadId]: { ...prev, usage: u, limits: u.limits },
            },
          },
          `threadContext:${u.threadId}`,
          v,
        );
      }
      case "feed.updated": {
        let next = s;
        for (const post of e.payload.posts)
          next = touch(put(next, "feed", post), `feed:${post.id}`, v);
        return next;
      }
      case "feed.post":
        return touch(put(s, "feed", e.payload.post), `feed:${e.payload.post.id}`, v);
      case "idea.updated":
        return touch(put(s, "ideas", e.payload.idea), `ideas:${e.payload.idea.id}`, v);
      case "goal.updated":
        return touch(put(s, "goals", e.payload.goal), `goals:${e.payload.goal.id}`, v);
      case "memory.file.changed":
        return invalidate(
          {
            ...s,
            memoryEtags: { ...s.memoryEtags, [e.payload.path]: e.payload.etag ?? null },
          },
          // The agent's own notes list (Soul & Memory) follows the files.
          e.payload.path.startsWith(AGENT_NOTES_DIR) ? ["memory.notes."] : [],
        );
      case "automation.updated":
        return invalidate(s, ["scheduled.list", "scheduled.runs", "automations.runs"]);
      case "automation.run.started":
      case "automation.run.finished":
        // The Scheduled screen: the list, and each automation's run history; the automation's
        // chat in the sidebar moves up and reads its new count and last run.
        return invalidate(
          withAutomationRun(s, e.payload.run, e.event === "automation.run.started"),
          ["scheduled.list", "scheduled.runs", "automations.runs"],
        );
      case "audit.change.recorded":
        // The chat's change chip and the audit view read audit.changes.
        return invalidate(s, ["audit.changes", "audit.verify"]);
      case "connectors.updated":
        // Settings → Connectors and onboarding read connectors.list; a finished sign-in,
        // a disconnect or a revoked token refreshes it (#505).
        return invalidate(s, ["connectors."]);
      case "node.updated":
        return invalidate(s, ["nodes."]);
      case "security.state.changed":
        // Settings → Permissions → Security records follows alerts and local recoveries.
        return invalidate(s, ["security.state.get"]);
      case "search.sources.updated":
        return invalidate(s, ["search.sources"]);
      case "speech.model_download":
        // Settings → Voice and onboarding show the download's progress and then the engine.
        return invalidate(s, ["speech.engine.status"]);
      case "search.status.updated":
        // Results refresh once a backfill or rebuild has finished, not on every progress tick.
        return invalidate(
          s,
          e.payload.backfill.state === "done"
            ? ["search.status", "search.query"]
            : ["search.status"],
        );
      case "vm.updated":
        return {
          ...s,
          vmGuests: {
            ...s.vmGuests,
            [`${e.payload.nodeId}/${e.payload.guest.name}`]: e.payload,
          },
        };
      case "planFork.updated":
        // Ids and states only: this fork's reads and its chat's list are read again, not every
        // fork's (a running fork emits this on each model call).
        return invalidatePlanForkReads(s, e.payload.forkId, e.payload.threadId);
      case "device.updated":
        return invalidate(s, ["devices."]);
      case "pairing.requested":
        return invalidate(s, ["devices."]);
      case "nightShift.updated":
      case "nightShift.item.updated":
        // Home's "Prepared overnight" and the review sheet read nightShift.status and review.get.
        return invalidate(s, ["nightShift."]);
      case "persona.updated":
        return invalidate(s, ["memory.persona."]);
      case "vault.locked":
      case "vault.unlocked":
        return invalidate(s, ["vault."], ["vault.onePassword."]);
      case "plugins.changed":
        return invalidate(s, ["plugins."]);
      case "library.item.changed": {
        const { itemId, change } = e.payload;
        const touched = touch(s, `library:${itemId}`, v);
        if (change === "deleted") {
          const { [itemId]: _gone, ...rest } = touched.library;
          return invalidate({ ...touched, library: rest }, ["library."]);
        }
        // Created or updated: the open lists and the item reload (see `onEvent`); a held copy of
        // an updated item is dropped so nothing shows its old state meanwhile.
        if (change === "updated") {
          const { [itemId]: _old, ...rest } = touched.library;
          return invalidate({ ...touched, library: rest }, ["library."]);
        }
        return invalidate(touched, ["library."]);
      }
      case "machines.changed":
        // Settings → Devices → Computers Psyche can use, and the machine picker in Computer use.
        return invalidate(s, ["machines."]);
      case "memory.job.updated":
        return invalidate(s, ["memory.status"]);
      // The people and projects graph: every query that could show the change reloads.
      case "memory.entity.updated":
      case "memory.loop.updated":
      case "memory.suggestion.created":
        // The memory map is a whole-graph read: it follows these events on a timer instead.
        return invalidate(
          s,
          [
            "memory.entities.",
            "memory.loops.",
            "memory.graph.",
            "memory.anchors.",
            "memory.catchup.",
          ],
          ["memory.graph.map"],
        );
      case "credential.updated":
        // The 1Password setup is not a credential: reloading it would run `op` again.
        return invalidate(s, ["vault."], ["vault.onePassword."]);
      case "vault.payment.updated":
      case "payments.link.changed":
        return invalidate(s, ["vault.payments"]);
      case "space.updated":
      case "space.tracker.refreshed":
      case "space.proposal.created":
        return invalidate(s, ["spaces."]);
      case "skills.changed":
      case "skills.updated":
      case "skills.draft.updated":
        return invalidate(s, ["skills."]);
      // The teaching loop: lessons, feedback and Growth reload together.
      case "feedback.recorded":
      case "lesson.changed":
      case "growth.updated":
        return invalidateTeaching(s);
      case "gateway.shutdown":
        return { ...s, connection: "offline" };
      default:
        return s;
    }
  }
}

/** Refetches of `insights.summary` wait this long after the last event that could change it. */
export const INSIGHTS_DEBOUNCE_MS = 2000;

/** The memory map refetches at most this often while graph events keep arriving. */
export const MAP_DEBOUNCE_MS = 15_000;

/** The people-graph events that make an open memory map stale. */
const MAP_EVENTS: ReadonlySet<string> = new Set([
  "memory.entity.updated",
  "memory.loop.updated",
  "memory.suggestion.created",
]);

/** Events that change the inputs of `insights.summary`: runs, approvals, artifacts, specialist jobs, growth and the people graph. */
const INSIGHTS_EVENTS: ReadonlySet<string> = new Set([
  "run.updated",
  "approval.created",
  "approval.updated",
  "artifact.updated",
  "specialist.result",
  "growth.updated",
  "memory.entity.updated",
  "memory.loop.updated",
  "memory.suggestion.created",
]);

/** Marks the teaching loop's queries (lessons, feedback, Growth) as needing a reload. */
export function invalidateTeaching(s: UiState): UiState {
  return invalidate(s, ["memory.lessons.", "feedback.", "growth."]);
}

/**
 * An automation's chat in the thread list follows its runs: a run that starts counts once and
 * becomes the last run; its end updates the status.
 */
export function withAutomationRun(s: UiState, run: AutomationRun, started: boolean): UiState {
  const home = Object.values(s.threads).find(
    (e) => e.automation?.automationId === run.automationId,
  );
  if (home?.automation === undefined) return s;
  const prev = home.automation.lastRun;
  const known = prev?.id === run.id;
  const newest = prev === undefined || Date.parse(run.startedAt) >= Date.parse(prev.startedAt);
  const entry: ThreadListEntry = {
    ...home,
    thread: started ? { ...home.thread, lastMessageAt: run.startedAt } : home.thread,
    automation: {
      ...home.automation,
      runCount: home.automation.runCount + (!known && newest ? 1 : 0),
      ...(known || newest
        ? {
            lastRun: {
              id: run.id,
              status: run.status,
              startedAt: run.startedAt,
              endedAt: run.endedAt ?? null,
              summary: run.summary ?? null,
            },
          }
        : prev === undefined
          ? {}
          : { lastRun: prev }),
    },
  };
  return { ...s, threads: { ...s.threads, [home.thread.id]: entry } };
}

/** Marks generic queries whose method starts with one of `prefixes` as needing a reload. */
/** Marks the `settings.get` reads stale that ask for one of `keys`, or for all settings. */
function invalidateSettingsReads(s: UiState, keys: readonly string[]): UiState {
  let changed = false;
  const queries: Record<string, (typeof s.queries)[string]> = { ...s.queries };
  for (const [key, q] of Object.entries(queries)) {
    if (!key.startsWith("settings.get:")) continue;
    let wanted: readonly string[] | undefined;
    try {
      wanted = (JSON.parse(key.slice("settings.get:".length)) as { keys?: string[] }).keys;
    } catch {
      wanted = undefined;
    }
    if (wanted !== undefined && !wanted.some((k) => keys.includes(k))) continue;
    queries[key] = { ...q, version: -1 };
    changed = true;
  }
  return changed ? { ...s, queries } : s;
}

function invalidatePlanForkReads(s: UiState, forkId: string, threadId: string): UiState {
  let changed = false;
  const queries: Record<string, (typeof s.queries)[string]> = { ...s.queries };
  for (const [key, q] of Object.entries(queries)) {
    const at = key.indexOf(":");
    if (!key.startsWith("planForks.") || at < 0) continue;
    let params: { forkId?: string; threadId?: string };
    try {
      params = JSON.parse(key.slice(at + 1)) as typeof params;
    } catch {
      // An unreadable key is read again rather than kept.
      params = { forkId, threadId };
    }
    if (params.forkId === forkId || params.threadId === threadId) {
      queries[key] = { ...q, version: -1 };
      changed = true;
    }
  }
  return changed ? { ...s, queries } : s;
}

function invalidate(
  s: UiState,
  prefixes: readonly string[],
  except: readonly string[] = [],
): UiState {
  let changed = false;
  const queries: Record<string, (typeof s.queries)[string]> = { ...s.queries };
  for (const [key, q] of Object.entries(queries)) {
    if (prefixes.some((p) => key.startsWith(p)) && !except.some((p) => key.startsWith(p))) {
      queries[key] = { ...q, version: -1 };
      changed = true;
    }
  }
  return changed ? { ...s, queries } : s;
}
