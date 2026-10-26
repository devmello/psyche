import { type Static, Type } from "@sinclair/typebox";
import { Id, IsoDateTime, Nullable, StringEnum } from "../common.ts";

/**
 * The teaching loop (docs/agent/teaching-loop-2026.md, epic #676): the owner's feedback on
 * answers and actions, the lessons Psyche drew from it and where it wrote them, and the growth
 * summary built from both. Everything here is the owner's own signal: feedback is accepted only
 * from the owner (never a delegated person, a group member or content the agent read), and a
 * lesson never comes from untrusted text. Not to be confused with Teach mode (`teach.ts`), which
 * records a demonstration in a Mac app.
 */

// --- Feedback --------------------------------------------------------------------------------

/**
 * What the owner said or did. Explicit: `helpful`, `not_helpful`, `correction`. Implicit (the
 * Gateway records them where they happen; a client never claims one): a draft edited before it
 * was sent, an undo, an approval answered with a narrower scope or edited arguments, a denial,
 * a dismissal, a redo with an instruction, and Feed / Ideas feedback mirrored from their own
 * tables.
 */
export const FeedbackKind = StringEnum(
  [
    "helpful",
    "not_helpful",
    "correction",
    "undo",
    "draft_edited",
    "approval_edited",
    "approval_denied",
    "dismissed",
    "regenerated",
    "feed",
    "idea",
  ],
  { $id: "FeedbackKind" },
);
export type FeedbackKind = Static<typeof FeedbackKind>;

/** What the feedback is about. */
export const FeedbackTargetType = StringEnum(
  [
    "message",
    "tool_call",
    "task",
    "approval",
    "draft",
    "feed_post",
    "idea",
    "automation_run",
    "skill_run",
  ],
  { $id: "FeedbackTargetType" },
);
export type FeedbackTargetType = Static<typeof FeedbackTargetType>;

export const FeedbackTarget = Type.Object(
  {
    type: FeedbackTargetType,
    id: Id,
    threadId: Type.Optional(Id),
    taskId: Type.Optional(Id),
    /** Skill name, when the target ran under a skill. */
    skill: Type.Optional(Type.String({ maxLength: 128 })),
    automationId: Type.Optional(Id),
  },
  { $id: "FeedbackTarget" },
);
export type FeedbackTarget = Static<typeof FeedbackTarget>;

/** The one-tap reasons on "Not like this" (docs/agent/teaching-loop-2026.md §5.1). */
export const FeedbackReason = StringEnum(
  ["too_long", "wrong_tone", "wrong_facts", "not_what_i_asked", "should_have_asked"],
  { $id: "FeedbackReason" },
);
export type FeedbackReason = Static<typeof FeedbackReason>;

/**
 * Where a correction applies, narrowest first. `once` fixes this answer (a redo) and records the
 * feedback without making a lesson.
 */
export const FeedbackScope = StringEnum(["once", "person", "task_kind", "always"], {
  $id: "FeedbackScope",
});
export type FeedbackScope = Static<typeof FeedbackScope>;

export const FeedbackSurface = Type.String({
  maxLength: 128,
  description: '"desktop", "web" or "channel:<channelId>"',
});

/** One signal. Evidence only: it changes nothing until a lesson is made from it. */
export const FeedbackEvent = Type.Object(
  {
    id: Id,
    kind: FeedbackKind,
    target: FeedbackTarget,
    /** The owner's one-line correction or redo instruction. */
    text: Nullable(Type.String({ maxLength: 500 })),
    reason: Nullable(FeedbackReason),
    scope: Nullable(FeedbackScope),
    /**
     * For implicit kinds: e.g. `{ editDistance, beforeSha256, afterSha256 }` for a draft (never
     * the texts), the offered and chosen scope for an approval, the dismiss reason.
     */
    detail: Nullable(Type.Record(Type.String(), Type.Unknown())),
    surface: FeedbackSurface,
    /** The lesson made from it, when there is one. */
    lessonId: Nullable(Id),
    createdAt: IsoDateTime,
  },
  { $id: "FeedbackEvent" },
);
export type FeedbackEvent = Static<typeof FeedbackEvent>;

// --- Lessons ---------------------------------------------------------------------------------

/**
 * What a lesson is about. Lessons govern form and process (how Psyche writes, works, asks and
 * prioritises), never what it says is true about the world.
 */
export const LessonKind = StringEnum(
  ["style", "fact", "entity", "approach", "parameter", "boundary"],
  { $id: "LessonKind" },
);
export type LessonKind = Static<typeof LessonKind>;

/** `stated`: the owner said it. `inferred`: confirmed from implicit evidence. */
export const LessonOrigin = StringEnum(["stated", "inferred"], { $id: "LessonOrigin" });
export type LessonOrigin = Static<typeof LessonOrigin>;

export const LessonStatus = StringEnum(
  ["proposed", "active", "confirmed", "dormant", "superseded", "forgotten"],
  { $id: "LessonStatus" },
);
export type LessonStatus = Static<typeof LessonStatus>;

