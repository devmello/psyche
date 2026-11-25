import { type Static, Type } from "@sinclair/typebox";
import { Id, IsoDateTime, Nullable, Provenance, StringEnum } from "../common.ts";
import { GraphLoopStatus } from "./graph.ts";

/**
 * The promise ledger (docs/design/promise-ledger-2026.md). `graph_loops` is the ledger: a
 * `PromiseView` is a loop plus the ledger fields, the computed `state` and, for the desktop shell
 * only, the citations and events. Every promise text, name and quote is untrusted third-party text
 * unless its provenance says `owner`. A remote caller gets the scrubbed form (§7.2): no quotes,
 * no `counterpartId`, no citations, and a promise with any Messages citation is not returned at
 * all (only `hiddenCount`).
 */

/** What the promise is: a pledge, an ask that got no answer, or a request. */
export const PromiseBasis = StringEnum(["promise", "ask", "request"], { $id: "PromiseBasis" });
export type PromiseBasis = Static<typeof PromiseBasis>;

/** The kind of thing promised; decides how done is detected (§4.2). */
export const PromiseAction = StringEnum(["send", "reply", "meet", "do"], {
  $id: "PromiseAction",
});
export type PromiseAction = Static<typeof PromiseAction>;

export const PromiseDueKind = StringEnum(["explicit", "inferred", "none"], {
  $id: "PromiseDueKind",
});
export type PromiseDueKind = Static<typeof PromiseDueKind>;

export const PromiseSourceKind = StringEnum(["mail", "messages", "meeting", "chat", "manual"], {
  $id: "PromiseSourceKind",
});
export type PromiseSourceKind = Static<typeof PromiseSourceKind>;

/** The stored states plus the computed `due_soon` (§4.1). */
export const PromiseState = StringEnum(
  ["suggested", "open", "due_soon", "snoozed", "broken", "done", "released", "dismissed"],
  { $id: "PromiseState" },
);
export type PromiseState = Static<typeof PromiseState>;

export const PromiseListView = StringEnum(["yours", "theirs", "confirm", "closed", "all"], {
  $id: "PromiseListView",
});
export type PromiseListView = Static<typeof PromiseListView>;

/** One source that mentions a promise. Desktop shell only; the quote is untrusted. */
export const PromiseCitation = Type.Object(
  {
    id: Id,
    source: StringEnum(["mail", "messages", "notes", "chats", "transcripts"], {
      $id: "PromiseCitationSource",
    }),
    quote: Type.String({ maxLength: 200 }),
    sourceRef: Type.String({ maxLength: 1000 }),
    observedAt: IsoDateTime,
    provenance: Provenance,
  },
  { $id: "PromiseCitation" },
);
export type PromiseCitation = Static<typeof PromiseCitation>;

export const PromiseEventKind = StringEnum(
  [
    "created",
    "confirmed",
    "source_added",
    "due_changed",
    "due_proposed",
    "status",
    "warned",
    "asked",
    "nudge_drafted",
    "nudge_sent",
    "auto_done",
    "undo",
  ],
  { $id: "PromiseEventKind" },
);
export type PromiseEventKind = Static<typeof PromiseEventKind>;

export const PromiseEventBy = StringEnum(["owner", "auto", "model", "rule"], {
  $id: "PromiseEventBy",
});
export type PromiseEventBy = Static<typeof PromiseEventBy>;

/** One row of a promise's history (desktop shell only). */
export const PromiseEvent = Type.Object(
  {
    id: Id,
    at: IsoDateTime,
    kind: PromiseEventKind,
    from: Nullable(Type.String({ maxLength: 200 })),
    to: Nullable(Type.String({ maxLength: 200 })),
    by: PromiseEventBy,
    citationId: Nullable(Id),
  },
  { $id: "PromiseEvent" },
);
export type PromiseEvent = Static<typeof PromiseEvent>;

/**
 * A promise as a client sees it. The optional fields are the ones the remote-viewer scrub removes
 * (§7.2); a viewer treats a missing one as hidden, never as empty.
 */
