import { type Static, Type } from "@sinclair/typebox";
import { Id, IsoDateTime, JsonObject, Nullable, Provenance, StringEnum } from "../common.ts";
import { GraphLoop } from "./graph.ts";
import { TaintSource } from "./permissions.ts";

/**
 * Mail and meeting workflows (docs/workflows/mail-and-meetings-2026.md; S15, #669 / #670).
 * Batch proposals (§8.1), event triggers (§4.7, §8.2), and the record shapes the digest,
 * follow-up, prep and meeting-notes cards render (§4, §7.1). Everything here is additive.
 */

// --- batch proposals (§8.1) ------------------------------------------------------------------

/** One exact tool call inside a proposal; the batch approval binds the ordered list of these. */
export const ActionCall = Type.Object(
  {
    tool: Type.String({ minLength: 1, maxLength: 128, description: "Model-facing tool name" }),
    params: JsonObject,
    summary: Type.String({
      maxLength: 300,
      description: "One line in plain words for the card, e.g. 'Mark read: Weekly digest (Acme)'",
    }),
  },
  { $id: "ActionCall" },
);
export type ActionCall = Static<typeof ActionCall>;

export const ActionProposalStatus = StringEnum(
  ["pending", "awaiting_approval", "running", "done", "partial", "failed", "dismissed", "expired"],
  { $id: "ActionProposalStatus" },
);
export type ActionProposalStatus = Static<typeof ActionProposalStatus>;

/** Per-call outcome once a proposal ran (the card's step log, §7.2). */
export const ActionCallResult = Type.Object(
  {
    index: Type.Integer({ minimum: 0 }),
    status: StringEnum(["ok", "failed", "skipped"]),
    error: Type.Optional(Type.String({ maxLength: 300 })),
    receiptId: Type.Optional(Id),
  },
  { $id: "ActionCallResult" },
);
export type ActionCallResult = Static<typeof ActionCallResult>;

/**
 * A listed set of exact tool calls approved with one tap (spec §8.1). Every call's effective
 * side effect is `write`: no `destructive` or `financial` calls, no `send_email`, at most 100
 * calls. One approval of kind `batch` binds the ordered list; it is consumed once.
 */
export const ActionProposal = Type.Object(
  {
    id: Id,
    title: Type.String({ minLength: 1, maxLength: 200 }),
    calls: Type.Array(ActionCall, { minItems: 1, maxItems: 100 }),
    sideEffect: Type.Literal("write"),
    status: ActionProposalStatus,
    createdBy: Type.Object({
      job: Type.String({ description: "e.g. mail.digest, meetings.notes" }),
      runId: Type.Optional(Id),
      automationId: Type.Optional(Id),
    }),
    /** The Feed post the proposal belongs to, when it is on a card. */
    postId: Nullable(Id),
    /** The batch approval once requested (`proposals.approve`). */
    approvalId: Nullable(Id),
    /** The proposal was built from untrusted content (mail, invitations, transcripts). */
    taint: Type.Boolean(),
    taintSources: Type.Optional(Type.Array(TaintSource)),
    /** Per-call outcomes once it ran. */
    results: Type.Optional(Type.Array(ActionCallResult)),
    /** The inverse proposal that undoes this one (reversible mail tools only), once offered. */
    undoOf: Type.Optional(Nullable(Id)),
    createdAt: IsoDateTime,
    expiresAt: IsoDateTime,
    updatedAt: IsoDateTime,
  },
  { $id: "ActionProposal" },
);
export type ActionProposal = Static<typeof ActionProposal>;

// --- event triggers (§4.7, §8.2) ---------------------------------------------------------------

export const WorkflowEventSource = StringEnum(
  ["mail.received", "calendar.changed", "recording.added", "followup.due"],
  { $id: "WorkflowEventSource" },
);
export type WorkflowEventSource = Static<typeof WorkflowEventSource>;

/** A typed filter, never code. Every field narrows; an empty filter matches every event. */
export const WorkflowEventFilter = Type.Object(
  {
    accounts: Type.Optional(Type.Array(Type.String(), { maxItems: 20 })),
    fromContains: Type.Optional(Type.String({ maxLength: 200 })),
    mailbox: Type.Optional(Type.String({ maxLength: 200 })),
    calendarIds: Type.Optional(Type.Array(Type.String(), { maxItems: 50 })),
    folder: Type.Optional(
      Type.String({ maxLength: 1024, description: "recording.added: a granted folder" }),
    ),
  },
  { $id: "WorkflowEventFilter" },
);
export type WorkflowEventFilter = Static<typeof WorkflowEventFilter>;

/** `Automation.trigger` for `kind: "event"` automations. */
export const AutomationTrigger = Type.Object(
  {
    type: Type.Literal("event"),
    source: WorkflowEventSource,
    filter: Type.Optional(WorkflowEventFilter),
    debounceMs: Type.Optional(
      Type.Integer({
        minimum: 0,
        maximum: 3_600_000,
        description: "Events within this window fold into one run (default 120000)",
      }),
    ),
    maxRunsPerDay: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 288,
        description: "Beyond it runs are skipped (default 24)",
      }),
    ),
  },
  { $id: "AutomationTrigger" },
);
export type AutomationTrigger = Static<typeof AutomationTrigger>;

