import { type Static, Type } from "@sinclair/typebox";
import { Id, IsoDateTime, JsonObject, ModelRef, Nullable, StringEnum, Surface } from "../common.ts";
import { GrowthCard } from "./learning.ts";
import { FeedPostKind, FeedPostRefs, WorkflowCard } from "./workflows.ts";

/** Data model §8 (proactive), §9 (library), §10 (usage, settings). */
export const Citation = Type.Object(
  { title: Type.String(), url: Type.String(), source: Type.Optional(Type.String()) },
  { $id: "Citation" },
);

export const FeedFeedback = StringEnum(
  ["like", "save", "not_interested", "hide_source", "follow_topic"],
  {
    $id: "FeedFeedback",
  },
);

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
    /** What the post is; absent on older posts (clients then derive it from `reasons`). */
    kind: Type.Optional(FeedPostKind),
    /** Ids the post points at: a meeting, proposals, mail threads, a goal. */
    refs: Type.Optional(FeedPostRefs),
    /** Structured content for workflow cards (digest, meeting prep, meeting notes). */
    card: Type.Optional(WorkflowCard),
    /** Set on the weekly "What I learned" post (teaching loop §5.4): its review items. */
    growth: Type.Optional(GrowthCard),
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

/** Data model §8 `goal_milestones`. */
export const GoalMilestone = Type.Object(
  {
    id: Id,
    goalId: Id,
    title: Type.String(),
    dueAt: Nullable(IsoDateTime),
    doneAt: Nullable(IsoDateTime),
  },
  { $id: "GoalMilestone" },
);
export type GoalMilestone = Static<typeof GoalMilestone>;

/** Data model §8 `goal_links`: exactly one of the three ids is set. */
export const GoalLink = Type.Object(
  {
    goalId: Id,
    taskId: Nullable(Id),
    automationId: Nullable(Id),
    watchId: Nullable(Id),
  },
  { $id: "GoalLink" },
);
export type GoalLink = Static<typeof GoalLink>;

export const NotificationKind = StringEnum(
  [
    "approval",
    "input_needed",
    "task_done",
    "task_failed",
    "proactive",
    "briefing",
    "reminder",
    "system",
    "specialist_result",
  ],
  { $id: "NotificationKind" },
);
export type NotificationKind = Static<typeof NotificationKind>;

export const NotificationAction = Type.Object(
  {
    id: Type.String(),
    label: Type.String(),
    destructive: Type.Optional(Type.Boolean()),
    authenticationRequired: Type.Optional(
      Type.Boolean({
        description:
          "OS delivery requires device authentication (Touch ID) before the action runs; set for purchase and credential-fill approvals (security §3.5)",
      }),
    ),
  },
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
    staleAt: Type.Optional(Nullable(IsoDateTime)),
    staleReason: Type.Optional(
      Nullable(
        Type.String({
          description:
            "Why restart reconciliation marked the notification stale (architecture §4.12)",
        }),
      ),
    ),
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

export const ArtifactType = StringEnum(
  ["markdown", "html", "react", "pdf", "sheet", "itinerary", "dashboard"],
  {
    $id: "ArtifactType",
  },
);

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

/**
 * Setting roots named by security §10 as admin-only. Kept for reference and older callers; the
 * check itself is now an allowlist (`USER_SETTING_PREFIXES`), so a root missing from this list is
 * still admin-only.
 */
export const ADMIN_SETTING_ROOTS = [
  "permissions",
  "exec",
  "vault",
  "devices",
  "gateway",
  "channels",
  "grants",
  "approvals",
] as const;

/**
 * The only settings an `operator.write` device may change without `operator.admin`: cosmetic and
 * per-client preferences. Every other key (owner identity, sessions, MCP, connectors, skills,
 * plugins, models, updates, browser, VM, memory, backup, and roots nobody has named yet) is
 * admin-only (S23 review PR-1-C). A prefix matches whole dotted segments, case-insensitively:
 * `appearance` matches `appearance` and `Appearance.theme`, not `appearancex`.
 */
export const USER_SETTING_PREFIXES = [
  "appearance",
  "ui",
  "editor",
  "shortcuts",
  "locale",
  "notifications.sound",
  "notifications.badges",
] as const;

export function isUserSettingKey(key: string): boolean {
  const segments = key.toLowerCase().split(".");
  return USER_SETTING_PREFIXES.some((prefix) => {
    const want = prefix.split(".");
    return want.length <= segments.length && want.every((part, i) => segments[i] === part);
  });
}

/** `true` unless the key is on the cosmetic allowlist (`USER_SETTING_PREFIXES`). */
export function isAdminSettingKey(key: string): boolean {
  return !isUserSettingKey(key);
}