/** Where a lesson applies. Exactly one of the optional fields, or `global: true`. */
export const LessonScope = Type.Object(
  {
    global: Type.Optional(Type.Boolean()),
    skill: Type.Optional(Type.String({ maxLength: 128 })),
    automationId: Type.Optional(Id),
    /** A person or project in the people graph (docs/memory/people-and-projects-2026.md). */
    entityId: Type.Optional(Id),
    connector: Type.Optional(Type.String({ maxLength: 128 })),
    /** An address or handle, e.g. `jane.ortiz@example.com`. */
    recipient: Type.Optional(Type.String({ maxLength: 320 })),
    /** A kind of task, e.g. `email_draft`. */
    taskKind: Type.Optional(Type.String({ maxLength: 64 })),
  },
  { $id: "LessonScope" },
);
export type LessonScope = Static<typeof LessonScope>;

/** Where the lesson was written. Exactly one variant. */
export const LessonDestination = Type.Union(
  [
    Type.Object({
      type: Type.Literal("file"),
      /** A lesson-owned region of a workspace file. */
      path: StringEnum(["SOUL.md", "USER.md", "AGENTS.md", "MEMORY.md"]),
      section: Type.String({ maxLength: 120, description: 'e.g. "How I write for you"' }),
      /** Stable id of the line inside the section (the learned-fact id for USER.md). */
      lineId: Type.String({ maxLength: 64 }),
    }),
    Type.Object({
      type: Type.Literal("graph"),
      entityId: Id,
      attribute: Type.Optional(Type.String({ maxLength: 64 })),
      rel: Type.Optional(Type.String({ maxLength: 64 })),
      /** The fact or edge version the correction wrote (`memory.entities.history`). */
      versionId: Type.Optional(Id),
    }),
    Type.Object({
      type: Type.Literal("skill"),
      skill: Type.String({ maxLength: 128 }),
      /** `skills/<name>/LESSONS.md`. */
      path: Type.String({ maxLength: 256 }),
      lineId: Type.String({ maxLength: 64 }),
    }),
    Type.Object({
      type: Type.Literal("automation"),
      automationId: Id,
      field: Type.String({ maxLength: 64, description: 'e.g. "schedule", "delivery"' }),
    }),
  ],
  { $id: "LessonDestination" },
);
export type LessonDestination = Static<typeof LessonDestination>;

export const Lesson = Type.Object(
  {
    id: Id,
    kind: LessonKind,
    origin: LessonOrigin,
    /** The lesson in one sentence, in Psyche's words. */
    statement: Type.String({ minLength: 1, maxLength: 300 }),
    scope: LessonScope,
    destination: LessonDestination,
    /** The value or line it replaced; restored when the lesson is forgotten. */
    previous: Nullable(Type.String({ maxLength: 4000 })),
    /** The value or line as written. */
    value: Type.String({ maxLength: 4000 }),
    /** Feedback event ids it came from, oldest first. */
    sources: Type.Array(Id, { maxItems: 50 }),
    /** 0–1; shown to the owner in words (docs/agent/teaching-loop-2026.md §3.3). */
    confidence: Type.Number({ minimum: 0, maximum: 1 }),
    status: LessonStatus,
    /** How many earlier lessons on the same destination this one superseded. */
    refinedCount: Type.Integer({ minimum: 0 }),
    supersedes: Nullable(Id),
    lastAppliedAt: Nullable(IsoDateTime),
    createdAt: IsoDateTime,
    confirmedAt: Nullable(IsoDateTime),
    forgottenAt: Nullable(IsoDateTime),
  },
  { $id: "Lesson" },
);
export type Lesson = Static<typeof Lesson>;

/** A lesson as an answer cites it ("Used 2 lessons"). */
export const LessonRef = Type.Object(
  { lessonId: Id, statement: Type.String({ maxLength: 300 }), kind: LessonKind },
  { $id: "LessonRef" },
);
export type LessonRef = Static<typeof LessonRef>;

// --- Growth ----------------------------------------------------------------------------------

export const GrowthWindow = StringEnum(["7d", "30d", "all"], { $id: "GrowthWindow" });
export type GrowthWindow = Static<typeof GrowthWindow>;

export const GrowthMetricId = StringEnum(
  [
    "drafts_sent_as_is",
    "approvals_without_change",
    "task_success",
    "repeat_corrections",
    "corrections_applied",
  ],
  { $id: "GrowthMetricId" },
);
export type GrowthMetricId = Static<typeof GrowthMetricId>;

/**
 * One outcome, this window against the agent's own previous window. Rates come with their
 * counts and are null while there is not enough history (fewer than 10 events).
 */
