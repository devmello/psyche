import { type Static, Type } from "@sinclair/typebox";
import { IsoDateTime, Nullable, StringEnum } from "../common.ts";

/**
 * Apple app adapters (feature J6; architecture §6, §4.9): typed shapes for the mac helper's
 * `calendar.*`, `reminders.*`, `mail.*`, `notes.*`, `finder.*` and `safari.*` node capabilities,
 * reached through `nodes.invoke` / the agent's node tools as `node.<capability>`. The Permission
 * Broker gates them through the `apple.<app>` connector action matrix (`@psyche/permissions`).
 * Everything these return from app content is `untrusted` data. Added by S14.
 */

const Limit = Type.Optional(Type.Integer({ minimum: 1, maximum: 500 }));

// --- Shared by Calendar and Reminders (wave 1, docs/connectors/apple-apps-2026.md) -------------

/** An alarm: minutes relative to the start / due date (negative = before), or an absolute time. */
export const AppleAlarm = Type.Union(
  [
    Type.Object({
      relativeMinutes: Type.Integer({
        minimum: -40_320,
        maximum: 0,
        description:
          "Minutes before the start or due time (0 = at the time, -15 = 15 minutes before)",
      }),
    }),
    Type.Object({ at: IsoDateTime }),
  ],
  { $id: "AppleAlarm" },
);
export type AppleAlarm = Static<typeof AppleAlarm>;

/** A recurrence rule (an RRULE subset EventKit supports). */
export const AppleRecurrence = Type.Object(
  {
    frequency: StringEnum(["daily", "weekly", "monthly", "yearly"], {
      description: "How often it repeats",
    }),
    interval: Type.Optional(
      Type.Integer({ minimum: 1, maximum: 999, description: "Every N periods (default 1)" }),
    ),
    daysOfWeek: Type.Optional(
      Type.Array(StringEnum(["mo", "tu", "we", "th", "fr", "sa", "su"]), {
        maxItems: 7,
        description: "Weekly only: the days it falls on",
      }),
    ),
    until: Type.Optional(IsoDateTime),
    count: Type.Optional(
      Type.Integer({ minimum: 1, maximum: 999, description: "Stop after N occurrences" }),
    ),
  },
  { $id: "AppleRecurrence" },
);
export type AppleRecurrence = Static<typeof AppleRecurrence>;

// --- Calendar (EventKit) -----------------------------------------------------------------------

export const AppleCalendar = Type.Object(
  {
    id: Type.String(),
    title: Type.String(),
    source: Type.String(),
    writable: Type.Boolean(),
    color: Type.Optional(Type.String()),
  },
  { $id: "AppleCalendar" },
);
export type AppleCalendar = Static<typeof AppleCalendar>;

export const AppleCalendarEvent = Type.Object(
  {
    id: Type.String({ description: "EKEvent.calendarItemIdentifier" }),
    calendarId: Type.String(),
    title: Type.String(),
    start: IsoDateTime,
    end: IsoDateTime,
    allDay: Type.Boolean(),
    location: Nullable(Type.String()),
    notes: Nullable(Type.String()),
    url: Nullable(Type.String()),
    recurring: Type.Boolean(),
    /** Wave 1 (C1). Attendees are read-only in EventKit. */
    attendees: Type.Optional(
      Type.Array(
        Type.Object({
          name: Type.String(),
          email: Nullable(Type.String()),
          status: StringEnum(["accepted", "declined", "tentative", "pending", "unknown"]),
          organizer: Type.Boolean(),
        }),
      ),
    ),
    conferenceUrl: Type.Optional(
      Nullable(
        Type.String({
          description:
            "A meeting link found in the URL, location or notes (Zoom, Meet, Teams, Webex)",
        }),
      ),
    ),
    alarms: Type.Optional(Type.Array(AppleAlarm)),
    recurrence: Type.Optional(Nullable(AppleRecurrence)),
    availability: Type.Optional(StringEnum(["busy", "free", "tentative", "unavailable"])),
  },
  { $id: "AppleCalendarEvent" },
);
export type AppleCalendarEvent = Static<typeof AppleCalendarEvent>;

export const AppleCalendarListEventsParams = Type.Object(
  {
    from: IsoDateTime,
    to: IsoDateTime,
    calendarIds: Type.Optional(Type.Array(Type.String())),
    query: Type.Optional(
      Type.String({ maxLength: 200, description: "Text in the title, location or notes (C1)" }),
    ),
    limit: Limit,
  },
  { $id: "AppleCalendarListEventsParams" },
);
export type AppleCalendarListEventsParams = Static<typeof AppleCalendarListEventsParams>;

export const AppleCalendarEventInput = Type.Object(
  {
    calendarId: Type.Optional(
      Type.String({ description: "Default: the default calendar for new events" }),
    ),
    title: Type.String({ minLength: 1, maxLength: 500 }),
    start: IsoDateTime,
    end: IsoDateTime,
    allDay: Type.Optional(Type.Boolean()),
    location: Type.Optional(Type.String({ maxLength: 500 })),
    notes: Type.Optional(Type.String({ maxLength: 10_000 })),
    url: Type.Optional(Type.String({ maxLength: 2_000 })),
    alarms: Type.Optional(
      Type.Array(AppleAlarm, { maxItems: 5, description: "Replaces the alarms" }),
    ),
    // null removes the recurrence.
    recurrence: Type.Optional(Nullable(AppleRecurrence)),
    availability: Type.Optional(
      StringEnum(["busy", "free"], { description: "Show as busy or free" }),
    ),
  },
  { $id: "AppleCalendarEventInput" },
);
export type AppleCalendarEventInput = Static<typeof AppleCalendarEventInput>;

