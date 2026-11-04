import { Type } from "@sinclair/typebox";
import { Id } from "../common.ts";
import { Notification } from "../schemas/surfaces.ts";
import { defineMethod, nextCursor, pageParams } from "./define.ts";

/** `notifications.*` (data model §8). */

export const NotificationsMethods = {
  "notifications.device.register": defineMethod({
    params: Type.Object({ enabled: Type.Boolean() }),
    result: Type.Object({ enabled: Type.Boolean() }),
    scope: "operator.read",
    description:
      "Turns this connection's OS notifications on or off (`device:<deviceId>` surface). While on, the Host sends it `notification.device` events for what it would also put on the Host's own screen, with quiet hours and interruption levels applied. Lasts for this connection only: register again after reconnecting.",
  }),
  "notifications.list": defineMethod({
    params: Type.Object({
      unreadOnly: Type.Optional(Type.Boolean()),
      unresolvedOnly: Type.Optional(Type.Boolean()),
      ...pageParams,
    }),
    result: Type.Object({ notifications: Type.Array(Notification), ...nextCursor }),
    scope: "operator.read",
    description: "Lists in-app inbox notifications, newest first.",
  }),
  "notifications.markRead": defineMethod({
    params: Type.Object({ notificationIds: Type.Array(Id, { minItems: 1, maxItems: 500 }) }),
    result: Type.Object({ updated: Type.Integer({ minimum: 0 }) }),
    scope: "operator.write",
    description: "Marks notifications read.",
  }),
  "notifications.resolve": defineMethod({
    params: Type.Object({ notificationId: Id, actionId: Type.Optional(Type.String()) }),
    result: Type.Object({ notification: Notification }),
    scope: "operator.write",
    description:
      "Resolves a notification, optionally by one of its actions. Approval actions still go through approvals.answer.",
  }),
} as const;
