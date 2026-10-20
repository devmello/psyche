import { type Static, Type } from "@sinclair/typebox";
import { Id, IsoDateTime, Nullable, StringEnum } from "../common.ts";
import { defineMethod, nextCursor, OkResult, pageParams } from "./define.ts";

/**
 * `browser.*`: client-facing metadata about agent browser tabs (architecture §8). These are not
 * the agent's browser tools and not the CDP bridge (`src/bridge.ts`); they let a client list,
 * open, close and snapshot tabs. Navigation is limited to http(s); the Gateway's BrowserDriver
 * applies the task's origin policy.
 */

/** `logged-in` uses the persistent profile; `clean` a logged-out partition (architecture §8). */
export const BrowserProfile = StringEnum(["logged-in", "clean"], { $id: "BrowserProfile" });
export type BrowserProfile = Static<typeof BrowserProfile>;

/** Who drives a tab: the agent, the user (Take control) or nobody (agent paused). */
export const BrowserController = StringEnum(["agent", "user", "paused"], {
  $id: "BrowserController",
});
export type BrowserController = Static<typeof BrowserController>;

export const BrowserTab = Type.Object(
  {
    tabId: Type.String({ minLength: 1 }),
    url: Type.String(),
    title: Type.String(),
    profile: BrowserProfile,
    controller: BrowserController,
    taskId: Nullable(Id),
    driver: StringEnum(["cdp", "playwright"], { $id: "BrowserDriverKind" }),
  },
  { $id: "BrowserTab" },
);
export type BrowserTab = Static<typeof BrowserTab>;

export const BrowserSnapshot = Type.Object(
  {
    tabId: Type.String(),
    url: Type.String(),
    title: Type.String(),
    tree: Type.String({
      description: "Accessibility snapshot text with ref_N ids (untrusted content)",
    }),
    capturedAt: IsoDateTime,
  },
  { $id: "BrowserSnapshot" },
);
export type BrowserSnapshot = Static<typeof BrowserSnapshot>;

const HttpUrl = Type.String({ pattern: "^https?://", maxLength: 8192, $id: "HttpUrl" });

/**
 * Recordings (feature I10; architecture §8 "Recording"; data model §9 `kind: recording`,
 * §12 retention): per task, opt-in, under `library/recordings/<id>/`. A recording holds
 * screencast frames plus an event log of what the agent did, so Activity can scrub through
 * it. Everything in it is redacted at write time: URLs keep origin and path, snapshot text is
 * what the model saw (secure fields masked), a credential fill records the placeholder and
 * the element and never a value, and frames while a secure field is active are dropped.
 */
export const BrowserRecordingId = Type.String({
  minLength: 1,
  maxLength: 128,
  description: "Recording id: the task id, or thread:<id> for chat turns",
});

export const BrowserRecording = Type.Object(
  {
    id: BrowserRecordingId,
    taskId: Nullable(Id),
    threadId: Nullable(Id),
    startedAt: IsoDateTime,
    /** Null while the recording is live. */
    endedAt: Nullable(IsoDateTime),
    frameCount: Type.Integer({ minimum: 0 }),
    eventCount: Type.Integer({ minimum: 0 }),
    /** Bytes on disk (frames, snapshots and the index). */
    bytes: Type.Integer({ minimum: 0 }),
    /** The Library item once imported (`kind: recording`), else null. */
    libraryItemId: Nullable(Id),
  },
  { $id: "BrowserRecording" },
);
export type BrowserRecording = Static<typeof BrowserRecording>;

export const BrowserRecordingEventKind = StringEnum(
  ["tab", "navigation", "snapshot", "action", "fill", "download", "blocked", "control", "dialog"],
  { $id: "BrowserRecordingEventKind" },
);
export type BrowserRecordingEventKind = Static<typeof BrowserRecordingEventKind>;