export const AppleCalendarEventUpdate = Type.Object(
  {
    id: Type.String(),
    title: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
    start: Type.Optional(IsoDateTime),
    end: Type.Optional(IsoDateTime),
    allDay: Type.Optional(Type.Boolean()),
    location: Type.Optional(Type.String({ maxLength: 500 })),
    notes: Type.Optional(Type.String({ maxLength: 10_000 })),
    url: Type.Optional(Type.String({ maxLength: 2_000 })),
    alarms: Type.Optional(
      Type.Array(AppleAlarm, { maxItems: 5, description: "Replaces the alarms" }),
    ),
    // null removes the recurrence.
    recurrence: Type.Optional(Nullable(AppleRecurrence)),
    availability: Type.Optional(
      StringEnum(["busy", "free"], { description: "Show as busy or free" }),
    ),
    span: Type.Optional(
      Type.Union([Type.Literal("this"), Type.Literal("future")], {
        description: "Recurring events (default this)",
      }),
    ),
  },
  { $id: "AppleCalendarEventUpdate" },
);
export type AppleCalendarEventUpdate = Static<typeof AppleCalendarEventUpdate>;

// --- Reminders (EventKit) ----------------------------------------------------------------------

export const AppleReminder = Type.Object(
  {
    id: Type.String(),
    listId: Type.String(),
    title: Type.String(),
    notes: Nullable(Type.String()),
    due: Nullable(IsoDateTime),
    completed: Type.Boolean(),
    priority: Type.Integer({
      minimum: 0,
      maximum: 9,
      description: "0 none, 1 high … 9 low (EventKit)",
    }),
    /** Wave 1 (R1, R2). `url` often links back to a mail message (`message://…`). */
    url: Type.Optional(Nullable(Type.String())),
    flagged: Type.Optional(Type.Boolean()),
    alarms: Type.Optional(Type.Array(AppleAlarm)),
    recurrence: Type.Optional(Nullable(AppleRecurrence)),
  },
  { $id: "AppleReminder" },
);
export type AppleReminder = Static<typeof AppleReminder>;

export const AppleRemindersListParams = Type.Object(
  {
    listIds: Type.Optional(Type.Array(Type.String())),
    completed: Type.Optional(Type.Boolean()),
    dueBefore: Type.Optional(IsoDateTime),
    /** Wave 1 (R1): open reminders past due / due today / flagged / matching text. */
    overdue: Type.Optional(
      Type.Boolean({ description: "Only open reminders past their due time" }),
    ),
    dueToday: Type.Optional(Type.Boolean({ description: "Only reminders due today" })),
    flagged: Type.Optional(Type.Boolean({ description: "Only flagged reminders" })),
    query: Type.Optional(
      Type.String({ maxLength: 200, description: "Text in the title or notes" }),
    ),
    limit: Limit,
  },
  { $id: "AppleRemindersListParams", description: "Results come soonest due first." },
);
export type AppleRemindersListParams = Static<typeof AppleRemindersListParams>;

export const AppleReminderInput = Type.Object(
  {
    listId: Type.Optional(Type.String()),
    title: Type.String({ minLength: 1, maxLength: 500 }),
    notes: Type.Optional(Type.String({ maxLength: 10_000 })),
    due: Type.Optional(IsoDateTime),
    priority: Type.Optional(Type.Integer({ minimum: 0, maximum: 9 })),
    url: Type.Optional(
      Type.String({ maxLength: 2_000, description: "A link to keep with it, e.g. message://<id>" }),
    ),
    alarm: Type.Optional(AppleAlarm),
    recurrence: Type.Optional(AppleRecurrence),
  },
  { $id: "AppleReminderInput" },
);
export type AppleReminderInput = Static<typeof AppleReminderInput>;

export const AppleReminderUpdate = Type.Object(
  {
    id: Type.String(),
    title: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
    notes: Type.Optional(Type.String({ maxLength: 10_000 })),
    due: Type.Optional(Nullable(IsoDateTime)),
    completed: Type.Optional(Type.Boolean()),
    priority: Type.Optional(Type.Integer({ minimum: 0, maximum: 9 })),
  },
  { $id: "AppleReminderUpdate" },
);
export type AppleReminderUpdate = Static<typeof AppleReminderUpdate>;

// --- Mail (Mail.app scripting, read-mostly) ----------------------------------------------------

export const AppleMailMessageSummary = Type.Object(
  {
    id: Type.String({ description: "Mail message id (stable within the account)" }),
    mailbox: Type.String(),
    account: Type.String(),
    subject: Type.String(),
    from: Type.String(),
    date: IsoDateTime,
    read: Type.Boolean(),
    /** Wave 1 (M4, M7). */
    flagged: Type.Optional(Type.Boolean()),
    link: Type.Optional(
      Type.String({ description: "message:// URL that opens this message in Mail" }),
    ),
  },
  { $id: "AppleMailMessageSummary" },
);
export type AppleMailMessageSummary = Static<typeof AppleMailMessageSummary>;

export const AppleMailMessage = Type.Object(
  {
    summary: AppleMailMessageSummary,
    to: Type.Array(Type.String()),
    cc: Type.Array(Type.String()),
    body: Type.String({ description: "Plain text, untrusted" }),
    truncated: Type.Boolean(),
    attachments: Type.Optional(
      Type.Array(
        Type.Object({
          name: Type.String(),
          size: Nullable(Type.Integer({ minimum: 0 })),
          mimeType: Nullable(Type.String()),
        }),
      ),
    ),
  },
  { $id: "AppleMailMessage" },
);
export type AppleMailMessage = Static<typeof AppleMailMessage>;

