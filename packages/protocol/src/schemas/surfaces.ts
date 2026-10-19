import { type Static, Type } from "@sinclair/typebox";
import { Id, IsoDateTime, JsonObject, ModelRef, Nullable, StringEnum, Surface } from "../common.ts";

/** Data model §8 (proactive), §9 (library), §10 (usage, settings). */
export const Citation = Type.Object(
  { title: Type.String(), url: Type.String(), source: Type.Optional(Type.String()) },
  { $id: "Citation" },
);

export const FeedFeedback = StringEnum(["like", "save", "not_interested", "hide_source", "follow_topic"], {
  $id: "FeedFeedback",
});

export const FeedPost = Type.Object(
  {
    id: Id,
    title: Type.String(),
    bodyMd: Type.String(),
    citations: Type.Array(Citation),
    cluster: Nullable(JsonObject),
    score: Type.Number(),
    reasons: Type.Array(Type.String()),
    exploration: Type.Boolean({ description: "Came from an exploration slot (architecture §11)" }),
    briefingId: Nullable(Id),
    feedback: Nullable(FeedFeedback),
    createdAt: IsoDateTime,
  },
  { $id: "FeedPost" },
);
export type FeedPost = Static<typeof FeedPost>;

export const Idea = Type.Object(
  {
    id: Id,
    kind: StringEnum(["task", "automation", "skill", "goal", "connector"]),
    title: Type.String(),
    bodyMd: Type.String(),
    evidence: Type.Array(JsonObject),
    effort: Type.String(),
    acceptanceProb: Type.Number({ minimum: 0, maximum: 1 }),
    status: StringEnum(["proposed", "accepted", "edited", "dismissed", "expired"]),
    resultRef: Nullable(Type.String()),
    createdAt: IsoDateTime,
    decidedAt: Nullable(IsoDateTime),
  },
  { $id: "Idea" },
);
export type Idea = Static<typeof Idea>;

export const GoalCategory = StringEnum(
  ["health", "finance", "career", "relationships", "productivity", "learning", "home", "other"],
  { $id: "GoalCategory" },
);

export const Goal = Type.Object(
  {
    id: Id,
    title: Type.String(),
    category: GoalCategory,
    status: StringEnum(["candidate", "active", "paused", "done", "archived"]),
    inferred: Type.Boolean(),
    confirmedAt: Nullable(IsoDateTime),
    plan: Nullable(JsonObject),
    cadence: Nullable(Type.String()),
    nextCheckinAt: Nullable(IsoDateTime),
    archivedAt: Nullable(IsoDateTime),
    createdAt: IsoDateTime,
    updatedAt: IsoDateTime,
  },
  { $id: "Goal" },
);
export type Goal = Static<typeof Goal>;

export const NotificationKind = StringEnum(
  ["approval", "input_needed", "task_done", "task_failed", "proactive", "briefing", "reminder", "system"],
  { $id: "NotificationKind" },
);
export type NotificationKind = Static<typeof NotificationKind>;

export const NotificationAction = Type.Object(
  { id: Type.String(), label: Type.String(), destructive: Type.Optional(Type.Boolean()) },
  { $id: "NotificationAction" },
);

export const Notification = Type.Object(
  {
    id: Id,
    kind: NotificationKind,
    title: Type.String(),
    body: Type.String(),
    taskId: Nullable(Id),
    approvalId: Nullable(Id),
    route: Nullable(Type.String({ description: "Deep link inside the app, e.g. /tasks/<id>" })),
    actions: Type.Array(NotificationAction),
    surfaces: Type.Array(Surface),
    delivered: Type.Record(Type.String(), IsoDateTime),
    readAt: Nullable(IsoDateTime),
    resolvedAt: Nullable(IsoDateTime),
    createdAt: IsoDateTime,
  },
  { $id: "Notification" },
);
export type Notification = Static<typeof Notification>;

export const LibraryItemKind = StringEnum(
  ["document", "image", "audio", "video", "artifact", "download", "recording", "system"],
  { $id: "LibraryItemKind" },
);

export const LibraryItem = Type.Object(
  {
    id: Id,
    kind: LibraryItemKind,
    name: Type.String(),
    mime: Type.String(),
    path: Type.String({ description: "Relative to library/" }),
    size: Type.Integer({ minimum: 0 }),
    sha256: Type.String(),
    origin: StringEnum(["upload", "agent", "download", "connector", "channel"]),
    threadId: Nullable(Id),
    taskId: Nullable(Id),
    tags: Type.Array(Type.String()),
    textExtractRef: Nullable(Type.String()),
    quarantined: Type.Optional(Type.Boolean()),
    createdAt: IsoDateTime,
  },
  { $id: "LibraryItem" },
);
export type LibraryItem = Static<typeof LibraryItem>;

export const ArtifactType = StringEnum(["markdown", "html", "react", "pdf", "sheet", "itinerary", "dashboard"], {
  $id: "ArtifactType",
});

export const Artifact = Type.Object(
  {
    id: Id,
    libraryItemId: Id,
    type: ArtifactType,
    title: Type.String(),
    version: Type.Integer({ minimum: 1 }),
    nameSlug: Type.String(),
    sourceRef: Nullable(Type.String()),
    updatedAt: IsoDateTime,
  },
  { $id: "Artifact" },
);
export type Artifact = Static<typeof Artifact>;

export const UsageRecord = Type.Object(
  {
    id: Id,
    runId: Nullable(Id),
    job: Nullable(Type.String()),
    modelRef: ModelRef,
    input: Type.Integer({ minimum: 0 }),
    output: Type.Integer({ minimum: 0 }),
    cacheRead: Type.Integer({ minimum: 0 }),
    cacheWrite: Type.Integer({ minimum: 0 }),
    reasoning: Type.Integer({ minimum: 0 }),
    costUsd: Type.Number({ minimum: 0 }),
    createdAt: IsoDateTime,
  },
  { $id: "UsageRecord" },
);
export type UsageRecord = Static<typeof UsageRecord>;

/** One persisted setting (data model §10). Keys are dotted, e.g. `appearance.theme`. */
export const SettingEntry = Type.Object(
  { key: Type.String({ minLength: 1 }), value: Type.Unknown(), updatedAt: IsoDateTime },
  { $id: "SettingEntry" },
);
export type SettingEntry = Static<typeof SettingEntry>;

/** Settings as a flat key → JSON map. Security-sensitive keys need operator.admin (security §10). */
export const Settings = Type.Record(Type.String(), Type.Unknown(), { $id: "Settings" });
export type Settings = Static<typeof Settings>;

/** Setting key prefixes that require `operator.admin` plus fresh presence (security §10). */
export const ADMIN_SETTING_PREFIXES = [
  "permissions.",
  "exec.",
  "vault.",
  "devices.",
  "gateway.",
  "channels.",
] as const;
