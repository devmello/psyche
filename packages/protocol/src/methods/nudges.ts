import { Type } from "@sinclair/typebox";
import { Id } from "../common.ts";
import { NudgeAction, NudgeItem } from "../schemas/relationship-nudges.ts";
import { defineMethod } from "./define.ts";

/**
 * `nudges.*`: relationship nudges (docs/design/relationship-nudges-2026.md). Nothing here sends
 * a message: "Draft a reply" only fills the chat composer in the app.
 */
export const NudgeMethods = {
  "nudges.list": defineMethod({
    params: Type.Object({ entityId: Type.Optional(Id) }),
    result: Type.Object({
      enabled: Type.Boolean({ description: "The switch is on and the owner has consented" }),
      items: Type.Array(NudgeItem),
      muted: Type.Boolean({ description: "With entityId: nudges for that person are muted" }),
    }),
    scope: "operator.read",
    description:
      "Nudges to show now (not done, snoozed or muted), best first; with entityId, that person's. Empty while the feature is off.",
  }),
  "nudges.act": defineMethod({
    params: Type.Object({ id: Id, action: NudgeAction }),
    result: Type.Object({ ok: Type.Boolean() }),
    scope: "operator.write",
    sideEffecting: true,
    description:
      "Done (a promise's loop is closed too), snooze for a week or a month, or stop nudges for that person. Side-effecting.",
  }),
  "nudges.mute": defineMethod({
    params: Type.Object({ entityId: Id, muted: Type.Boolean() }),
    result: Type.Object({ ok: Type.Boolean() }),
    scope: "operator.write",
    sideEffecting: true,
    description: "Stops (or resumes) nudges for one person, from their page. Side-effecting.",
  }),
};
