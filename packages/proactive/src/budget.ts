/**
 * The proactivity budget (architecture §2 principle 10, §4.11; ADR-012; feature O2, O5, O7, O9).
 * Every proactive producer in this package reads its bound from here, so the limits are in one
 * place and the audit test (`test/budget.test.ts`) can check each producer against them.
 */
export const PROACTIVITY_BUDGET = {
  heartbeat: {
    /** O2: "Heartbeat costs under 5k tokens per run" (input + output per turn). */
    maxTokens: 5_000,
    maxSteps: 6,
    maxWallMs: 120_000,
    /** At most one notification per run; `NO_REPLY` raises none (architecture §4.11). */
    notificationsPerRun: 1,
  },
  brief: {
    /** The daily brief is 5–10 posts (architecture §4.11, UI §3.9). */
    minPosts: 5,
    maxPosts: 10,
    /** One or two exploration slots per batch. */
    explorationSlots: { min: 1, max: 2 },
    /** A briefing (user-defined) is capped the same way. */
    maxBriefingPosts: 10,
  },
  ideas: {
    /** Ideas per delivery window (batched, never real-time; ADR-012). */
    perWindow: 5,
    /** Below this learned acceptance probability an idea is not delivered. */
    minAcceptanceProb: 0.3,
    /** Proposed ideas expire after this many days without a decision. */
    expiryDays: 14,
  },
  mail: {
    /** One digest notification a day (spec §3 rule 5). */
    digestNotificationsPerDay: 1,
    /** Unread messages one digest reads, at most. */
    maxMessages: 200,
    /** Message bodies read for the classifier, at most (the rest go by headers). */
    maxBodyReads: 60,
    /** A waiting-on loop is shown in at most this many digests, then it goes quiet. */
    nudgeShowMax: 2,
  },
  goals: {
    /** Inferred candidates waiting for a decision at any time (confirm cards, UI §3.11). */
    maxOpenCandidates: 3,
    /** A check-in run raises at most one `reminder` notification. */
    notificationsPerCheckin: 1,
  },
} as const;

export type ProactivityBudget = typeof PROACTIVITY_BUDGET;

/** The task budget a heartbeat run gets (`createTaskLauncher({ budget })`, O2). */
export const HEARTBEAT_TASK_BUDGET = {
  maxTokens: PROACTIVITY_BUDGET.heartbeat.maxTokens,
  maxSteps: PROACTIVITY_BUDGET.heartbeat.maxSteps,
  maxWallMs: PROACTIVITY_BUDGET.heartbeat.maxWallMs,
} as const;
