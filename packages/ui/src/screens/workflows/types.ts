/**
 * View models for the cards whose content is not a Feed post (docs/workflows/mail-and-meetings-
 * 2026.md §4.3, §4.4): the Gateway's draft and scheduling services return these shapes as tool
 * results (`packages/proactive/src/mail/{drafts,scheduling}.ts`); the host maps them in.
 */

export type DraftTone = "shorter" | "warmer" | "more_formal" | "more_direct";
export const DRAFT_TONES: readonly DraftTone[] = [
  "shorter",
  "warmer",
  "more_formal",
  "more_direct",
];

export interface DraftView {
  to: string;
  subject: string;
  body: string;
  /** Sentences that commit the owner to a time, a price or a decision. */
  commitments: readonly string[];
  /** Drafted with the owner's voice profile (`mail/VOICE.md`). */
  voiceUsed: boolean;
  /** Opens the saved draft in the mail app (`message://…` or the Gmail URL). */
  link?: string | null;
  status: "draft" | "rewriting" | "sent";
  /** The thread's sender, for "Contains text from <sender>". */
  taintFrom?: string | null;
  usedCloudModel?: boolean;
}

export interface SlotView {
  start: string;
  end: string;
}

export interface SchedulingView {
  subject: string;
  /** The other side's name, for the slot rows. */
  with?: string;
  /** The owner's and the other side's IANA time zones. */
  timeZone: string;
  theirTimeZone?: string;
  slots: readonly SlotView[];
  /** "proposed": pick and hold; "held": holds on the calendar; "picked": they chose one. */
  state: "proposed" | "held" | "picked";
  /** The slot they picked (state "picked"). */
  picked?: number;
  /** Holds still on the calendar, released by the confirm batch. */
  holds?: number;
  schedulingLink?: string | null;
  taintFrom?: string | null;
}