export const AppleMailSearchParams = Type.Object(
  {
    query: Type.Optional(
      Type.String({
        maxLength: 200,
        description: "Matched against subject and sender; absent or empty matches every message",
      }),
    ),
    mailbox: Type.Optional(Type.String({ description: "Default: inbox" })),
    /** #626: true = unread only, false = read only, absent = both. */
    unread: Type.Optional(Type.Boolean()),
    /** #626: received at or after / before this time. */
    since: Type.Optional(IsoDateTime),
    until: Type.Optional(IsoDateTime),
    /** #626: the sender contains this (name or address). */
    from: Type.Optional(Type.String({ minLength: 1, maxLength: 320 })),
    limit: Limit,
  },
  { $id: "AppleMailSearchParams", description: "Results come newest first." },
);
export type AppleMailSearchParams = Static<typeof AppleMailSearchParams>;

export const AppleMailDraftInput = Type.Object(
  {
    to: Type.Array(Type.String({ maxLength: 320 }), { minItems: 1, maxItems: 50 }),
    cc: Type.Optional(Type.Array(Type.String({ maxLength: 320 }), { maxItems: 50 })),
    subject: Type.String({ maxLength: 500 }),
    body: Type.String({ maxLength: 100_000 }),
  },
  { $id: "AppleMailDraftInput" },
);
export type AppleMailDraftInput = Static<typeof AppleMailDraftInput>;

// --- Notes (Notes.app scripting) ---------------------------------------------------------------

export const AppleNoteSummary = Type.Object(
  {
    id: Type.String(),
    folder: Type.String(),
    title: Type.String(),
    modified: IsoDateTime,
    /** Wave 1 (N1): text around the match, untrusted. */
    snippet: Type.Optional(Type.String()),
  },
  { $id: "AppleNoteSummary" },
);
export type AppleNoteSummary = Static<typeof AppleNoteSummary>;

export const AppleNote = Type.Object(
  {
    summary: AppleNoteSummary,
    html: Type.String({ description: "Notes body HTML, untrusted" }),
    text: Type.String({ description: "Plain text of the body" }),
    truncated: Type.Boolean(),
    attachments: Type.Optional(Type.Array(Type.Object({ id: Type.String(), name: Type.String() }))),
    /** sha256 of `html`: what `notes.update` binds to (N4). */
    bodySha256: Type.Optional(Type.String()),
  },
  { $id: "AppleNote" },
);
export type AppleNote = Static<typeof AppleNote>;

export const AppleNoteInput = Type.Object(
  {
    title: Type.String({ minLength: 1, maxLength: 300 }),
    body: Type.String({ maxLength: 100_000, description: "Plain text; HTML is escaped" }),
    folder: Type.Optional(Type.String({ maxLength: 200 })),
    format: Type.Optional(
      StringEnum(["text", "markdown"], {
        description: "text (default; HTML is escaped) or markdown (macOS 27)",
      }),
    ),
  },
  { $id: "AppleNoteInput" },
);
export type AppleNoteInput = Static<typeof AppleNoteInput>;

// --- Finder and Safari -------------------------------------------------------------------------

export const AppleFinderEntry = Type.Object(
  {
    name: Type.String(),
    path: Type.String(),
    kind: Type.Union([
      Type.Literal("file"),
      Type.Literal("directory"),
      Type.Literal("symlink"),
      Type.Literal("other"),
    ]),
    size: Nullable(Type.Integer({ minimum: 0 })),
    modified: Nullable(IsoDateTime),
  },
  { $id: "AppleFinderEntry" },
);
export type AppleFinderEntry = Static<typeof AppleFinderEntry>;

export const AppleSafariTab = Type.Object(
  {
    window: Type.Integer({ minimum: 0 }),
    index: Type.Integer({ minimum: 0 }),
    title: Type.String(),
    url: Type.String(),
    current: Type.Boolean(),
  },
  { $id: "AppleSafariTab" },
);
export type AppleSafariTab = Static<typeof AppleSafariTab>;

// =================================================================================================
// Wave 1 (docs/connectors/apple-apps-2026.md §4–5; #637). Capability names are in the comments;
// the model-facing tool is the same name with `_`. Lists come newest first unless noted.
// =================================================================================================

/** Message ids (Mail's own, stable within an account) with where to find them. */
const MailIds = {
  ids: Type.Array(Type.String({ minLength: 1, maxLength: 64 }), {
    minItems: 1,
    maxItems: 100,
    description: "Mail message ids from mail.search or mail.selected",
  }),
  mailbox: Type.Optional(
    Type.String({ description: "Mailbox the messages are in (default: inbox)" }),
  ),
  account: Type.Optional(Type.String({ description: "Account of that mailbox" })),
};

// --- Mail (M2–M9) ------------------------------------------------------------------------------

/** `mail.mailboxes` (M2): accounts and mailboxes with their unread counts. */
export const AppleMailMailbox = Type.Object(
  {
    account: Type.String(),
    name: Type.String({ description: "Mailbox name; nested ones as Parent/Child" }),
    unreadCount: Type.Integer({ minimum: 0 }),
    special: Nullable(StringEnum(["inbox", "sent", "drafts", "junk", "trash", "archive"])),
  },
  { $id: "AppleMailMailbox" },
);
export type AppleMailMailbox = Static<typeof AppleMailMailbox>;

