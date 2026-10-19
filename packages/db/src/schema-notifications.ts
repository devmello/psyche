/**
 * drizzle mirror of the notifications tables (owner S15, `packages/notifications`;
 * migrations/202610190200_notifications_init.sql). See the header of `schema.ts`.
 */
import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

// §8 Notifications inbox and per-surface delivery state.

export const notifications = sqliteTable("notifications", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  title: text("title").notNull(),
  body: text("body").notNull(),
  taskId: text("task_id"),
  approvalId: text("approval_id"),
  route: text("route"),
  actions: text("actions").notNull(),
  surfaces: text("surfaces").notNull(),
  delivered: text("delivered").notNull(),
  readAt: text("read_at"),
  resolvedAt: text("resolved_at"),
  staleAt: text("stale_at"),
  staleReason: text("stale_reason"),
  dedupeKey: text("dedupe_key"),
  seq: integer("seq").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const notificationDeliveries = sqliteTable(
  "notification_deliveries",
  {
    notificationId: text("notification_id").notNull(),
    surface: text("surface").notNull(),
    status: text("status").notNull(),
    attempts: integer("attempts").notNull(),
    dueAt: text("due_at"),
    deliveredAt: text("delivered_at"),
    detail: text("detail"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.notificationId, t.surface] })],
);

export const notificationsSchema = { notifications, notificationDeliveries };

export type NotificationRow = typeof notifications.$inferSelect;
export type NotificationDeliveryRow = typeof notificationDeliveries.$inferSelect;
