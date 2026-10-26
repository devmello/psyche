import type { Surface } from "../common.ts";
import type { Notification, NotificationKind } from "../schemas/surfaces.ts";
import type { Unsubscribe } from "./Clock.ts";

/**
 * Notifier contract (architecture §4.12; owner S15, used by S04 / S05 / S10). The in-app inbox
 * is durable; OS, channel and phone delivery fan out from it. Notifications are de-duplicated
 * per `dedupeKey` (default `<kind>:<taskId>` when a task is set): a second `notify` with the same
 * key while the first is unresolved updates and returns the same notification.
 */

export interface NotifyInput {
  kind: NotificationKind;
  title: string;
  body: string;
  taskId?: string;
  approvalId?: string;
  route?: string;
  actions?: Notification["actions"];
  surfaces?: Surface[];
  dedupeKey?: string;
  /**
   * Deliver through quiet hours this once (a meeting prep for a meeting inside them, §4.5).
   * Without it only the kinds in `quietHours.breakthrough` do.
   */
  breakQuietHours?: boolean;
}

export interface NotificationFilter {
  unreadOnly?: boolean;
  unresolvedOnly?: boolean;
  kind?: NotificationKind;
  limit?: number;
}

export type NotifierEvent =
  | { type: "created"; notification: Notification }
  | { type: "updated"; notification: Notification }
  | { type: "resolved"; notification: Notification };

export interface Notifier {
  notify(input: NotifyInput): Promise<Notification>;
  /** Newest first. */
  list(filter?: NotificationFilter): Promise<Notification[]>;
  /** Rejects with `not_found` for an unknown id. */
  markRead(id: string): Promise<Notification>;
  resolve(id: string): Promise<Notification>;
  subscribe(listener: (event: NotifierEvent) => void): Unsubscribe;
}
