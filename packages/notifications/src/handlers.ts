import {
  type EventName,
  type EventPayload,
  type MethodParams,
  type MethodResult,
  type NotifierEvent,
  PsycheError,
} from "@psyche/protocol";
import type { PsycheNotifier } from "./notifier.ts";

type NotificationMethod = "notifications.list" | "notifications.markRead" | "notifications.resolve";

export type NotificationHandlers = {
  [M in NotificationMethod]: (params: MethodParams<M>) => Promise<MethodResult<M>>;
};

/**
 * `notifications.*` handlers for the Gateway's method router (S01). Params arrive already
 * validated against the protocol schemas; scopes are enforced by the router.
 */
export function createNotificationHandlers(notifier: PsycheNotifier): NotificationHandlers {
  return {
    "notifications.list": (params) => notifier.listPage(params),
    async "notifications.markRead"({ notificationIds }) {
      const ids = [...new Set(notificationIds)];
      // All-or-nothing on unknown ids, so a stale client learns which id is gone.
      for (const id of ids) {
        if ((await notifier.get(id)) === undefined) {
          throw new PsycheError("not_found", `notification ${id} not found`);
        }
      }
      let updated = 0;
      for (const id of ids) {
        const before = await notifier.get(id);
        if (before?.readAt != null) continue;
        await notifier.markRead(id);
        updated += 1;
      }
      return { updated };
    },
    async "notifications.resolve"({ notificationId, actionId }) {
      const notification =
        actionId === undefined
          ? await notifier.resolve(notificationId)
          : await notifier.resolveWithAction(notificationId, actionId);
      return { notification };
    },
  };
}

type NotificationEventName = Extract<
  EventName,
  "notification.created" | "notification.updated" | "notification.resolved"
>;

/** Maps a `Notifier` event onto the WS event the Gateway broadcasts. */
export function toGatewayEvent(e: NotifierEvent): {
  event: NotificationEventName;
  payload: EventPayload<NotificationEventName>;
} {
  const event: NotificationEventName =
    e.type === "created"
      ? "notification.created"
      : e.type === "updated"
        ? "notification.updated"
        : "notification.resolved";
  return { event, payload: { notification: e.notification } };
}