/** `mail.selected` (M3): the messages selected in Mail's front viewer (no params). */
export const AppleMailSelectedParams = Type.Object(
  { limit: Limit },
  { $id: "AppleMailSelectedParams" },
);
export type AppleMailSelectedParams = Static<typeof AppleMailSelectedParams>;

/** `mail.reply_draft` (M5): Mail's own reply (quoting, threading), saved as a draft, not sent. */
export const AppleMailReplyDraftParams = Type.Object(
  {
    id: Type.String({ description: "The message to reply to" }),
    mailbox: Type.Optional(Type.String()),
    account: Type.Optional(Type.String()),
    replyAll: Type.Optional(
      Type.Boolean({ description: "Reply to everyone (default: sender only)" }),
    ),
    body: Type.String({ maxLength: 100_000, description: "Plain text written above the quote" }),
    cc: Type.Optional(Type.Array(Type.String({ maxLength: 320 }), { maxItems: 50 })),
  },
  { $id: "AppleMailReplyDraftParams" },
);
export type AppleMailReplyDraftParams = Static<typeof AppleMailReplyDraftParams>;

/** `mail.forward_draft` (M5): Mail's own forward (with attachments), saved as a draft. */
export const AppleMailForwardDraftParams = Type.Object(
  {
    id: Type.String({ description: "The message to forward" }),
    mailbox: Type.Optional(Type.String()),
    account: Type.Optional(Type.String()),
    to: Type.Array(Type.String({ maxLength: 320 }), { minItems: 1, maxItems: 50 }),
    cc: Type.Optional(Type.Array(Type.String({ maxLength: 320 }), { maxItems: 50 })),
    body: Type.Optional(
      Type.String({ maxLength: 100_000, description: "Text above the forwarded message" }),
    ),
  },
  { $id: "AppleMailForwardDraftParams" },
);
export type AppleMailForwardDraftParams = Static<typeof AppleMailForwardDraftParams>;

/** What a saved draft is (M5); `mail.send_draft` (M6) sends exactly this. */
export const AppleMailDraftRef = Type.Object(
  {
    draftId: Type.String(),
    to: Type.Array(Type.String()),
    cc: Type.Array(Type.String()),
    subject: Type.String(),
    bodySha256: Type.String({ description: "sha256 of the body as saved: the send binding" }),
  },
  { $id: "AppleMailDraftRef" },
);
export type AppleMailDraftRef = Static<typeof AppleMailDraftRef>;

/**
 * `mail.send_draft` (M6): sends a saved draft. The approval binds the recipients, subject and
 * body hash of the AppleMailDraftRef; the helper refuses when the draft no longer matches them.
 */
export const AppleMailSendDraftParams = Type.Object(
  {
    draftId: Type.String({ description: "From mail.reply_draft / mail.forward_draft" }),
    to: Type.Array(Type.String({ maxLength: 320 }), {
      minItems: 1,
      maxItems: 50,
      description: "The draft's recipients, as AppleMailDraftRef returned them",
    }),
    cc: Type.Optional(Type.Array(Type.String({ maxLength: 320 }), { maxItems: 50 })),
    subject: Type.String({ maxLength: 500 }),
    bodySha256: Type.String({ description: "AppleMailDraftRef.bodySha256" }),
  },
  { $id: "AppleMailSendDraftParams" },
);
export type AppleMailSendDraftParams = Static<typeof AppleMailSendDraftParams>;

/** `mail.set_flags` (M7): read / unread, flagged, flag color, on up to 100 messages. */
export const AppleMailSetFlagsParams = Type.Object(
  {
    ...MailIds,
    read: Type.Optional(Type.Boolean({ description: "true marks read, false unread" })),
    flagged: Type.Optional(Type.Boolean()),
    flagColor: Type.Optional(
      Type.Integer({
        minimum: 0,
        maximum: 6,
        description: "0 red, 1 orange, 2 yellow, 3 green, 4 blue, 5 purple, 6 gray",
      }),
    ),
  },
  { $id: "AppleMailSetFlagsParams" },
);
export type AppleMailSetFlagsParams = Static<typeof AppleMailSetFlagsParams>;

/** `mail.move` (M8): to another mailbox, or the account's Archive / Junk. */
export const AppleMailMoveParams = Type.Object(
  {
    ...MailIds,
    to: Type.Union([
      StringEnum(["archive", "junk"], { description: "The account's Archive or Junk mailbox" }),
      Type.Object({ mailbox: Type.String(), account: Type.String() }),
    ]),
  },
  { $id: "AppleMailMoveParams" },
);
export type AppleMailMoveParams = Static<typeof AppleMailMoveParams>;

/** `mail.save_attachments` (M9): into the Library, or a granted folder. Files are untrusted. */
export const AppleMailSaveAttachmentsParams = Type.Object(
  {
    id: Type.String(),
    mailbox: Type.Optional(Type.String()),
    account: Type.Optional(Type.String()),
    names: Type.Optional(
      Type.Array(Type.String(), { maxItems: 50, description: "Which attachments (default: all)" }),
    ),
    folder: Type.Optional(
      Type.String({ description: "A granted folder to save into; default: the Library" }),
    ),
  },
  { $id: "AppleMailSaveAttachmentsParams" },
);
export type AppleMailSaveAttachmentsParams = Static<typeof AppleMailSaveAttachmentsParams>;

export const AppleSavedFile = Type.Object(
  {
    name: Type.String(),
    size: Type.Integer({ minimum: 0 }),
    path: Nullable(Type.String({ description: "Where it was saved in a granted folder" })),
    libraryItemId: Nullable(Type.String()),
  },
  { $id: "AppleSavedFile" },
);
export type AppleSavedFile = Static<typeof AppleSavedFile>;

