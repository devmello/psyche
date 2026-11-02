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
  /**
   * With a `dedupeKey` that matches an open notification: return it unchanged instead of
   * updating its text, so the first notice about a thing is not overwritten by a generic one.
   */
  keepExisting?: boolean;
}

/**
 * The dedupe key of the one owner-facing notice a task sends for a purpose (default "result"):
 * the agent's `notify` tool and the scheduler's completion notice share it, so a run that told
 * the owner itself is not announced a second time, and a retried run does not send another.
 */
export function ownerNoticeKey(taskOrRunId: string, purpose?: string): string {
  const p = (purpose ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .slice(0, 40);
  return `notice:${taskOrRunId}:${p === "" ? "result" : p}`;
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
