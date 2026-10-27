import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { assetPath } from "@psyche/assets";
import type { Notification } from "@psyche/protocol";
import type { NotificationStore, StoreListFilter } from "./store.ts";
import type { DeliveryRecord, DeliveryStatus, StoredNotification } from "./types.ts";

/** The slice of better-sqlite3's `Database` this store uses (`@psyche/db`'s `PsycheDb.sqlite`). */
export interface SqliteStatement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): unknown;
  transaction<T>(fn: () => T): () => T;
}

/** The DDL for `notifications` and `notification_deliveries`. */
export const NOTIFICATIONS_MIGRATION_URL = pathToFileURL(
  assetPath("packages/notifications/migrations/202610190200_notifications_init.sql"),
);

export function notificationsMigrationSql(): string {
  return readFileSync(NOTIFICATIONS_MIGRATION_URL, "utf8");
}

interface NotificationRow {
  id: string;
  kind: Notification["kind"];
  title: string;
  body: string;
  task_id: string | null;
  approval_id: string | null;
  route: string | null;
  actions: string;
  surfaces: string;
  delivered: string;
  read_at: string | null;
  resolved_at: string | null;
  stale_at: string | null;
  stale_reason: string | null;
  dedupe_key: string | null;
  seq: number;
  created_at: string;
}

interface DeliveryRow {
  notification_id: string;
  surface: string;
  status: DeliveryStatus;
  attempts: number;
  due_at: string | null;
  delivered_at: string | null;
  detail: string | null;
}

function fromRow(r: NotificationRow): StoredNotification {
  const n: Notification = {
    id: r.id,
    kind: r.kind,
    title: r.title,
    body: r.body,
    taskId: r.task_id,
    approvalId: r.approval_id,
    route: r.route,
    actions: JSON.parse(r.actions) as Notification["actions"],
    surfaces: JSON.parse(r.surfaces) as string[],
    delivered: JSON.parse(r.delivered) as Record<string, string>,
    readAt: r.read_at,
    resolvedAt: r.resolved_at,
    createdAt: r.created_at,
  };
  if (r.stale_at !== null) {
    n.staleAt = r.stale_at;
    n.staleReason = r.stale_reason;
  }
  return { notification: n, dedupeKey: r.dedupe_key, seq: r.seq };
}

function deliveryFromRow(r: DeliveryRow): DeliveryRecord {
  return {
    notificationId: r.notification_id,
    surface: r.surface,
    status: r.status,
    attempts: r.attempts,
    dueAt: r.due_at,
    deliveredAt: r.delivered_at,
    detail: r.detail,
  };
}

const COLUMNS =
  "id, kind, title, body, task_id, approval_id, route, actions, surfaces, delivered, read_at, resolved_at, stale_at, stale_reason, dedupe_key, seq, created_at";

/**
 * SQLite inbox on a better-sqlite3 handle. Expects the tables from
 * `migrations/202610190200_notifications_init.sql` (pass `{migrate: true}` to apply them to a
 * fresh database, e.g. in tests; in the Gateway the `@psyche/db` migration runner owns DDL).
 */
export class SqliteNotificationStore implements NotificationStore {
  #db: SqliteDatabase;
  #now: () => string;

  constructor(db: SqliteDatabase, options: { migrate?: boolean; now?: () => string } = {}) {
    this.#db = db;
    this.#now = options.now ?? (() => new Date().toISOString());
    if (options.migrate === true) db.exec(notificationsMigrationSql());
  }

  transaction<T>(fn: () => T): T {
    return this.#db.transaction(fn)();
  }

  nextSeq(): number {
    const r = this.#db
      .prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS s FROM notifications")
      .get() as {
      s: number;
    };
    return r.s;
  }

