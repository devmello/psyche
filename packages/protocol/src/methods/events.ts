import { Type } from "@sinclair/typebox";
import { Id } from "../common.ts";
import { defineMethod } from "./define.ts";

/** `events.subscribe`: narrows which events this connection receives (data model §11). */

export const EventFilters = Type.Object(
  {
    events: Type.Optional(
      Type.Array(Type.String({ minLength: 1, pattern: "^[A-Za-z0-9_.]+\\*?$" }), {
        maxItems: 64,
        description: 'Event names or prefix patterns, e.g. "chat.*"',
      }),
    ),
    threadIds: Type.Optional(Type.Array(Id, { maxItems: 256 })),
  },
  { $id: "EventFilters" },
);

export const EventsMethods = {
  "events.subscribe": defineMethod({
    params: Type.Object({ filters: Type.Optional(EventFilters) }),
    result: Type.Object({ stateVersion: Type.Integer({ minimum: 0 }) }),
    scope: "operator.read",
    description:
      "Replaces this connection's event filters (no filters → every event the device's scopes allow). Returns the current stateVersion.",
  }),
} as const;
