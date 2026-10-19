import {
  type Clock,
  type Notification,
  type NotificationFilter,
  type Notifier,
  type NotifierEvent,
  type NotifyInput,
  PsycheError,
  type TaskEngine,
  type Unsubscribe,
} from "@psyche/protocol";
import { monotonicFactory } from "ulid";
import { interruptionFor, planDelivery, type RoutingConfig, resolveSurfaces } from "./routing.ts";
import { MemoryNotificationStore, type NotificationStore } from "./store.ts";
import type { DeliveryContext, DeliveryOutcome, SurfaceAdapter } from "./surfaces.ts";
import type { DeliveryRecord, StoredNotification } from "./types.ts";

export interface NotifierOptions {
  store?: NotificationStore;
  clock?: Clock;
  newId?: () => string;
  /** A function so live settings changes (quiet hours, channel targets) apply to the next notify. */
  routing?: RoutingConfig | (() => RoutingConfig);
  adapters?: SurfaceAdapter[];
  /** External delivery retries: attempts in total and the first backoff (doubles each time). */
  retry?: { maxAttempts?: number; baseDelayMs?: number };
  /** Runs a non-approval notification action (`notifications.resolve` with `actionId`). */
  onAction?: (notification: Notification, actionId: string) => void | Promise<void>;
}

export interface ListPageParams {
  unreadOnly?: boolean;
  unresolvedOnly?: boolean;
  cursor?: string;
  limit?: number;
}

export interface ReconcileOptions {
  /** Used to check task-bound notifications against the task's current state. */
  tasks?: Pick<TaskEngine, "get">;
  /** Extra rule: return a reason to mark the notification stale. */
  isStale?: (n: Notification) => string | undefined | Promise<string | undefined>;
}

export interface ReconcileResult {
  stale: Notification[];
  /** Deliveries that were in flight at the crash and are due again now. */
  requeued: number;
}

/** A terminal task notification resolves these open notifications of the same task. */
const SUPERSEDED_BY_TERMINAL: readonly Notification["kind"][] = [
  "input_needed",
  "task_done",
  "task_failed",
];

/** Approval answers go through `approvals.answer` (S05), never through the inbox. */
const APPROVAL_ANSWER_ACTIONS = new Set(["approve", "deny"]);

const CURSOR_PREFIX = "seq:";

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function notFound(id: string): never {
  throw new PsycheError("not_found", `notification ${id} not found`);
}

/**
 * The Psyche `Notifier` (architecture §4.12, O10). Writes the durable inbox row first, then fans
 * out: in-app surfaces through `subscribe` events (the Gateway turns them into
 * `notification.*` WS events), OS and channels through `SurfaceAdapter`s, deferred past quiet
 * hours and retried with backoff. De-duplicates per `dedupeKey` (default `<kind>:<taskId>`).
 */
export class PsycheNotifier implements Notifier {
  readonly #store: NotificationStore;
  readonly #clock: Clock;
  readonly #newId: () => string;
  readonly #routing: () => RoutingConfig;
  readonly #adapters: SurfaceAdapter[];
  readonly #maxAttempts: number;
  readonly #baseDelayMs: number;
  readonly #onAction: NotifierOptions["onAction"];
  readonly #listeners = new Set<(e: NotifierEvent) => void>();

  constructor(options: NotifierOptions = {}) {
    this.#store = options.store ?? new MemoryNotificationStore();
    this.#clock = options.clock ?? { now: () => Date.now() };
    const ulid = monotonicFactory();
    this.#newId = options.newId ?? (() => ulid(this.#clock.now()));
    const routing = options.routing ?? {};
    this.#routing = typeof routing === "function" ? routing : () => routing;
    this.#adapters = [...(options.adapters ?? [])];
    this.#maxAttempts = options.retry?.maxAttempts ?? 4;
    this.#baseDelayMs = options.retry?.baseDelayMs ?? 30_000;
    this.#onAction = options.onAction;
  }

