import { type Static, Type } from "@sinclair/typebox";
import { Id, StringEnum } from "../common.ts";

/**
 * Follow-ups on quiet email threads (the morning brief's "Quiet email threads" section and the
 * Home card). A thread shows when the owner sent the last message and nobody answered for the
 * wait (`mail.followups.waitDays`), or when someone asked the owner a question and the owner
 * never replied. Switch: `mail.followups.enabled`. Nothing here sends mail: "Draft a follow-up"
 * only fills the chat composer, and a send still waits on an approval card.
 */
export const MailFollowupKind = StringEnum(["no_reply", "unanswered_question"], {
  $id: "MailFollowupKind",
});
export type MailFollowupKind = Static<typeof MailFollowupKind>;

export const MailFollowupItem = Type.Object(
  {
    id: Id,
    kind: MailFollowupKind,
    source: StringEnum(["apple", "gmail", "imap"]),
    /** Display name or address of the other person: third-party text, one line. */
    who: Type.String({ maxLength: 120 }),
    /** The thread's subject: untrusted mail text, cleaned and one line. */
    subject: Type.String({ maxLength: 200 }),
    /** Whole days since the last message. */
    daysQuiet: Type.Integer({ minimum: 0 }),
    link: Type.Optional(Type.String({ maxLength: 1000 })),
    /** Gmail only: the API's own opaque thread id, so a draft can open the exact thread. */
    gmailThreadId: Type.Optional(Type.String({ pattern: "^[A-Za-z0-9_-]{1,64}$", maxLength: 64 })),
    /** Always true: the subject and name come from mail. */
    untrusted: Type.Literal(true),
  },
  { $id: "MailFollowupItem" },
);
export type MailFollowupItem = Static<typeof MailFollowupItem>;

export const MailFollowupAction = StringEnum(["snooze", "dismiss"], { $id: "MailFollowupAction" });
export type MailFollowupAction = Static<typeof MailFollowupAction>;
