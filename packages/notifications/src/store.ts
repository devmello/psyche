import type { NotificationKind } from "@psyche/protocol";
import type { DeliveryRecord, StoredNotification } from "./types.ts";

export interface StoreListFilter {
  unreadOnly?: boolean;
  unresolvedOnly?: boolean;
  kind?: NotificationKind;
  /** Only rows with `seq` below this (paging cursor). */
  beforeSeq?: number;
  limit?: number;
}

/**
 * Durable inbox storage. Synchronous on purpose: de-duplication is check-then-write, and with
 * better-sqlite3 (ADR-004) a synchronous `transaction` keeps other notifies on the event loop
 * from interleaving. Implementations return copies, never live references.
 */
export interface NotificationStore {
  transaction<T>(fn: () => T): T;
  nextSeq(): number;
  insert(row: StoredNotification): void;
  update(row: StoredNotification): void;
  get(id: string): StoredNotification | undefined;
  findOpenByDedupeKey(key: string): StoredNotification | undefined;
  /** Newest first (`seq` descending). */
  list(filter?: StoreListFilter): StoredNotification[];
  listUnresolved(taskId?: string): StoredNotification[];
  upsertDelivery(d: DeliveryRecord): void;
  deliveries(notificationId: string): DeliveryRecord[];
  /** `pending` / `deferred` deliveries whose `dueAt` is at or before `nowIso`, oldest first. */
  dueDeliveries(nowIso: string): DeliveryRecord[];
  /** Every `pending` / `deferred` delivery, for reconciliation. */
  openDeliveries(): DeliveryRecord[];
}

/** In-memory store for tests and for running without a database. */
export class MemoryNotificationStore implements NotificationStore {
  #rows = new Map<string, StoredNotification>();
  #deliveries = new Map<string, DeliveryRecord>();
  #seq = 0;

  transaction<T>(fn: () => T): T {
    return fn();
  }

  nextSeq(): number {
    this.#seq += 1;
    return this.#seq;
  }

  insert(row: StoredNotification): void {
    this.#rows.set(row.notification.id, structuredClone(row));
    this.#seq = Math.max(this.#seq, row.seq);
  }

  update(row: StoredNotification): void {
    this.insert(row);
  }

  get(id: string): StoredNotification | undefined {
    const r = this.#rows.get(id);
    return r === undefined ? undefined : structuredClone(r);
  }

  findOpenByDedupeKey(key: string): StoredNotification | undefined {
    for (const r of this.#rows.values()) {
      if (r.dedupeKey === key && r.notification.resolvedAt == null) return structuredClone(r);
    }
    return undefined;
  }

  list(filter: StoreListFilter = {}): StoredNotification[] {
    return [...this.#rows.values()]
      .filter((r) => filter.beforeSeq === undefined || r.seq < filter.beforeSeq)
      .filter((r) => filter.unreadOnly !== true || r.notification.readAt == null)
      .filter((r) => filter.unresolvedOnly !== true || r.notification.resolvedAt == null)
      .filter((r) => filter.kind === undefined || r.notification.kind === filter.kind)
      .sort((a, b) => b.seq - a.seq)
      .slice(0, filter.limit ?? Number.POSITIVE_INFINITY)
      .map((r) => structuredClone(r));
  }

  listUnresolved(taskId?: string): StoredNotification[] {
    return this.list({ unresolvedOnly: true }).filter(
      (r) => taskId === undefined || r.notification.taskId === taskId,
    );
  }

  upsertDelivery(d: DeliveryRecord): void {
    this.#deliveries.set(`${d.notificationId}\u0000${d.surface}`, { ...d });
  }

  deliveries(notificationId: string): DeliveryRecord[] {
    return [...this.#deliveries.values()]
      .filter((d) => d.notificationId === notificationId)
      .map((d) => ({ ...d }));
  }

  dueDeliveries(nowIso: string): DeliveryRecord[] {
    return this.openDeliveries()
      .filter((d) => d.dueAt !== null && d.dueAt <= nowIso)
      .sort((a, b) => (a.dueAt ?? "").localeCompare(b.dueAt ?? ""));
  }

  openDeliveries(): DeliveryRecord[] {
    return [...this.#deliveries.values()]
      .filter((d) => d.status === "pending" || d.status === "deferred")
      .map((d) => ({ ...d }));
  }
}