  #emit(type: NotifierEvent["type"], n: Notification): void {
    for (const l of this.#listeners) {
      try {
        l({ type, notification: structuredClone(n) });
      } catch {
        // A failing listener must not break delivery to the others.
      }
    }
  }

  subscribe(listener: (event: NotifierEvent) => void): Unsubscribe {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  async notify(input: NotifyInput): Promise<Notification> {
    const now = this.#clock.now();
    const routing = this.#routing();
    const dedupeKey =
      input.dedupeKey ?? (input.taskId === undefined ? null : `${input.kind}:${input.taskId}`);

    const outcome = this.#store.transaction(() => {
      const existing = dedupeKey === null ? undefined : this.#store.findOpenByDedupeKey(dedupeKey);
      if (existing !== undefined) {
        const n = existing.notification;
        n.title = input.title;
        n.body = input.body;
        if (input.actions !== undefined) n.actions = structuredClone(input.actions);
        if (input.route !== undefined) n.route = input.route;
        n.readAt = null;
        existing.seq = this.#store.nextSeq();
        this.#store.update(existing);
        return { kind: "updated" as const, row: existing, superseded: [] as StoredNotification[] };
      }

      const surfaces = resolveSurfaces(routing, input.kind, input.surfaces);
      const plan = planDelivery(routing, input.kind, surfaces, now);
      const n: Notification = {
        id: this.#newId(),
        kind: input.kind,
        title: input.title,
        body: input.body,
        taskId: input.taskId ?? null,
        approvalId: input.approvalId ?? null,
        route: input.route ?? null,
        actions: structuredClone(input.actions ?? []),
        surfaces,
        delivered: {},
        readAt: null,
        resolvedAt: null,
        createdAt: iso(now),
      };
      for (const p of plan) if (p.action === "in_app") n.delivered[p.surface] = iso(now);
      const row: StoredNotification = { notification: n, dedupeKey, seq: this.#store.nextSeq() };

      // One notification per task per state: a finished task closes its open questions.
      const superseded: StoredNotification[] = [];
      if ((input.kind === "task_done" || input.kind === "task_failed") && n.taskId != null) {
        for (const old of this.#store.listUnresolved(n.taskId)) {
          if (!SUPERSEDED_BY_TERMINAL.includes(old.notification.kind)) continue;
          old.notification.resolvedAt = iso(now);
          this.#store.update(old);
          this.#suppressOpen(old.notification.id, "superseded");
          superseded.push(old);
        }
      }

      this.#store.insert(row);
      for (const p of plan) {
        if (p.action === "in_app") {
          this.#store.upsertDelivery({
            notificationId: n.id,
            surface: p.surface,
            status: "delivered",
            attempts: 1,
            dueAt: null,
            deliveredAt: iso(now),
            detail: null,
          });
        } else {
          this.#store.upsertDelivery({
            notificationId: n.id,
            surface: p.surface,
            status: p.action === "defer" ? "deferred" : "pending",
            attempts: 0,
            dueAt: p.action === "defer" ? iso(p.until) : null,
            deliveredAt: null,
            detail: p.action === "defer" ? "quiet hours" : null,
          });
        }
      }
      return { kind: "created" as const, row, superseded };
    });

    for (const s of outcome.superseded) this.#emit("resolved", s.notification);
    if (outcome.kind === "updated") {
      this.#emit("updated", outcome.row.notification);
      return structuredClone(outcome.row.notification);
    }

    const n = outcome.row.notification;
    this.#emit("created", n);
    const immediate = this.#store
      .deliveries(n.id)
      .filter((d) => d.status === "pending" && d.dueAt === null);
    for (const d of immediate) await this.#attempt(d);
    return structuredClone(this.#store.get(n.id)?.notification ?? n);
  }

  async list(filter: NotificationFilter = {}): Promise<Notification[]> {
    return this.#store.list(filter).map((r) => r.notification);
  }

  /** `notifications.list`: newest first, cursor-paged by inbox order. */
  async listPage(
    params: ListPageParams = {},
  ): Promise<{ notifications: Notification[]; nextCursor: string | null }> {
    const limit = Math.min(Math.max(params.limit ?? 50, 1), 500);
    let beforeSeq: number | undefined;
    if (params.cursor !== undefined) {
      const seq = Number(params.cursor.slice(CURSOR_PREFIX.length));
      if (!params.cursor.startsWith(CURSOR_PREFIX) || !Number.isSafeInteger(seq)) {
        throw new PsycheError("invalid_params", "bad cursor");
      }
      beforeSeq = seq;
    }
    const filter: Parameters<NotificationStore["list"]>[0] = { limit: limit + 1 };
    if (beforeSeq !== undefined) filter.beforeSeq = beforeSeq;
    if (params.unreadOnly !== undefined) filter.unreadOnly = params.unreadOnly;
    if (params.unresolvedOnly !== undefined) filter.unresolvedOnly = params.unresolvedOnly;
    const rows = this.#store.list(filter);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      notifications: page.map((r) => r.notification),
      nextCursor: rows.length > limit && last !== undefined ? `${CURSOR_PREFIX}${last.seq}` : null,
    };
  }

  async get(id: string): Promise<Notification | undefined> {
    return this.#store.get(id)?.notification;
  }

  async markRead(id: string): Promise<Notification> {
    const { row, changed } = this.#store.transaction(() => {
      const row = this.#store.get(id) ?? notFound(id);
      if (row.notification.readAt != null) return { row, changed: false };
      row.notification.readAt = iso(this.#clock.now());
      this.#store.update(row);
      return { row, changed: true };
    });
    if (changed) this.#emit("updated", row.notification);
    return row.notification;
  }

  async resolve(id: string): Promise<Notification> {
    const { row, changed } = this.#store.transaction(() => {
      const row = this.#store.get(id) ?? notFound(id);
      if (row.notification.resolvedAt != null) return { row, changed: false };
      const now = this.#clock.now();
      row.notification.resolvedAt = iso(now);
      this.#store.update(row);
      this.#suppressOpen(id, "resolved");
      return { row, changed: true };
    });
    if (changed) this.#emit("resolved", row.notification);
    return row.notification;
  }

  /** `notifications.resolve` with an `actionId`: runs the action, then resolves. */
  async resolveWithAction(id: string, actionId: string): Promise<Notification> {
    const n = this.#store.get(id)?.notification ?? notFound(id);
    if (n.kind === "approval" && APPROVAL_ANSWER_ACTIONS.has(actionId)) {
      throw new PsycheError("invalid_params", "answer approvals with approvals.answer");
    }
    if (!n.actions.some((a) => a.id === actionId)) {
      throw new PsycheError("invalid_params", `notification ${id} has no action ${actionId}`);
    }
    if (n.resolvedAt == null) await this.#onAction?.(n, actionId);
    return this.resolve(id);
  }

  async deliveries(id: string): Promise<DeliveryRecord[]> {
    if (this.#store.get(id) === undefined) notFound(id);
    return this.#store.deliveries(id);
  }

  /** Earliest epoch ms a deferred or retrying delivery is due; the Gateway arms one timer. */
  nextDueAt(): number | undefined {
    const due = this.#store
      .openDeliveries()
      .map((d) => (d.dueAt === null ? Number.NaN : Date.parse(d.dueAt)))
      .filter((t) => !Number.isNaN(t));
    return due.length === 0 ? undefined : Math.min(...due);
  }

  /** Delivers everything due at `now`: deferred (quiet hours) and retrying deliveries. */
  async flushDue(now: number = this.#clock.now()): Promise<number> {
    let attempted = 0;
    for (const d of this.#store.dueDeliveries(iso(now))) {
      const row = this.#store.get(d.notificationId);
      if (row === undefined || row.notification.resolvedAt != null) {
        this.#store.upsertDelivery({ ...d, status: "suppressed", dueAt: null, detail: "resolved" });
        continue;
      }
      // Settings may have changed since the delivery was parked: re-plan this one surface.
      const [plan] = planDelivery(this.#routing(), row.notification.kind, [d.surface], now);
      if (plan?.action === "defer") {
        this.#store.upsertDelivery({ ...d, status: "deferred", dueAt: iso(plan.until) });
        continue;
      }
      await this.#attempt(d, now);
      attempted += 1;
    }
    return attempted;
  }

  /**
   * Restart reconciliation (architecture §4.12, UI §3.20): open approvals are stale (the Gateway
   * invalidates every pending approval at boot and S05 re-issues them); task notifications whose
   * task moved on are stale; the rest stay, and deliveries cut off mid-flight are re-queued.
   */
  async reconcile(options: ReconcileOptions = {}): Promise<ReconcileResult> {
    const now = this.#clock.now();
    const stale: Notification[] = [];
    for (const row of this.#store.listUnresolved()) {
      const reason = await this.#staleReason(row.notification, options);
      if (reason === undefined) continue;
      const n = row.notification;
      n.staleAt = iso(now);
      n.staleReason = reason;
      n.resolvedAt = iso(now);
      this.#store.transaction(() => {
        this.#store.update(row);
        this.#suppressOpen(n.id, "stale");
      });
      stale.push(structuredClone(n));
      this.#emit("resolved", n);
    }
    let requeued = 0;
    for (const d of this.#store.openDeliveries()) {
      if (d.status === "pending" && d.dueAt === null) {
        this.#store.upsertDelivery({ ...d, dueAt: iso(now) });
        requeued += 1;
      }
    }
    return { stale, requeued };
  }

  async #staleReason(n: Notification, options: ReconcileOptions): Promise<string | undefined> {
    if (n.kind === "approval") return "approval invalidated by restart";
    if (options.tasks !== undefined && n.taskId != null) {
      const task = await options.tasks.get(n.taskId);
      if (task === undefined) return "task no longer exists";
      if (n.kind === "input_needed" && task.status !== "awaiting_input") {
        return "task is no longer waiting for input";
      }
      if (n.kind === "task_failed" && task.status !== "failed") return "task was retried";
    }
    return (await options.isStale?.(n)) ?? undefined;
  }

  #suppressOpen(notificationId: string, detail: string): void {
    for (const d of this.#store.deliveries(notificationId)) {
      if (d.status === "pending" || d.status === "deferred") {
        this.#store.upsertDelivery({ ...d, status: "suppressed", dueAt: null, detail });
      }
    }
  }

  async #attempt(d: DeliveryRecord, now: number = this.#clock.now()): Promise<void> {
    const row = this.#store.get(d.notificationId);
    if (row === undefined) return;
    const attempt = d.attempts + 1;
    const adapter = this.#adapters.find((a) => a.handles(d.surface));
    const ctx: DeliveryContext = {
      surface: d.surface,
      interruption: interruptionFor(this.#routing(), row.notification.kind),
      attempt,
    };
    let result: DeliveryOutcome;
    if (adapter === undefined) {
      result = { status: "failed", error: `no adapter for surface ${d.surface}`, retryable: false };
    } else {
      try {
        result = await adapter.deliver(structuredClone(row.notification), ctx);
      } catch (err) {
        result = {
          status: "failed",
          error: err instanceof Error ? err.message : String(err),
          retryable: true,
        };
      }
    }
    const at = iso(this.#clock.now());
    this.#store.transaction(() => {
      if (result.status === "delivered") {
        this.#store.upsertDelivery({
          ...d,
          status: "delivered",
          attempts: attempt,
          dueAt: null,
          deliveredAt: at,
          detail: null,
        });
        const fresh = this.#store.get(d.notificationId);
        if (fresh !== undefined) {
          fresh.notification.delivered[d.surface] = at;
          this.#store.update(fresh);
        }
      } else if (result.status === "suppressed") {
        this.#store.upsertDelivery({
          ...d,
          status: "suppressed",
          attempts: attempt,
          dueAt: null,
          detail: result.reason,
        });
      } else {
        const again = result.retryable && attempt < this.#maxAttempts;
        this.#store.upsertDelivery({
          ...d,
          status: again ? "pending" : "failed",
          attempts: attempt,
          dueAt: again ? iso(now + this.#baseDelayMs * 2 ** (attempt - 1)) : null,
          detail: result.error,
        });
      }
    });
  }
}

export function createNotifier(options: NotifierOptions = {}): PsycheNotifier {
  return new PsycheNotifier(options);
}