// --- Reminders (R3–R5) -------------------------------------------------------------------------

/** `reminders.complete` (R3): by id, or by the exact title in one list. */
export const AppleRemindersCompleteParams = Type.Object(
  {
    id: Type.Optional(Type.String()),
    title: Type.Optional(
      Type.String({ maxLength: 500, description: "Exact title of one open reminder (when no id)" }),
    ),
    listId: Type.Optional(Type.String({ description: "The list to look in with title" })),
    completed: Type.Optional(Type.Boolean({ description: "false reopens it (default true)" })),
  },
  { $id: "AppleRemindersCompleteParams" },
);
export type AppleRemindersCompleteParams = Static<typeof AppleRemindersCompleteParams>;

/** `reminders.delete` (R4). */
export const AppleRemindersDeleteParams = Type.Object(
  { id: Type.String() },
  { $id: "AppleRemindersDeleteParams" },
);
export type AppleRemindersDeleteParams = Static<typeof AppleRemindersDeleteParams>;

/** `reminders.set_flagged` (R5; Reminders scripting, EventKit has no flag). */
export const AppleRemindersSetFlaggedParams = Type.Object(
  { id: Type.String(), flagged: Type.Boolean() },
  { $id: "AppleRemindersSetFlaggedParams" },
);
export type AppleRemindersSetFlaggedParams = Static<typeof AppleRemindersSetFlaggedParams>;

// --- Calendar (C2, C4) -------------------------------------------------------------------------

/** `calendar.free_busy` (C2): busy blocks in a window (at most 62 days). */
export const AppleCalendarFreeBusyParams = Type.Object(
  {
    from: IsoDateTime,
    to: IsoDateTime,
    calendarIds: Type.Optional(
      Type.Array(Type.String(), { maxItems: 50, description: "Default: every calendar" }),
    ),
  },
  { $id: "AppleCalendarFreeBusyParams" },
);
export type AppleCalendarFreeBusyParams = Static<typeof AppleCalendarFreeBusyParams>;

export const AppleBusyBlock = Type.Object(
  {
    start: IsoDateTime,
    end: IsoDateTime,
    calendarId: Type.String(),
    availability: StringEnum(["busy", "tentative", "unavailable"]),
  },
  { $id: "AppleBusyBlock", description: "Free events are left out; blocks come in start order." },
);
export type AppleBusyBlock = Static<typeof AppleBusyBlock>;

/** `calendar.delete_event` (C4). */
export const AppleCalendarDeleteEventParams = Type.Object(
  {
    id: Type.String(),
    span: Type.Optional(
      StringEnum(["this", "future"], {
        description: "Recurring events: this one or this and later",
      }),
    ),
  },
  { $id: "AppleCalendarDeleteEventParams" },
);
export type AppleCalendarDeleteEventParams = Static<typeof AppleCalendarDeleteEventParams>;

/**
 * `calendar.watch` (streaming, #673 H2; docs/workflows/mail-and-meetings-2026.md §8.4): observes
 * `EKEventStoreChanged` and emits one `AppleCalendarChangedEvent` per quiet period: changes are
 * debounced to 30 s, so a sync that touches many events yields one event. EventKit does not say
 * what changed; the Gateway re-reads the window it cares about. Runs until cancelled.
 */
export const AppleCalendarWatchParams = Type.Object(
  {},
  { $id: "AppleCalendarWatchParams", additionalProperties: false },
);
export type AppleCalendarWatchParams = Static<typeof AppleCalendarWatchParams>;

/** `node.event` data streamed by `calendar.watch`. */
export const AppleCalendarChangedEvent = Type.Object(
  {
    type: Type.Literal("calendar.changed"),
    at: IsoDateTime,
    coalesced: Type.Integer({
      minimum: 1,
      description: "EKEventStoreChanged notifications folded into this event",
    }),
  },
  { $id: "AppleCalendarChangedEvent" },
);
export type AppleCalendarChangedEvent = Static<typeof AppleCalendarChangedEvent>;

// --- Notes (N1–N4) -----------------------------------------------------------------------------

/** `notes.search` (N1): matched by Notes itself (title and body), newest modified first. */
export const AppleNotesSearchParams = Type.Object(
  {
    query: Type.Optional(Type.String({ maxLength: 200, description: "Text in the title or body" })),
    folder: Type.Optional(Type.String({ maxLength: 200 })),
    modifiedSince: Type.Optional(IsoDateTime),
    limit: Limit,
  },
  { $id: "AppleNotesSearchParams" },
);
export type AppleNotesSearchParams = Static<typeof AppleNotesSearchParams>;

/** `notes.folders` (N2): the folder tree. */
export const AppleNoteFolder = Type.Object(
  {
    id: Type.String(),
    name: Type.String(),
    account: Type.String(),
    parentId: Nullable(Type.String()),
    noteCount: Type.Integer({ minimum: 0 }),
  },
  { $id: "AppleNoteFolder" },
);
export type AppleNoteFolder = Static<typeof AppleNoteFolder>;

/** `notes.append` (N3): text, or checklist lines, at the end of a note. */
export const AppleNotesAppendParams = Type.Object(
  {
    id: Type.String(),
    text: Type.String({
      minLength: 1,
      maxLength: 100_000,
      description: "Plain text; HTML is escaped",
    }),
    checklist: Type.Optional(Type.Boolean({ description: "Each line becomes a checklist item" })),
  },
  { $id: "AppleNotesAppendParams" },
);
export type AppleNotesAppendParams = Static<typeof AppleNotesAppendParams>;

