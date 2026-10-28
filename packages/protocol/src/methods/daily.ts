import { Type } from "@sinclair/typebox";
import { Id, IsoDateTime, StringEnum } from "../common.ts";
import {
  DailyAutomationDraft,
  DailyAutomationTemplate,
  DailyFollowup,
  DailyFollowupStatus,
  DailyKind,
} from "../schemas/daily.ts";
import { Automation } from "../schemas/integrations.ts";
import { defineMethod } from "./define.ts";

/**
 * `daily.*`: the morning brief, the evening wrap-up, follow-ups and plain-language automations.
 * Settings live under the `daily.*` keys (`DAILY_SETTING_KEYS` in `@psyche/proactive`), read and
 * written with `settings.get` / `settings.set`.
 */
export const DailyMethods = {
  "daily.run": defineMethod({
    params: Type.Object({ kind: DailyKind }),
    result: Type.Object({ postId: Type.Optional(Id), skipped: Type.Optional(Type.String()) }),
    scope: "operator.write",
    sideEffecting: true,
    description:
      "Builds the morning brief or evening wrap-up now and posts it to the Feed. Side-effecting.",
  }),
  "daily.followups.list": defineMethod({
    params: Type.Object({ status: Type.Optional(Type.Array(DailyFollowupStatus)) }),
    result: Type.Object({ followups: Type.Array(DailyFollowup) }),
    scope: "operator.read",
    description: "Lists tracked follow-ups (default: open and snoozed items that are due).",
  }),
  "daily.followups.update": defineMethod({
    params: Type.Object({
      id: Id,
      action: StringEnum(["done", "snooze", "dismiss", "reopen"]),
      /** For snooze: when it comes back; default tomorrow morning. */
      until: Type.Optional(IsoDateTime),
    }),
    result: Type.Object({ followup: DailyFollowup }),
    scope: "operator.write",
    sideEffecting: true,
    description: "Marks a follow-up done, snoozes it, dismisses it or reopens it. Side-effecting.",
  }),
  "daily.followups.ingest": defineMethod({
    params: Type.Object({
      text: Type.String({ minLength: 1, maxLength: 4000 }),
      source: StringEnum(["sent_mail", "message", "chat"]),
      sourceLink: Type.Optional(Type.String({ maxLength: 1000 })),
    }),
    result: Type.Object({ added: Type.Array(DailyFollowup) }),
    scope: "operator.write",
    sideEffecting: true,
    description:
      "Detects commitments in text the owner wrote ('I'll send it tomorrow', 'remind me to…') and tracks them. Only the owner's own text; it sends nothing. Side-effecting.",
  }),
  "daily.carryOver": defineMethod({
    params: Type.Object({ ids: Type.Array(Id, { maxItems: 50 }) }),
    result: Type.Object({ followups: Type.Array(DailyFollowup) }),
    scope: "operator.write",
    sideEffecting: true,
    description: "Evening wrap-up 'carry over': snoozes the given follow-ups to tomorrow morning.",
  }),
  "daily.automations.templates": defineMethod({
    params: Type.Object({}),
    result: Type.Object({ templates: Type.Array(DailyAutomationTemplate) }),
    scope: "operator.read",
    description: "Starter phrases for plain-language automations.",
  }),
  "daily.automations.parse": defineMethod({
    params: Type.Object({ text: Type.String({ minLength: 1, maxLength: 1000 }) }),
    result: Type.Object({
      draft: Type.Optional(DailyAutomationDraft),
      /** Why no draft could be made; the owner rewords. */
      error: Type.Optional(Type.String({ maxLength: 300 })),
    }),
    scope: "operator.read",
    description:
      "Turns 'Every Friday at 5, summarise what I shipped' into a structured schedule and prompt for the confirmation card. Creates nothing.",
  }),
  "daily.automations.confirm": defineMethod({
    params: Type.Object({ draft: DailyAutomationDraft }),
    result: Type.Object({ automation: Automation }),
    scope: "operator.write",
    sideEffecting: true,
    description:
      "Creates the scheduled automation for a confirmed draft, through the same scheduler as the schedule tool. Side-effecting.",
  }),
} as const;