  #params(row: StoredNotification): unknown[] {
    const n = row.notification;
    return [
      n.id,
      n.kind,
      n.title,
      n.body,
      n.taskId,
      n.approvalId,
      n.route,
      JSON.stringify(n.actions),
      JSON.stringify(n.surfaces),
      JSON.stringify(n.delivered),
      n.readAt,
      n.resolvedAt,
      n.staleAt ?? null,
      n.staleReason ?? null,
      row.dedupeKey,
      row.seq,
      n.createdAt,
    ];
  }

  insert(row: StoredNotification): void {
    this.#db
      .prepare(`INSERT INTO notifications (${COLUMNS}, updated_at) VALUES (${"?, ".repeat(17)}?)`)
      .run(...this.#params(row), this.#now());
  }

  update(row: StoredNotification): void {
    const sets = COLUMNS.split(", ")
      .slice(1)
      .map((c) => `${c} = ?`)
      .join(", ");
    const [id, ...rest] = this.#params(row);
    this.#db
      .prepare(`UPDATE notifications SET ${sets}, updated_at = ? WHERE id = ?`)
      .run(...rest, this.#now(), id);
  }

  get(id: string): StoredNotification | undefined {
    const r = this.#db.prepare(`SELECT ${COLUMNS} FROM notifications WHERE id = ?`).get(id) as
      | NotificationRow
      | undefined;
    return r === undefined ? undefined : fromRow(r);
  }

  findOpenByDedupeKey(key: string): StoredNotification | undefined {
    const r = this.#db
      .prepare(
        `SELECT ${COLUMNS} FROM notifications WHERE dedupe_key = ? AND resolved_at IS NULL LIMIT 1`,
      )
      .get(key) as NotificationRow | undefined;
    return r === undefined ? undefined : fromRow(r);
  }

  list(filter: StoreListFilter = {}): StoredNotification[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.beforeSeq !== undefined) {
      where.push("seq < ?");
      params.push(filter.beforeSeq);
    }
    if (filter.unreadOnly === true) where.push("read_at IS NULL");
    if (filter.unresolvedOnly === true) where.push("resolved_at IS NULL");
    if (filter.kind !== undefined) {
      where.push("kind = ?");
      params.push(filter.kind);
    }
    const sql = `SELECT ${COLUMNS} FROM notifications${
      where.length > 0 ? ` WHERE ${where.join(" AND ")}` : ""
    } ORDER BY seq DESC${filter.limit !== undefined ? " LIMIT ?" : ""}`;
    if (filter.limit !== undefined) params.push(filter.limit);
    return (this.#db.prepare(sql).all(...params) as NotificationRow[]).map(fromRow);
  }

  listUnresolved(taskId?: string): StoredNotification[] {
    const rows =
      taskId === undefined
        ? this.#db
            .prepare(
              `SELECT ${COLUMNS} FROM notifications WHERE resolved_at IS NULL ORDER BY seq DESC`,
            )
            .all()
        : this.#db
            .prepare(
              `SELECT ${COLUMNS} FROM notifications WHERE resolved_at IS NULL AND task_id = ? ORDER BY seq DESC`,
            )
            .all(taskId);
    return (rows as NotificationRow[]).map(fromRow);
  }

  upsertDelivery(d: DeliveryRecord): void {
    const now = this.#now();
    this.#db
      .prepare(
        `INSERT INTO notification_deliveries
           (notification_id, surface, status, attempts, due_at, delivered_at, detail, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (notification_id, surface) DO UPDATE SET
           status = excluded.status, attempts = excluded.attempts, due_at = excluded.due_at,
           delivered_at = excluded.delivered_at, detail = excluded.detail, updated_at = excluded.updated_at`,
      )
      .run(
        d.notificationId,
        d.surface,
        d.status,
        d.attempts,
        d.dueAt,
        d.deliveredAt,
        d.detail,
        now,
        now,
      );
  }

  deliveries(notificationId: string): DeliveryRecord[] {
    return (
      this.#db
        .prepare("SELECT * FROM notification_deliveries WHERE notification_id = ? ORDER BY rowid")
        .all(notificationId) as DeliveryRow[]
    ).map(deliveryFromRow);
  }

  dueDeliveries(nowIso: string): DeliveryRecord[] {
    return (
      this.#db
        .prepare(
          "SELECT * FROM notification_deliveries WHERE status IN ('pending', 'deferred') AND due_at IS NOT NULL AND due_at <= ? ORDER BY due_at, rowid",
        )
        .all(nowIso) as DeliveryRow[]
    ).map(deliveryFromRow);
  }

  openDeliveries(): DeliveryRecord[] {
    return (
      this.#db
        .prepare(
          "SELECT * FROM notification_deliveries WHERE status IN ('pending', 'deferred') ORDER BY rowid",
        )
        .all() as DeliveryRow[]
    ).map(deliveryFromRow);
  }
}