/** `notes.update` (N4): replace the body and / or rename, bound to the body the agent read. */
export const AppleNotesUpdateParams = Type.Object(
  {
    id: Type.String(),
    previousBodySha256: Type.String({
      description: "bodySha256 from notes.read: no blind overwrite",
    }),
    title: Type.Optional(Type.String({ minLength: 1, maxLength: 300 })),
    body: Type.Optional(
      Type.String({ maxLength: 100_000, description: "Plain text; HTML is escaped" }),
    ),
  },
  { $id: "AppleNotesUpdateParams" },
);
export type AppleNotesUpdateParams = Static<typeof AppleNotesUpdateParams>;

// --- Contacts (P1–P3; Contacts framework) ------------------------------------------------------

const LabeledValue = Type.Object({
  label: Type.String({ description: "home, work, mobile, … (empty when none)" }),
  value: Type.String(),
});

export const AppleContactSummary = Type.Object(
  {
    id: Type.String(),
    name: Type.String(),
    organization: Type.String(),
    emails: Type.Array(Type.String()),
    phones: Type.Array(Type.String()),
  },
  { $id: "AppleContactSummary" },
);
export type AppleContactSummary = Static<typeof AppleContactSummary>;

/** `contacts.read` (P2). The note field is not read (it needs an Apple-granted entitlement). */
export const AppleContact = Type.Object(
  {
    id: Type.String(),
    givenName: Type.String(),
    familyName: Type.String(),
    nickname: Type.String(),
    organization: Type.String(),
    jobTitle: Type.String(),
    emails: Type.Array(LabeledValue),
    phones: Type.Array(LabeledValue),
    addresses: Type.Array(
      Type.Object({
        label: Type.String(),
        street: Type.String(),
        city: Type.String(),
        state: Type.String(),
        postalCode: Type.String(),
        country: Type.String(),
      }),
    ),
    urls: Type.Array(LabeledValue),
    birthday: Nullable(Type.String({ description: "YYYY-MM-DD, or --MM-DD without a year" })),
    groups: Type.Array(Type.String()),
  },
  { $id: "AppleContact" },
);
export type AppleContact = Static<typeof AppleContact>;

/** `contacts.search` (P1): by name, email, phone or organization. */
export const AppleContactsSearchParams = Type.Object(
  {
    query: Type.String({
      minLength: 1,
      maxLength: 200,
      description: "A name, email, phone or company",
    }),
    limit: Limit,
  },
  { $id: "AppleContactsSearchParams", description: "Results come best match first." },
);
export type AppleContactsSearchParams = Static<typeof AppleContactsSearchParams>;

const ContactFields = {
  givenName: Type.Optional(Type.String({ maxLength: 200 })),
  familyName: Type.Optional(Type.String({ maxLength: 200 })),
  organization: Type.Optional(Type.String({ maxLength: 200 })),
  jobTitle: Type.Optional(Type.String({ maxLength: 200 })),
  birthday: Type.Optional(
    Type.String({ pattern: "^(\\d{4}|-)-\\d{2}-\\d{2}$", description: "YYYY-MM-DD or --MM-DD" }),
  ),
};

/** `contacts.create` (P3). */
export const AppleContactInput = Type.Object(
  {
    ...ContactFields,
    emails: Type.Optional(Type.Array(LabeledValue, { maxItems: 10 })),
    phones: Type.Optional(Type.Array(LabeledValue, { maxItems: 10 })),
  },
  { $id: "AppleContactInput" },
);
export type AppleContactInput = Static<typeof AppleContactInput>;

/** `contacts.update` (P3): set fields; emails and phones are added, never replaced. */
export const AppleContactUpdate = Type.Object(
  {
    id: Type.String(),
    ...ContactFields,
    addEmails: Type.Optional(Type.Array(LabeledValue, { maxItems: 10 })),
    addPhones: Type.Optional(Type.Array(LabeledValue, { maxItems: 10 })),
  },
  { $id: "AppleContactUpdate" },
);
export type AppleContactUpdate = Static<typeof AppleContactUpdate>;

// --- Music and Spotify (U1–U2; app scripting) --------------------------------------------------

const MusicApp = Type.Optional(
  StringEnum(["music", "spotify"], {
    description: "Which player (default: whichever is playing, else Music)",
  }),
);

/** `music.now_playing` (U1). */
export const AppleNowPlaying = Type.Object(
  {
    app: StringEnum(["music", "spotify"]),
    state: StringEnum(["playing", "paused", "stopped"]),
    track: Nullable(
      Type.Object({
        name: Type.String(),
        artist: Type.String(),
        album: Type.String(),
        durationSeconds: Nullable(Type.Number({ minimum: 0 })),
        positionSeconds: Nullable(Type.Number({ minimum: 0 })),
      }),
    ),
    volume: Nullable(Type.Integer({ minimum: 0, maximum: 100 })),
    shuffle: Nullable(Type.Boolean()),
  },
  { $id: "AppleNowPlaying" },
);
export type AppleNowPlaying = Static<typeof AppleNowPlaying>;

/** `music.control` (U1). */
export const AppleMusicControlParams = Type.Object(
  {
    app: MusicApp,
    action: StringEnum(["play", "pause", "playpause", "next", "previous", "volume", "shuffle"]),
    volume: Type.Optional(
      Type.Integer({ minimum: 0, maximum: 100, description: "With action volume" }),
    ),
    shuffle: Type.Optional(Type.Boolean({ description: "With action shuffle" })),
  },
  { $id: "AppleMusicControlParams" },
);
export type AppleMusicControlParams = Static<typeof AppleMusicControlParams>;