/** One event a run was started for (its subject and sender are untrusted). */
export const WorkflowEvent = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 256, description: "Source id: the dedupe key" }),
    source: WorkflowEventSource,
    at: IsoDateTime,
    account: Type.Optional(Type.String()),
    messageId: Type.Optional(Type.String()),
    threadId: Type.Optional(Type.String()),
    calendarEventId: Type.Optional(Type.String()),
    path: Type.Optional(Type.String()),
    from: Type.Optional(Type.String({ maxLength: 320 })),
    subject: Type.Optional(Type.String({ maxLength: 500 })),
  },
  { $id: "WorkflowEvent" },
);
export type WorkflowEvent = Static<typeof WorkflowEvent>;

// --- record shapes the cards render (§4, §7.1) --------------------------------------------------

/** A mail thread on any account (Apple Mail, Gmail, IMAP / JMAP). */
export const MailThreadRef = Type.Object(
  {
    account: Type.String(),
    threadId: Type.String(),
    messageId: Type.Optional(Type.String()),
    /** `message://…` (Apple Mail) or the web URL (Gmail), to open the thread. */
    link: Type.Optional(Type.String()),
    subject: Type.Optional(Type.String({ maxLength: 500 })),
    from: Type.Optional(Type.String({ maxLength: 320 })),
    at: Type.Optional(IsoDateTime),
  },
  { $id: "MailThreadRef" },
);
export type MailThreadRef = Static<typeof MailThreadRef>;

export const DigestCategory = StringEnum(
  ["needs_you", "soon", "fyi", "newsletters", "notifications", "screen", "unverified"],
  { $id: "DigestCategory" },
);
export type DigestCategory = Static<typeof DigestCategory>;

export const DigestAction = StringEnum(
  [
    "draft_reply",
    "remind",
    "propose_times",
    "mark_read",
    "move",
    "archive",
    "save_attachment",
    "allow_sender",
    "not_now",
    "always_archive",
    "open",
  ],
  { $id: "DigestAction" },
);
export type DigestAction = Static<typeof DigestAction>;

export const DigestItem = Type.Object(
  {
    thread: MailThreadRef,
    category: DigestCategory,
    summary: Type.String({ maxLength: 300 }),
    /** The phrase or header that decided the category ("Because:"); required for needs_you. */
    because: Type.Optional(Type.String({ maxLength: 200 })),
    actions: Type.Array(DigestAction),
  },
  { $id: "DigestItem" },
);
export type DigestItem = Static<typeof DigestItem>;

export const DigestGroup = Type.Object(
  {
    category: DigestCategory,
    count: Type.Integer({ minimum: 0 }),
    title: Type.String({ maxLength: 200, description: "e.g. '12 newsletters'" }),
    /** The batch that "Do it" approves, when the group has one. */
    proposalId: Nullable(Id),
  },
  { $id: "DigestGroup" },
);
export type DigestGroup = Static<typeof DigestGroup>;

/**
 * Follow-ups are the memory graph's open loops (`GraphLoop`, `memory.loops.*`; docs/memory/
 * people-and-projects-2026.md §4.6). The digest shows the due `waiting_on` ones; how often a
 * loop was shown in a digest is the digest's own state (`DigestLoop.shownCount`).
 */
export const DigestLoop = Type.Object(
  {
    loop: GraphLoop,
    /** The counterpart's display name, resolved for the card. */
    counterpart: Type.Optional(Type.String({ maxLength: 200 })),
    thread: Type.Optional(MailThreadRef),
    /** Digests that showed it, this one included (at most twice, then it goes quiet). */
    shownCount: Type.Integer({ minimum: 1 }),
  },
  { $id: "DigestLoop" },
);
export type DigestLoop = Static<typeof DigestLoop>;

/** The daily digest card's content (§4.1, §7.1). */
export const InboxDigest = Type.Object(
  {
    id: Id,
    createdAt: IsoDateTime,
    since: IsoDateTime,
    until: IsoDateTime,
    accounts: Type.Array(Type.String()),
    counts: Type.Record(Type.String(), Type.Integer({ minimum: 0 }), {
      description: "Messages per DigestCategory",
    }),
    needsYou: Type.Array(DigestItem),
    groups: Type.Array(DigestGroup),
    waitingOn: Type.Array(DigestLoop),
    screen: Type.Array(DigestItem),
    unverified: Type.Array(DigestItem),
    taint: Type.Boolean({
      description: "Built from untrusted mail (always true when mail was read)",
    }),
    /** The configured model was remote for at least one step (the card's "cloud" chip). */
    usedCloudModel: Type.Optional(Type.Boolean()),
  },
  { $id: "InboxDigest" },
);
export type InboxDigest = Static<typeof InboxDigest>;

