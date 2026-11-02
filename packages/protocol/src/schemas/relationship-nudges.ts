import { type Static, Type } from "@sinclair/typebox";
import { Id, Nullable, StringEnum } from "../common.ts";

/**
 * Relationship nudges (docs/design/relationship-nudges-2026.md): people the owner owes a reply,
 * is drifting from, has a birthday coming for, or promised something to. Settings are plain
 * keys: `nudges.enabled` (off until the owner consents), `nudges.consentedAt`,
 * `nudges.sensitivity` (`low` | `normal` | `high`), `nudges.phrasing` (reword starters with the
 * model chosen for everything memory; off by default).
 */
export const NudgeKind = StringEnum(["unanswered", "drift", "birthday", "promise"], {
  $id: "NudgeKind",
});
export type NudgeKind = Static<typeof NudgeKind>;

export const NudgeSensitivity = StringEnum(["low", "normal", "high"], { $id: "NudgeSensitivity" });
export type NudgeSensitivity = Static<typeof NudgeSensitivity>;

/** One thing to bring up with the person, and where Psyche knows it from. */
export const NudgeStarter = Type.Object(
  {
    text: Type.String({ maxLength: 160, description: "One short suggestion" }),
    evidence: Type.String({
      maxLength: 240,
      description: "The fact or promise it comes from: attribute, value, how it became known, date",
    }),
  },
  { $id: "NudgeStarter" },
);
export type NudgeStarter = Static<typeof NudgeStarter>;

export const NudgeItem = Type.Object(
  {
    id: Id,
    kind: NudgeKind,
    entityId: Id,
    name: Type.String({ maxLength: 60, description: "A display name: third-party text, one line" }),
    text: Type.String({
      maxLength: 300,
      description: "One plain sentence built from the name, numbers and a template",
    }),
    daysAgo: Nullable(Type.Integer({ minimum: 0 })),
    channel: Nullable(StringEnum(["mail", "messages"])),
    date: Nullable(Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" })),
    /** A promise past its due date: the one "needs you" case. */
    overdue: Type.Boolean(),
    /** Up to three things to bring up; absent or empty when Psyche knows too little. */
    starters: Type.Optional(Type.Array(NudgeStarter, { maxItems: 3 })),
  },
  { $id: "NudgeItem" },
);
export type NudgeItem = Static<typeof NudgeItem>;

export const NudgeAction = StringEnum(["done", "snooze_week", "snooze_month", "mute_person"], {
  $id: "NudgeAction",
});
export type NudgeAction = Static<typeof NudgeAction>;