/** `music.search_library` (U2): the owner's Music library (not the catalog). */
export const AppleMusicSearchParams = Type.Object(
  {
    query: Type.String({ minLength: 1, maxLength: 200 }),
    kind: Type.Optional(
      StringEnum(["track", "album", "artist", "playlist"], { description: "Default: all kinds" }),
    ),
    limit: Limit,
  },
  { $id: "AppleMusicSearchParams", description: "Results come best match first." },
);
export type AppleMusicSearchParams = Static<typeof AppleMusicSearchParams>;

export const AppleMusicItem = Type.Object(
  {
    kind: StringEnum(["track", "album", "artist", "playlist"]),
    id: Type.String({
      description: "Music persistent ID (track, playlist) or a name key (album, artist)",
    }),
    name: Type.String(),
    artist: Nullable(Type.String()),
    album: Nullable(Type.String()),
    trackCount: Nullable(Type.Integer({ minimum: 0 })),
  },
  { $id: "AppleMusicItem" },
);
export type AppleMusicItem = Static<typeof AppleMusicItem>;

/** `music.play` (U2): an item from music.search_library. */
export const AppleMusicPlayParams = Type.Object(
  {
    kind: StringEnum(["track", "album", "artist", "playlist"]),
    id: Type.String(),
    shuffle: Type.Optional(Type.Boolean()),
  },
  { $id: "AppleMusicPlayParams" },
);
export type AppleMusicPlayParams = Static<typeof AppleMusicPlayParams>;

// --- Safari and Chrome (S1–S3) -----------------------------------------------------------------

/** `safari.tab_text` (S1): the text of the current tab or a chosen one, capped. Untrusted. */
export const AppleTabTextParams = Type.Object(
  {
    window: Type.Optional(Type.Integer({ minimum: 0 })),
    index: Type.Optional(Type.Integer({ minimum: 0, description: "Default: the current tab" })),
    maxLength: Type.Optional(Type.Integer({ minimum: 100, maximum: 200_000 })),
  },
  { $id: "AppleTabTextParams" },
);
export type AppleTabTextParams = Static<typeof AppleTabTextParams>;

export const AppleTabText = Type.Object(
  {
    tab: AppleSafariTab,
    text: Type.String({ description: "Page text, untrusted" }),
    truncated: Type.Boolean(),
  },
  { $id: "AppleTabText" },
);
export type AppleTabText = Static<typeof AppleTabText>;

/** `chrome.tabs` / `chrome.current_tab` (S2) return AppleSafariTab records too. */
/** `safari.add_reading_list` (S3). */
export const AppleReadingListParams = Type.Object(
  {
    url: Type.String({ pattern: "^https?://", maxLength: 2_000 }),
    title: Type.Optional(Type.String({ maxLength: 500 })),
  },
  { $id: "AppleReadingListParams" },
);
export type AppleReadingListParams = Static<typeof AppleReadingListParams>;

// --- Files (F1–F3; granted folders only) -------------------------------------------------------

export const AppleFileItem = Type.Object(
  {
    name: Type.String(),
    path: Type.String(),
    kind: StringEnum(["file", "directory", "symlink", "other"]),
    size: Nullable(Type.Integer({ minimum: 0 })),
    modified: Nullable(IsoDateTime),
    added: Nullable(IsoDateTime),
    contentType: Nullable(Type.String({ description: "UTType identifier, e.g. com.adobe.pdf" })),
  },
  { $id: "AppleFileItem" },
);
export type AppleFileItem = Static<typeof AppleFileItem>;

/** `files.recent` (F1): files in a granted folder, newest added first. */
export const AppleFilesRecentParams = Type.Object(
  {
    folder: Type.String({ description: "A granted folder, e.g. ~/Downloads" }),
    addedSince: Type.Optional(IsoDateTime),
    addedBefore: Type.Optional(IsoDateTime),
    contentTypes: Type.Optional(
      Type.Array(Type.String(), {
        maxItems: 20,
        description: "UTType ids or extensions (pdf, png)",
      }),
    ),
    limit: Limit,
  },
  { $id: "AppleFilesRecentParams" },
);
export type AppleFilesRecentParams = Static<typeof AppleFilesRecentParams>;

/** `files.move` (F2): inside granted folders; an optional new name renames in the same step. */
export const AppleFilesMoveParams = Type.Object(
  {
    items: Type.Array(
      Type.Object({
        path: Type.String(),
        to: Type.String({ description: "Destination folder (granted)" }),
        name: Type.Optional(Type.String({ maxLength: 255, description: "New file name" })),
      }),
      { minItems: 1, maxItems: 100 },
    ),
  },
  { $id: "AppleFilesMoveParams" },
);
export type AppleFilesMoveParams = Static<typeof AppleFilesMoveParams>;

/** `files.rename` (F2). */
export const AppleFilesRenameParams = Type.Object(
  { path: Type.String(), name: Type.String({ minLength: 1, maxLength: 255 }) },
  { $id: "AppleFilesRenameParams" },
);
export type AppleFilesRenameParams = Static<typeof AppleFilesRenameParams>;

/** `files.trash` (F3): to the Trash (never emptied). */
export const AppleFilesTrashParams = Type.Object(
  { paths: Type.Array(Type.String(), { minItems: 1, maxItems: 200 }) },
  { $id: "AppleFilesTrashParams" },
);
export type AppleFilesTrashParams = Static<typeof AppleFilesTrashParams>;

