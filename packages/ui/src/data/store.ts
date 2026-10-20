import {
  type MethodName,
  type MethodParams,
  type MethodResult,
  PsycheError,
  requiresIdempotencyKey,
} from "@psyche/protocol";
import {
  type ConnectionState,
  type GatewayClient,
  type GatewayEvent,
  GatewayRequestError,
  newIdempotencyKey,
} from "./client.ts";
import {
  appendBlock,
  INITIAL_STATE,
  put,
  type QueuedFollowUp,
  touch,
  type UiState,
  upsertMessage,
} from "./state.ts";

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
export class GatewayStore {
  readonly client: GatewayClient;
  private base: UiState;
  private overlays: Overlay[] = [];
  private snapshot: UiState;
  private listeners = new Set<() => void>();
  private refreshers = new Map<string, Set<Refresher>>();
  private refreshing = 0;
  /** True once the connection has been open; any later transition to open is a reconnect. */
  private hasOpened: boolean;
  /** Queued follow-up ids being sent right now (single owner per item). */
  private sending = new Set<string>();
  private nextOverlayId = 1;
  private unsubscribe: Array<() => void> = [];
  private readonly now: () => string;

  constructor(client: GatewayClient, options: { now?: () => string } = {}) {
    this.client = client;
    this.now = options.now ?? (() => new Date().toISOString());
    this.base = { ...INITIAL_STATE, connection: client.connectionState() };
    this.hasOpened = this.base.connection === "open";
    this.snapshot = this.base;
  }

  private starts = 0;

  /** Starts listening to the client. Reference-counted: each `start()` needs one `stop()`. */
  start(): void {
    this.starts += 1;
    if (this.unsubscribe.length > 0) return;
    this.unsubscribe.push(this.client.subscribe((e) => this.onEvent(e)));
    this.unsubscribe.push(this.client.onConnectionState((s) => this.onConnection(s)));
  }

  stop(): void {
    this.starts = Math.max(0, this.starts - 1);
    if (this.starts > 0) return;
    for (const u of this.unsubscribe) u();
    this.unsubscribe = [];
  }

  // --- Subscription (useSyncExternalStore) -----------------------------------------------------

  getState = (): UiState => this.snapshot;

  subscribeStore = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Applies a change to the base state and recomputes the visible snapshot. */
  update(fn: (s: UiState) => UiState): void {
    this.base = fn(this.base);
    this.recompute();
  }

  private recompute(): void {
    this.snapshot = this.overlays.reduce((s, o) => o.apply(s), this.base);
    for (const l of this.listeners) l();
  }

  // --- Requests --------------------------------------------------------------------------------

  /** Sends a request, adding an idempotency key when the method needs one. */
  async call<M extends MethodName>(method: M, params: MethodParams<M>): Promise<MethodResult<M>> {
    const options = requiresIdempotencyKey(method) ? { idempotencyKey: newIdempotencyKey() } : {};
    try {
      return await this.client.request(method, params, options);
    } catch (err) {
      if (err instanceof GatewayRequestError) throw err;
      if (err instanceof PsycheError)
        throw new GatewayRequestError(method, err.code, err.message, err.details);
      const message = err instanceof Error ? err.message : String(err);
      throw new GatewayRequestError(method, "internal", message);
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
      if (commit !== undefined) this.base = commit(this.base, result);
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
    return this.base.stateVersion;
  }

  // --- Follow-up queue ---------------------------------------------------------------------------

  /**
   * Takes the next sendable follow-up for a thread, once: several components may watch the same
   * thread, and only the first caller gets the item. Failed items stay put until retried.
   */
  takeQueued(threadId: string): QueuedFollowUp | null {
    const next = this.base.queue.find((q) => q.threadId === threadId);
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

  private onConnection(state: ConnectionState): void {
    this.update((s) => ({ ...s, connection: state }));
    if (state === "offline") {
      // Stream deltas stop; the committed message replaces them after the refresh.
      this.update((s) => ({ ...s, lastSeq: null }));
    }
    if (state === "open") {
      // open → offline → connecting → open is the usual retry path: still a reconnect.
      if (this.hasOpened) void this.reconnected();
      this.hasOpened = true;
    }
  }

  /** After a reconnect: old approval cards are stale until the Gateway re-issues them. */
  private async reconnected(): Promise<void> {
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
  }

  // --- Events ----------------------------------------------------------------------------------

  private onEvent(e: GatewayEvent): void {
    const last = this.base.lastSeq;
    // A duplicate or late event (seq ≤ last) is applied idempotently but never moves seq back.
    const gap = last !== null && e.seq > last + 1;
    this.update((s) =>
      this.reduce(
        {
          ...s,
          lastSeq: last === null ? e.seq : Math.max(last, e.seq),
          stateVersion: Math.max(s.stateVersion, e.stateVersion),
        },
        e,
      ),
    );
    if (gap) void this.refreshAll().catch(() => {});
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
      case "run.updated":
        return touch(put(s, "runs", e.payload.run), `runs:${e.payload.run.id}`, v);
      case "tool_call.updated":
        return touch(
          put(s, "toolCalls", e.payload.toolCall),
          `toolCalls:${e.payload.toolCall.id}`,
          v,
        );
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
      case "notification.created":
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
        return { ...next, settings };
      }
      case "thread.updated": {
        const t = e.payload.thread;
        const prev = s.threads[t.id];
        const activity = prev?.activity ?? { running: 0, awaitingInput: 0, awaitingApproval: 0 };
        const lastMessage = prev?.lastMessage;
        return touch(
          {
            ...s,
            threads: {
              ...s.threads,
              [t.id]: {
                thread: t,
                activity,
                ...(lastMessage === undefined ? {} : { lastMessage }),
              },
            },
          },
          `threads:${t.id}`,
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
        return {
          ...s,
          memoryEtags: { ...s.memoryEtags, [e.payload.path]: e.payload.etag ?? null },
        };
      case "node.updated":
        return invalidate(s, ["nodes."]);
      case "device.updated":
      case "pairing.requested":
        return invalidate(s, ["devices."]);
      case "memory.job.updated":
        return invalidate(s, ["memory.status"]);
      case "credential.updated":
        return invalidate(s, ["vault."]);
      case "skills.changed":
      case "skills.updated":
        return invalidate(s, ["skills."]);
      case "gateway.shutdown":
        return { ...s, connection: "offline" };
      default:
        return s;
    }
  }
}

/** Marks generic queries whose method starts with one of `prefixes` as needing a reload. */
function invalidate(s: UiState, prefixes: readonly string[]): UiState {
  let changed = false;
  const queries: Record<string, (typeof s.queries)[string]> = { ...s.queries };
  for (const [key, q] of Object.entries(queries)) {
    if (prefixes.some((p) => key.startsWith(p))) {
      queries[key] = { ...q, version: -1 };
      changed = true;
    }
  }
  return changed ? { ...s, queries } : s;
}