/** A line of a prep note or of meeting notes, with where it came from. */
export const SourcedLine = Type.Object(
  {
    text: Type.String({ maxLength: 500 }),
    /** A thread, note, loop, Library item or URL the line is based on. */
    source: Type.Optional(
      Type.Object({
        kind: StringEnum(["thread", "note", "loop", "library", "url", "event", "meeting"]),
        ref: Type.String(),
        label: Type.Optional(Type.String({ maxLength: 200 })),
      }),
    ),
  },
  { $id: "SourcedLine" },
);
export type SourcedLine = Static<typeof SourcedLine>;

export const MeetingAttendee = Type.Object(
  {
    email: Type.String({ maxLength: 320 }),
    name: Type.Optional(Type.String({ maxLength: 200 })),
    personId: Type.Optional(Id),
    relationship: Type.Optional(
      StringEnum(["family", "friend", "colleague", "external", "unknown"]),
    ),
    summary: Type.Optional(Type.String({ maxLength: 300, description: "One line: who they are" })),
  },
  { $id: "MeetingAttendee" },
);
export type MeetingAttendee = Static<typeof MeetingAttendee>;

/** The prep note before a meeting (§4.5); at most 8 bullets across the sections. */
export const MeetingPrep = Type.Object(
  {
    meetingId: Type.String({ description: "The calendar event id" }),
    calendarId: Type.Optional(Type.String()),
    title: Type.String({ maxLength: 300 }),
    startAt: IsoDateTime,
    endAt: Type.Optional(IsoDateTime),
    joinUrl: Type.Optional(Type.String()),
    attendees: Type.Array(MeetingAttendee),
    why: Type.Optional(SourcedLine),
    openLoops: Type.Array(GraphLoop),
    lastTime: Type.Array(SourcedLine),
    worthReading: Type.Array(SourcedLine, { maxItems: 3 }),
    agenda: Type.Array(Type.String({ maxLength: 200 }), { maxItems: 4 }),
    taint: Type.Boolean(),
  },
  { $id: "MeetingPrep" },
);
export type MeetingPrep = Static<typeof MeetingPrep>;

export const MeetingActionItem = Type.Object(
  {
    text: Type.String({ maxLength: 500 }),
    /** `owner` = the Psyche owner; a name when the transcript says so; null when unclear. */
    owner: Nullable(Type.String({ maxLength: 200 })),
    dueAt: Type.Optional(Nullable(IsoDateTime)),
    quote: Type.Optional(Type.String({ maxLength: 200 })),
    atMs: Type.Optional(Type.Integer({ minimum: 0, description: "Offset into the recording" })),
    /** The proposal that would create it (owner's items), or the graph loop it became (others'). */
    proposalId: Type.Optional(Nullable(Id)),
    loopId: Type.Optional(Nullable(Id)),
  },
  { $id: "MeetingActionItem" },
);
export type MeetingActionItem = Static<typeof MeetingActionItem>;

/** Notes from a recording (§4.6): labelled AI-written, private to the owner by default. */
export const MeetingNotes = Type.Object(
  {
    id: Id,
    meetingId: Nullable(Type.String()),
    title: Type.String({ maxLength: 300 }),
    startedAt: IsoDateTime,
    durationMs: Type.Integer({ minimum: 0 }),
    recordingItemId: Nullable(Id),
    transcriptItemId: Nullable(Id),
    summary: Type.Array(Type.String({ maxLength: 500 }), { maxItems: 5 }),
    decisions: Type.Array(
      Type.Object({
        text: Type.String({ maxLength: 500 }),
        quote: Type.Optional(Type.String({ maxLength: 200 })),
        atMs: Type.Optional(Type.Integer({ minimum: 0 })),
      }),
    ),
    actionItems: Type.Array(MeetingActionItem),
    openQuestions: Type.Array(Type.String({ maxLength: 500 })),
    model: Type.Object({
      role: StringEnum(["primary", "utility", "local"]),
      remote: Type.Boolean(),
    }),
    provenance: Provenance,
  },
  { $id: "MeetingNotes" },
);
export type MeetingNotes = Static<typeof MeetingNotes>;

/** The structured content of a workflow Feed post, by kind (§8.5). */
export const WorkflowCard = Type.Union(
  [
    Type.Object({ type: Type.Literal("digest"), digest: InboxDigest }),
    Type.Object({ type: Type.Literal("meeting_prep"), prep: MeetingPrep }),
    Type.Object({ type: Type.Literal("meeting_notes"), notes: MeetingNotes }),
  ],
  { $id: "WorkflowCard" },
);
export type WorkflowCard = Static<typeof WorkflowCard>;

export const FeedPostKind = StringEnum(
  [
    "brief",
    "briefing",
    "digest",
    "meeting_prep",
    "meeting_notes",
    "watch",
    "reminder",
    "suggestion",
    "news",
    "exploration",
  ],
  { $id: "FeedPostKind" },
);
export type FeedPostKind = Static<typeof FeedPostKind>;

/** Ids a workflow post points at (§8.5). */
export const FeedPostRefs = Type.Object(
  {
    meetingId: Type.Optional(Type.String()),
    proposalIds: Type.Optional(Type.Array(Id)),
    threads: Type.Optional(Type.Array(MailThreadRef)),
    goalId: Type.Optional(Id),
  },
  { $id: "FeedPostRefs" },
);
export type FeedPostRefs = Static<typeof FeedPostRefs>;
