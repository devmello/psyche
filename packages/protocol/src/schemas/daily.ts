import { type Static, Type } from "@sinclair/typebox";
import { Id, IsoDateTime, StringEnum } from "../common.ts";

/**
 * The daily habit surfaces: the morning brief and evening wrap-up cards, the follow-ups Psyche
 * tracks and the plain-language automation draft. Names carry a `Daily` prefix so the generated
 * Swift types do not clash with helper types.
 */

export const DailyKind = StringEnum(["morning", "evening"], { $id: "DailyKind" });
export type DailyKind = Static<typeof DailyKind>;

export const DailySectionId = StringEnum(
  ["calendar", "mail", "due", "followups", "weather", "done", "open", "tomorrow"],
  { $id: "DailySectionId" },
);

export const DailyItem = Type.Object(
  {
    text: Type.String({ maxLength: 500 }),
    /** Where the item came from or what it opens (a prep note, a mail link, a Feed post). */
    link: Type.Optional(Type.String({ maxLength: 1000 })),
    followupId: Type.Optional(Id),
  },
  { $id: "DailyItem" },
);

export const DailySection = Type.Object(
  {
    id: DailySectionId,
    title: Type.String({ maxLength: 120 }),
    items: Type.Array(DailyItem, { maxItems: 50 }),
    /** Set when the connector behind the section is missing, so the card says so once. */
    unavailable: Type.Optional(Type.Boolean()),
  },
  { $id: "DailySection" },
);

export const DailyBrief = Type.Object(
  {
    kind: DailyKind,
    /** Local date, `YYYY-MM-DD`. */
    date: Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }),
    summary: Type.String({ maxLength: 1000 }),
    sections: Type.Array(DailySection, { maxItems: 8 }),
    /** Evening only: open items the owner can carry over to tomorrow. */
    carryOver: Type.Optional(Type.Array(DailyItem, { maxItems: 20 })),
  },
  { $id: "DailyBrief" },
);
export type DailyBrief = Static<typeof DailyBrief>;

export const DailyFollowupStatus = StringEnum(["open", "snoozed", "done", "dismissed"], {
  $id: "DailyFollowupStatus",
});
export const DailyFollowupSource = StringEnum(
  ["sent_mail", "message", "chat", "awaiting_reply", "manual"],
  { $id: "DailyFollowupSource" },
);

export const DailyFollowup = Type.Object(
  {
    id: Id,
    text: Type.String({ maxLength: 500 }),
    source: DailyFollowupSource,
    /** Link back to the mail thread, message or chat the item came from. */
    sourceLink: Type.Optional(Type.String({ maxLength: 1000 })),
    status: DailyFollowupStatus,
    dueAt: Type.Optional(IsoDateTime),
    snoozedUntil: Type.Optional(IsoDateTime),
    createdAt: IsoDateTime,
  },
  { $id: "DailyFollowup" },
);
export type DailyFollowup = Static<typeof DailyFollowup>;

export const DailyAutomationDraft = Type.Object(
  {
    title: Type.String({ minLength: 1, maxLength: 120 }),
    kind: StringEnum(["cron", "interval"]),
    /** Cron expression or ISO-8601 interval. */
    schedule: Type.String({ minLength: 1, maxLength: 120 }),
    timezone: Type.String({ minLength: 1 }),
    prompt: Type.String({ minLength: 1, maxLength: 8000 }),
    /** The schedule in words, for the confirmation card. */
    humanSchedule: Type.String({ maxLength: 200 }),
  },
  { $id: "DailyAutomationDraft" },
);
export type DailyAutomationDraft = Static<typeof DailyAutomationDraft>;

export const DailyAutomationTemplate = Type.Object(
  { id: Type.String(), text: Type.String({ maxLength: 300 }) },
  { $id: "DailyAutomationTemplate" },
);
export type DailyAutomationTemplate = Static<typeof DailyAutomationTemplate>;
