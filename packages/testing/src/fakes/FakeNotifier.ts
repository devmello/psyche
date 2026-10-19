import type {
  Clock,
  Notification,
  NotificationFilter,
  Notifier,
  NotifierEvent,
  NotifyInput,
  Unsubscribe,
} from "@psyche/protocol";
import { FakeClock, toIso } from "../clock.ts";
import { createIdGenerator, type IdGenerator } from "../ids.ts";
import { fail } from "./errors.ts";

interface InboxItem {
  n: Notification;
  dedupeKey?: string;
  seq: number;
}

/** In-memory durable inbox with de-duplication and subscriptions (architecture §4.12). */
export class FakeNotifier implements Notifier {
  readonly clock: Clock;
  #ids: IdGenerator;
  #items: InboxItem[] = [];
  #listeners = new Set<(e: NotifierEvent) => void>();
  #seq = 0;

  constructor(options: { clock?: Clock; ids?: IdGenerator } = {}) {
    this.clock = options.clock ?? new FakeClock();
    this.#ids = options.ids ?? createIdGenerator();
  }

  #emit(e: NotifierEvent): void {
    for (const l of this.#listeners) l(structuredClone(e));
  }

  async notify(input: NotifyInput): Promise<Notification> {
    const now = toIso(this.clock.now());
    const dedupeKey =
      input.dedupeKey ?? (input.taskId === undefined ? undefined : `${input.kind}:${input.taskId}`);
    const existing =
      dedupeKey === undefined
        ? undefined
        : this.#items.find((i) => i.dedupeKey === dedupeKey && i.n.resolvedAt == null);
    if (existing !== undefined) {
      Object.assign(existing.n, {
        title: input.title,
        body: input.body,
        actions: structuredClone(input.actions ?? existing.n.actions),
        readAt: null,
      });
      existing.seq = ++this.#seq;
      this.#emit({ type: "updated", notification: existing.n });
      return structuredClone(existing.n);
    }
    const surfaces = input.surfaces ?? ["desktop"];
    const n: Notification = {
      id: this.#ids.next("ntf"),
      kind: input.kind,
      title: input.title,
      body: input.body,
      taskId: input.taskId ?? null,
      approvalId: input.approvalId ?? null,
      route: input.route ?? null,
      actions: structuredClone(input.actions ?? []),
      surfaces,
      delivered: Object.fromEntries(surfaces.map((s) => [s, now])),
      readAt: null,
      resolvedAt: null,
      createdAt: now,
    };
    const item: InboxItem = { n, seq: ++this.#seq };
    if (dedupeKey !== undefined) item.dedupeKey = dedupeKey;
    this.#items.push(item);
    this.#emit({ type: "created", notification: n });
    return structuredClone(n);
  }

  async list(filter: NotificationFilter = {}): Promise<Notification[]> {
    return [...this.#items]
      .sort((a, b) => b.seq - a.seq)
      .map((i) => i.n)
      .filter((n) => filter.unreadOnly !== true || n.readAt == null)
      .filter((n) => filter.unresolvedOnly !== true || n.resolvedAt == null)
      .filter((n) => filter.kind === undefined || n.kind === filter.kind)
      .slice(0, filter.limit ?? Number.POSITIVE_INFINITY)
      .map((n) => structuredClone(n));
  }

  #find(id: string): Notification {
    const i = this.#items.find((x) => x.n.id === id);
    if (i === undefined) return fail("not_found", `notification ${id} not found`);
    return i.n;
  }

  async markRead(id: string): Promise<Notification> {
    const n = this.#find(id);
    n.readAt ??= toIso(this.clock.now());
    this.#emit({ type: "updated", notification: n });
    return structuredClone(n);
  }

  async resolve(id: string): Promise<Notification> {
    const n = this.#find(id);
    n.resolvedAt ??= toIso(this.clock.now());
    this.#emit({ type: "resolved", notification: n });
    return structuredClone(n);
  }

  subscribe(listener: (event: NotifierEvent) => void): Unsubscribe {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}