// --- Shortcuts (K1–K2) -------------------------------------------------------------------------

/** `shortcuts.list` (K1). */
export const AppleShortcut = Type.Object(
  {
    id: Type.String({ description: "Shortcut identifier (UUID)" }),
    name: Type.String(),
    folder: Nullable(Type.String()),
    acceptsInput: Type.Boolean(),
    actionCount: Nullable(Type.Integer({ minimum: 0 })),
  },
  { $id: "AppleShortcut", description: "Listed by name." },
);
export type AppleShortcut = Static<typeof AppleShortcut>;

/** `shortcuts.run` (K2): with text input, output as text or JSON, a hard timeout. */
export const AppleShortcutsRunParams = Type.Object(
  {
    id: Type.String({ description: "From shortcuts.list" }),
    input: Type.Optional(
      Type.String({ maxLength: 100_000, description: "Text input, when it accepts input" }),
    ),
    timeoutSeconds: Type.Optional(
      Type.Integer({ minimum: 1, maximum: 120, description: "Default 60" }),
    ),
  },
  { $id: "AppleShortcutsRunParams" },
);
export type AppleShortcutsRunParams = Static<typeof AppleShortcutsRunParams>;

export const AppleShortcutResult = Type.Object(
  {
    output: Type.String({ description: "The shortcut's output as text, untrusted" }),
    outputType: StringEnum(["text", "json", "none"]),
    truncated: Type.Boolean(),
  },
  { $id: "AppleShortcutResult" },
);
export type AppleShortcutResult = Static<typeof AppleShortcutResult>;

// --- Things 3 (AppleScript reads, URL-scheme writes with the owner's auth token) ---------------

export const ThingsTodo = Type.Object(
  {
    id: Type.String(),
    title: Type.String(),
    notes: Type.String({ description: "Untrusted" }),
    status: StringEnum(["open", "completed", "canceled"]),
    when: Nullable(Type.String({ description: "today, evening, someday or YYYY-MM-DD" })),
    deadline: Nullable(Type.String({ description: "YYYY-MM-DD" })),
    project: Nullable(Type.String()),
    area: Nullable(Type.String()),
    tags: Type.Array(Type.String()),
    modified: Nullable(IsoDateTime),
  },
  { $id: "ThingsTodo" },
);
export type ThingsTodo = Static<typeof ThingsTodo>;

/** `things.list`. */
export const ThingsListParams = Type.Object(
  {
    list: StringEnum([
      "inbox",
      "today",
      "upcoming",
      "anytime",
      "someday",
      "logbook",
      "project",
      "area",
      "tag",
    ]),
    name: Type.Optional(
      Type.String({ description: "The project, area or tag (with those lists)" }),
    ),
    query: Type.Optional(
      Type.String({ maxLength: 200, description: "Text in the title or notes" }),
    ),
    limit: Limit,
  },
  { $id: "ThingsListParams", description: "Results come in the list's own order." },
);
export type ThingsListParams = Static<typeof ThingsListParams>;

const ThingsWhen = Type.String({
  pattern: "^(today|tomorrow|evening|anytime|someday|\\d{4}-\\d{2}-\\d{2})$",
  description: "today, tomorrow, evening, anytime, someday or YYYY-MM-DD",
});

/** `things.add`. */
export const ThingsAddParams = Type.Object(
  {
    title: Type.String({ minLength: 1, maxLength: 500 }),
    notes: Type.Optional(Type.String({ maxLength: 10_000 })),
    when: Type.Optional(ThingsWhen),
    deadline: Type.Optional(Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" })),
    tags: Type.Optional(Type.Array(Type.String(), { maxItems: 20 })),
    list: Type.Optional(Type.String({ description: "A project or area name (default: Inbox)" })),
    checklist: Type.Optional(Type.Array(Type.String({ maxLength: 500 }), { maxItems: 50 })),
  },
  { $id: "ThingsAddParams" },
);
export type ThingsAddParams = Static<typeof ThingsAddParams>;

/** `things.update`. */
export const ThingsUpdateParams = Type.Object(
  {
    /**
     * Things' URL-scheme auth token, filled in by the Gateway from the vault for this call
     * only (#719). Never written by the model, shown on a card, logged or stored by the helper.
     */
    authToken: Type.Optional(
      Type.String({ minLength: 1, maxLength: 200, pattern: "^[A-Za-z0-9_-]+$" }),
    ),
    id: Type.String(),
    title: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
    appendNotes: Type.Optional(Type.String({ maxLength: 10_000 })),
    when: Type.Optional(ThingsWhen),
    deadline: Type.Optional(Nullable(Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }))),
    addTags: Type.Optional(Type.Array(Type.String(), { maxItems: 20 })),
  },
  { $id: "ThingsUpdateParams" },
);
export type ThingsUpdateParams = Static<typeof ThingsUpdateParams>;

/** `things.complete`. */
export const ThingsCompleteParams = Type.Object(
  {
    /**
     * Things' URL-scheme auth token, filled in by the Gateway from the vault for this call
     * only (#719). Never written by the model, shown on a card, logged or stored by the helper.
     */
    authToken: Type.Optional(
      Type.String({ minLength: 1, maxLength: 200, pattern: "^[A-Za-z0-9_-]+$" }),
    ),
    id: Type.String(),
    status: Type.Optional(
      StringEnum(["completed", "canceled", "open"], { description: "Default completed" }),
    ),
  },
  { $id: "ThingsCompleteParams" },
);
export type ThingsCompleteParams = Static<typeof ThingsCompleteParams>;
