import { type Static, Type } from "@sinclair/typebox";
import { IsoDateTime, Nullable } from "../common.ts";

/**
 * Apple app adapters (feature J6; architecture §6, §4.9): typed shapes for the mac helper's
 * `calendar.*`, `reminders.*`, `mail.*`, `notes.*`, `finder.*` and `safari.*` node capabilities,
 * reached through `nodes.invoke` / the agent's node tools as `node.<capability>`. The Permission
 * Broker gates them through the `apple.<app>` connector action matrix (`@psyche/permissions`).
 * Everything these return from app content is `untrusted` data. Added by S14.
 */

const Limit = Type.Optional(Type.Integer({ minimum: 1, maximum: 500 }));

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
  },
  { $id: "AppleCalendarEvent" },
);
export type AppleCalendarEvent = Static<typeof AppleCalendarEvent>;

export const AppleCalendarListEventsParams = Type.Object(
  {
    from: IsoDateTime,
    to: IsoDateTime,
    calendarIds: Type.Optional(Type.Array(Type.String())),
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
  },
  { $id: "AppleReminder" },
);
export type AppleReminder = Static<typeof AppleReminder>;

export const AppleRemindersListParams = Type.Object(
  {
    listIds: Type.Optional(Type.Array(Type.String())),
    completed: Type.Optional(Type.Boolean()),
    dueBefore: Type.Optional(IsoDateTime),
    limit: Limit,
  },
  { $id: "AppleRemindersListParams" },
);
export type AppleRemindersListParams = Static<typeof AppleRemindersListParams>;

export const AppleReminderInput = Type.Object(
  {
    listId: Type.Optional(Type.String()),
    title: Type.String({ minLength: 1, maxLength: 500 }),
    notes: Type.Optional(Type.String({ maxLength: 10_000 })),
    due: Type.Optional(IsoDateTime),
    priority: Type.Optional(Type.Integer({ minimum: 0, maximum: 9 })),
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
  { id: Type.String(), folder: Type.String(), title: Type.String(), modified: IsoDateTime },
  { $id: "AppleNoteSummary" },
);
export type AppleNoteSummary = Static<typeof AppleNoteSummary>;

export const AppleNote = Type.Object(
  {
    summary: AppleNoteSummary,
    html: Type.String({ description: "Notes body HTML, untrusted" }),
    text: Type.String({ description: "Plain text of the body" }),
    truncated: Type.Boolean(),
  },
  { $id: "AppleNote" },
);
export type AppleNote = Static<typeof AppleNote>;

export const AppleNoteInput = Type.Object(
  {
    title: Type.String({ minLength: 1, maxLength: 300 }),
    body: Type.String({ maxLength: 100_000, description: "Plain text; HTML is escaped" }),
    folder: Type.Optional(Type.String({ maxLength: 200 })),
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