export const PromiseView = Type.Object(
  {
    id: Id,
    direction: StringEnum(["i_owe", "waiting_on"], { $id: "PromiseDirection" }),
    /** What was promised: at most 120 characters, owner-written or confirmed. */
    what: Type.String({ maxLength: 200 }),
    status: GraphLoopStatus,
    /** The stored status, or `due_soon` while an open promise is within its warning window. */
    state: PromiseState,
    basis: PromiseBasis,
    whatAction: Nullable(PromiseAction),
    /** The name as written in the source (a mail header, a meeting); third-party text. */
    counterpartLabel: Nullable(Type.String({ maxLength: 200 })),
    counterpartId: Type.Optional(Nullable(Id)),
    projectId: Type.Optional(Nullable(Id)),
    dueAt: Nullable(IsoDateTime),
    dueText: Nullable(Type.String({ maxLength: 120 })),
    dueKind: PromiseDueKind,
    dueConfidence: Nullable(Type.Number({ minimum: 0, maximum: 1 })),
    proposedDueAt: Nullable(IsoDateTime),
    snoozedUntil: Nullable(IsoDateTime),
    brokenAt: Nullable(IsoDateTime),
    warnedAt: Nullable(IsoDateTime),
    nudgeCount: Type.Integer({ minimum: 0 }),
    lastNudgeAt: Nullable(IsoDateTime),
    sourceKind: Nullable(PromiseSourceKind),
    /** A deep link back to the source (a mail thread); never set for Messages. */
    link: Type.Optional(Type.String({ maxLength: 1000 })),
    provenance: Provenance,
    confidence: Type.Number({ minimum: 0, maximum: 1 }),
    createdAt: IsoDateTime,
    closedAt: Nullable(IsoDateTime),
    closedBy: Nullable(
      StringEnum(["owner", "reply_seen", "due_passed", "auto", "aged_out", "released"], {
        $id: "PromiseClosedBy",
      }),
    ),
    /** Desktop shell only. */
    citations: Type.Optional(Type.Array(PromiseCitation, { maxItems: 20 })),
    events: Type.Optional(Type.Array(PromiseEvent, { maxItems: 200 })),
  },
  { $id: "PromiseView" },
);
export type PromiseView = Static<typeof PromiseView>;

/** What the owner can do to one promise (`promises.act`). */
export const PromiseActAction = Type.Union(
  [
    Type.Object({ type: Type.Literal("confirm") }),
    Type.Object({ type: Type.Literal("not_promise") }),
    Type.Object({ type: Type.Literal("done") }),
    Type.Object({ type: Type.Literal("reopen") }),
    Type.Object({ type: Type.Literal("release") }),
    Type.Object({ type: Type.Literal("dismiss") }),
    Type.Object({ type: Type.Literal("snooze"), until: IsoDateTime }),
    Type.Object({ type: Type.Literal("set_due"), dueAt: Nullable(IsoDateTime) }),
    Type.Object({
      type: Type.Literal("more_time"),
      days: Type.Integer({ minimum: 1, maximum: 60 }),
    }),
    Type.Object({ type: Type.Literal("accept_proposed") }),
    Type.Object({ type: Type.Literal("reject_proposed") }),
    Type.Object({ type: Type.Literal("answer"), answer: StringEnum(["yes", "not_yet"]) }),
  ],
  { $id: "PromiseActAction" },
);
export type PromiseActAction = Static<typeof PromiseActAction>;

/** A promise the owner's device should warn about, with quiet hours already applied (§6.2). */
export const PromiseUpcoming = Type.Object(
  {
    id: Id,
    warnAt: IsoDateTime,
    /** Scrubbed for remote callers: a Messages-sourced promise never reaches them. */
    title: Type.String({ maxLength: 200 }),
  },
  { $id: "PromiseUpcoming" },
);
export type PromiseUpcoming = Static<typeof PromiseUpcoming>;

export const PromiseSummary = Type.Object(
  {
    enabled: Type.Boolean(),
    yours: Type.Integer({ minimum: 0 }),
    theirs: Type.Integer({ minimum: 0 }),
    toConfirm: Type.Integer({ minimum: 0 }),
    dueSoon: Type.Integer({ minimum: 0 }),
    missed: Type.Integer({ minimum: 0 }),
    late: Type.Integer({ minimum: 0 }),
    nextDueAt: Nullable(IsoDateTime),
    /** Promises this caller may not see (Messages-sourced, for a remote caller); counted only. */
    hiddenCount: Type.Integer({ minimum: 0 }),
    upcoming: Type.Array(PromiseUpcoming, { maxItems: 50 }),
  },
  { $id: "PromiseSummary" },
);
export type PromiseSummary = Static<typeof PromiseSummary>;