export const GrowthMetric = Type.Object(
  {
    id: GrowthMetricId,
    /** For `task_success`: the skill it is about; absent for the overall figure. */
    skill: Type.Optional(Type.String({ maxLength: 128 })),
    count: Type.Integer({ minimum: 0 }),
    total: Type.Integer({ minimum: 0 }),
    rate: Nullable(Type.Number({ minimum: 0, maximum: 1 })),
    previousCount: Nullable(Type.Integer({ minimum: 0 })),
    previousTotal: Nullable(Type.Integer({ minimum: 0 })),
    previousRate: Nullable(Type.Number({ minimum: 0, maximum: 1 })),
    /** Lesson and feedback ids behind the number, newest first, so every figure can be opened. */
    evidence: Type.Array(Id, { maxItems: 50 }),
  },
  { $id: "GrowthMetric" },
);
export type GrowthMetric = Static<typeof GrowthMetric>;

export const MilestoneKind = StringEnum(
  [
    "first_week",
    "first_month",
    "first_lesson",
    "lessons_10",
    "tasks_100",
    "first_automation",
    "first_skill_from_routine",
  ],
  { $id: "MilestoneKind" },
);
export type MilestoneKind = Static<typeof MilestoneKind>;

/** A dated fact, not a reward. */
export const Milestone = Type.Object(
  {
    kind: MilestoneKind,
    at: IsoDateTime,
    /** What it is about, e.g. the automation's title. */
    subject: Nullable(Type.String({ maxLength: 200 })),
    ref: Nullable(Id),
  },
  { $id: "Milestone" },
);
export type Milestone = Static<typeof Milestone>;

/** One row of the Growth timeline: a lesson or a milestone. */
export const GrowthItem = Type.Union(
  [
    Type.Object({ type: Type.Literal("lesson"), at: IsoDateTime, lesson: Lesson }),
    Type.Object({ type: Type.Literal("milestone"), at: IsoDateTime, milestone: Milestone }),
  ],
  { $id: "GrowthItem" },
);
export type GrowthItem = Static<typeof GrowthItem>;

export const GrowthSummary = Type.Object(
  {
    window: GrowthWindow,
    lessons: Type.Object({
      learned: Type.Integer({ minimum: 0 }),
      refined: Type.Integer({ minimum: 0 }),
      confirmed: Type.Integer({ minimum: 0 }),
      forgotten: Type.Integer({ minimum: 0 }),
    }),
    metrics: Type.Array(GrowthMetric),
    milestones: Type.Array(Milestone),
    /** Newest first. */
    timeline: Type.Array(GrowthItem),
    /** When the first feedback event or lesson exists; null when nothing was learned yet. */
    since: Nullable(IsoDateTime),
  },
  { $id: "GrowthSummary" },
);
export type GrowthSummary = Static<typeof GrowthSummary>;

// --- The weekly "What I learned" card --------------------------------------------------------

/**
 * One item of the weekly card (a review queue): a new lesson, a question from implicit evidence,
 * a lesson proposed for retirement ("Still true?"), or a conflict dreaming found.
 */
export const GrowthCardItem = Type.Object(
  {
    type: StringEnum(["lesson", "question", "retire", "conflict"]),
    statement: Type.String({ maxLength: 300 }),
    /** The "Because:" line. */
    because: Type.String({ maxLength: 300 }),
    lessonId: Nullable(Id),
    /** Feedback ids behind a question. */
    evidence: Type.Array(Id, { maxItems: 20 }),
  },
  { $id: "GrowthCardItem" },
);
export type GrowthCardItem = Static<typeof GrowthCardItem>;

export const GrowthCard = Type.Object(
  {
    /** The Monday of the week it covers, `YYYY-MM-DD`. */
    weekOf: Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }),
    items: Type.Array(GrowthCardItem, { minItems: 1, maxItems: 7 }),
  },
  { $id: "GrowthCard" },
);
export type GrowthCard = Static<typeof GrowthCard>;

// --- Settings --------------------------------------------------------------------------------

/** The implicit signals the owner can switch off one by one (`teaching.implicit`). */
export const TeachingImplicitSignals = Type.Object(
  {
    draftEdits: Type.Boolean(),
    undo: Type.Boolean(),
    approvalEdits: Type.Boolean(),
    dismissals: Type.Boolean(),
  },
  { $id: "TeachingImplicitSignals" },
);
export type TeachingImplicitSignals = Static<typeof TeachingImplicitSignals>;

/**
 * Setting keys and defaults for the teaching loop (docs/agent/teaching-loop-2026.md §8). The keys
 * are admin-only like every memory key (`isAdminSettingKey`). `teaching.surfaces` maps a surface
 * (`chat`, `email_drafts`, `messages`, `calendar`, `feed`, `ideas`, or `connector:<id>`) to
 * whether it may teach; a missing surface is on.
 */
export const TEACHING_SETTING_DEFAULTS = {
  "teaching.enabled": true,
  "teaching.implicit": { draftEdits: true, undo: true, approvalEdits: true, dismissals: true },
  "teaching.surfaces": {} as Record<string, boolean>,
  "teaching.paused": false,
  "teaching.weeklyCard": true,
} as const;
export type TeachingSettingKey = keyof typeof TEACHING_SETTING_DEFAULTS;