export const BrowserRecordingEvent = Type.Object(
  {
    seq: Type.Integer({ minimum: 1 }),
    at: IsoDateTime,
    tabId: Type.String(),
    kind: BrowserRecordingEventKind,
    /** One line for the Activity list, e.g. `Clicked button "Sign in"`. */
    summary: Type.String({ maxLength: 500 }),
    /** Origin and path only, never a query string. */
    url: Type.Optional(Type.String()),
    /** Driver action (`click`, `type`, `press`, `select`, `scroll`, `fill_credential`, …). */
    action: Type.Optional(Type.String()),
    ref: Type.Optional(Type.String()),
    element: Type.Optional(Type.Object({ role: Type.String(), name: Type.String() })),
    /**
     * Redacted action details (typed text after secret masking, key chords, selected values,
     * a credential placeholder). Never a secret.
     */
    detail: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    /** `snapshot` events: the sequence number `browser.recordings.snapshot` takes. */
    snapshotSeq: Type.Optional(Type.Integer({ minimum: 1 })),
    /** The latest screencast frame at or before `at`, when one exists. */
    frameSeq: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { $id: "BrowserRecordingEvent" },
);
export type BrowserRecordingEvent = Static<typeof BrowserRecordingEvent>;

export const BrowserRecordingFrame = Type.Object(
  {
    seq: Type.Integer({ minimum: 1 }),
    at: IsoDateTime,
    tabId: Type.String(),
    url: Type.String({ description: "Origin and path only" }),
  },
  { $id: "BrowserRecordingFrame" },
);
export type BrowserRecordingFrame = Static<typeof BrowserRecordingFrame>;

export const BrowserMethods = {
  "browser.tabs": defineMethod({
    params: Type.Object({ taskId: Type.Optional(Id) }),
    result: Type.Object({ tabs: Type.Array(BrowserTab) }),
    scope: "operator.read",
    description: "Lists agent browser tabs.",
  }),
  "browser.open": defineMethod({
    params: Type.Object({
      url: HttpUrl,
      profile: Type.Optional(BrowserProfile),
      background: Type.Optional(Type.Boolean()),
    }),
    result: Type.Object({ tab: BrowserTab }),
    scope: "operator.write",
    description: "Opens a user tab in the agent browser (http and https only).",
  }),
  "browser.close": defineMethod({
    params: Type.Object({ tabId: Type.String({ minLength: 1 }) }),
    result: OkResult,
    scope: "operator.write",
    description: "Closes a tab.",
  }),
  "browser.snapshot": defineMethod({
    params: Type.Object({ tabId: Type.String({ minLength: 1 }) }),
    result: Type.Object({ snapshot: BrowserSnapshot }),
    scope: "operator.read",
    description: "Returns the accessibility snapshot of a tab. The content is untrusted page data.",
  }),
  "browser.recordings.list": defineMethod({
    params: Type.Object({
      taskId: Type.Optional(Id),
      threadId: Type.Optional(Id),
      ...pageParams,
    }),
    result: Type.Object({ recordings: Type.Array(BrowserRecording), ...nextCursor }),
    scope: "operator.read",
    description: "Lists browser recordings, newest first (feature I10).",
  }),
  "browser.recordings.get": defineMethod({
    params: Type.Object({
      recordingId: BrowserRecordingId,
      /** Events and frames after this sequence number, for a live recording. */
      sinceSeq: Type.Optional(Type.Integer({ minimum: 0 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 5000 })),
    }),
    result: Type.Object({
      recording: BrowserRecording,
      events: Type.Array(BrowserRecordingEvent),
      frames: Type.Array(BrowserRecordingFrame),
    }),
    scope: "operator.read",
    description:
      "Returns a recording's replay index: the event log and the frame list Activity scrubs through.",
  }),
  "browser.recordings.frame": defineMethod({
    params: Type.Object({ recordingId: BrowserRecordingId, seq: Type.Integer({ minimum: 1 }) }),
    result: Type.Object({
      frame: BrowserRecordingFrame,
      mime: StringEnum(["image/jpeg", "image/png"], { $id: "BrowserRecordingFrameMime" }),
      data: Type.String({ description: "Base64 image bytes" }),
    }),
    scope: "operator.read",
    description: "Returns one screencast frame of a recording.",
  }),
  "browser.recordings.snapshot": defineMethod({
    params: Type.Object({ recordingId: BrowserRecordingId, seq: Type.Integer({ minimum: 1 }) }),
    result: Type.Object({
      text: Type.String({
        description: "The snapshot text the model saw (untrusted page content)",
      }),
    }),
    scope: "operator.read",
    description: "Returns the page snapshot a `snapshot` event recorded.",
  }),
  "browser.recordings.delete": defineMethod({
    params: Type.Object({ recordingId: BrowserRecordingId }),
    result: OkResult,
    scope: "operator.write",
    sideEffecting: true,
    description:
      "Side-effecting. Deletes a recording and its files (retention is otherwise 7 days, data model §12).",
  }),
} as const;
