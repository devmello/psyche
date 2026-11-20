import { Type } from "@sinclair/typebox";
import { Id } from "../common.ts";
import { MailFollowupAction, MailFollowupItem } from "../schemas/mail-followups.ts";
import { defineMethod } from "./define.ts";

/** `mailFollowups.*`: quiet email threads to follow up on. Nothing here sends mail. */
export const MailFollowupMethods = {
  "mailFollowups.list": defineMethod({
    params: Type.Object({}),
    result: Type.Object({
      enabled: Type.Boolean({ description: "`mail.followups.enabled` is on" }),
      items: Type.Array(MailFollowupItem, { maxItems: 10 }),
    }),
    scope: "operator.read",
    description:
      "Quiet email threads to show now (not snoozed or dismissed), longest quiet first. Empty while the setting is off or no mail source is connected. Reads mail; subjects are untrusted.",
  }),
  "mailFollowups.act": defineMethod({
    params: Type.Object({ id: Id, action: MailFollowupAction }),
    result: Type.Object({ ok: Type.Boolean() }),
    scope: "operator.write",
    sideEffecting: true,
    description:
      "Snooze a quiet thread for a week, or dismiss it until the thread has new mail. Side-effecting; sends nothing.",
  }),
};
