import type { FeedbackEvent, FeedPost, Lesson, Milestone } from "@psyche/protocol";
import { ago, IDS } from "./ids.ts";

/**
 * The teaching loop's fixture world (docs/agent/teaching-loop-2026.md, T0 #678): a week of the
 * owner's feedback, the lessons Psyche drew from it (stated and inferred, one refined twice, one
 * forgotten), milestones, and the weekly "What I learned" post. For T2's stories and tests.
 */

export const LEARNING_IDS = {
  feedback: {
    shorter: "fb_shorter",
    janeTone: "fb_jane_tone",
    mailFirst: "fb_mail_first",
    briefTime: "fb_brief_time",
    draftEdit1: "fb_draft_edit_1",
    draftEdit2: "fb_draft_edit_2",
    draftEdit3: "fb_draft_edit_3",
    helpful: "fb_helpful",
  },
  lessons: {
    answerFirst: "ls_answer_first",
    answerFirstOld: "ls_answer_first_v1",
    janeShort: "ls_jane_short",
    mailFirst: "ls_mail_first",
    briefTime: "ls_brief_time",
    forgotten: "ls_forgotten_emoji",
  },
  growthPost: "feed_growth_week",
} as const;

const F = LEARNING_IDS.feedback;
const L = LEARNING_IDS.lessons;

function event(
  id: string,
  kind: FeedbackEvent["kind"],
  minutesAgo: number,
  fields: Partial<FeedbackEvent> = {},
): FeedbackEvent {
  return {
    id,
    kind,
    target: { type: "message", id: IDS.messages.mainAgent, threadId: IDS.threads.main },
    text: null,
    reason: null,
    scope: null,
    detail: null,
    surface: "desktop",
    lessonId: null,
    createdAt: ago(minutesAgo),
    ...fields,
  };
}

export function feedbackEvents(): FeedbackEvent[] {
  return [
    event(F.helpful, "helpful", 30),
    event(F.janeTone, "correction", 60 * 26, {
      target: { type: "draft", id: "draft_jane_1", threadId: IDS.threads.dentist },
      text: "To Jane, just 'Hi Jane' and the answer.",
      reason: "wrong_tone",
      scope: "person",
      lessonId: L.janeShort,
    }),
    event(F.mailFirst, "correction", 60 * 50, {
      target: {
        type: "tool_call",
        id: "tc_web_receipt",
        threadId: IDS.threads.main,
        skill: "inbox-triage",
      },
      text: "Search my Mail before the web for receipts.",
      reason: "not_what_i_asked",
      scope: "task_kind",
      lessonId: L.mailFirst,
    }),
    event(F.briefTime, "correction", 60 * 74, {
      target: {
        type: "automation_run",
        id: "run_brief_1017",
        automationId: IDS.automations.morningBrief,
      },
      text: "Make the brief 7:30, and skip weekends.",
      scope: "always",
      lessonId: L.briefTime,
    }),
    event(F.shorter, "not_helpful", 60 * 24 * 5, {
      reason: "too_long",
      scope: "always",
      text: "Shorter. Answer first.",
      lessonId: L.answerFirst,
    }),
    ...[F.draftEdit1, F.draftEdit2, F.draftEdit3].map((id, i) =>
      event(id, "draft_edited", 60 * 24 * (2 + i), {
        target: { type: "draft", id: `draft_lisbon_${i}`, threadId: IDS.threads.lisbon },
        detail: { editDistance: 0.34 + i * 0.03 },
      }),
    ),
  ];
}

function lesson(fields: Partial<Lesson> & Pick<Lesson, "id" | "statement" | "value">): Lesson {
  return {
    kind: "style",
    origin: "stated",
    scope: { global: true },
    destination: { type: "file", path: "SOUL.md", section: "How I write for you", lineId: "l1" },
    previous: null,
    sources: [],
    confidence: 0.9,
    status: "active",
    refinedCount: 0,
    supersedes: null,
    lastAppliedAt: ago(20),
    createdAt: ago(60),
    confirmedAt: null,
    forgottenAt: null,
    ...fields,
  };
}

export function lessons(): Lesson[] {
  return [
    lesson({
      id: L.janeShort,
      kind: "style",
      statement: "Replies to Jane are short and start with the answer.",
      scope: { recipient: "jane.ortiz@example.com" },
      destination: {
        type: "file",
        path: "USER.md",
        section: "Preferences",
        lineId: "lf_janeshort",
      },
      value: '- Jane Ortiz (jane.ortiz@example.com): open with "Hi Jane", answer first, two lines.',
      sources: [F.janeTone],
      confidence: 0.9,
      createdAt: ago(60 * 26),
    }),
    lesson({
      id: L.mailFirst,
      kind: "approach",
      statement: "For receipts, search Mail before the web.",
      scope: { skill: "inbox-triage" },
      destination: {
        type: "skill",
        skill: "inbox-triage",
        path: "skills/inbox-triage/LESSONS.md",
        lineId: "l1",
      },
      value: "- Receipts: search Mail (mail_search) before the web.",
      sources: [F.mailFirst],
      createdAt: ago(60 * 50),
      lastAppliedAt: ago(60 * 3),
    }),
    lesson({
      id: L.briefTime,
      kind: "parameter",
      statement: "The morning brief runs at 7:30 on weekdays.",
      scope: { automationId: IDS.automations.morningBrief },
      destination: {
        type: "automation",
        automationId: IDS.automations.morningBrief,
        field: "schedule",
      },
      previous: "0 7 * * *",
      value: "30 7 * * 1-5",
      sources: [F.briefTime],
      status: "confirmed",
      confidence: 1,
      confirmedAt: ago(60 * 70),
      createdAt: ago(60 * 74),
    }),
    lesson({
      id: L.answerFirst,
      kind: "style",
      statement: "Keep replies short and give the answer first.",
      previous: "- Explain the reasoning, then the answer.",
      value: "- Short replies. The answer first, then one line of why.",
      sources: [F.shorter],
      refinedCount: 2,
      supersedes: L.answerFirstOld,
      confidence: 0.6,
      createdAt: ago(60 * 24 * 5),
    }),
    lesson({
      id: L.answerFirstOld,
      kind: "style",
      statement: "Explain the reasoning, then the answer.",
      value: "- Explain the reasoning, then the answer.",
      status: "superseded",
      createdAt: ago(60 * 24 * 12),
      lastAppliedAt: ago(60 * 24 * 6),
    }),
    lesson({
      id: L.forgotten,
      kind: "style",
      statement: "Use emoji in replies.",
      value: "",
      status: "forgotten",
      forgottenAt: ago(60 * 24 * 3),
      createdAt: ago(60 * 24 * 9),
    }),
  ];
}

export function milestones(): Milestone[] {
  return [
    {
      kind: "first_automation",
      at: ago(60 * 24 * 2),
      subject: "Morning brief",
      ref: IDS.automations.morningBrief,
    },
    { kind: "first_lesson", at: ago(60 * 24 * 12), subject: null, ref: L.answerFirstOld },
    { kind: "first_week", at: ago(60 * 24 * 7), subject: null, ref: null },
  ];
}

/** The weekly "What I learned" Feed post (not in the default feed, so Feed stories keep 7 posts). */
export function growthFeedPost(): FeedPost {
  return {
    id: LEARNING_IDS.growthPost,
    title: "What I learned this week",
    bodyMd: "Three things you taught me, and one I'm not sure about.",
    citations: [],
    cluster: null,
    score: 1,
    reasons: ["growth: weekly"],
    exploration: false,
    briefingId: null,
    feedback: null,
    createdAt: ago(60 * 2),
    growth: {
      weekOf: "2026-10-12",
      items: [
        {
          type: "lesson",
          statement: "Replies to Jane are short and start with the answer.",
          because: "You said: \"To Jane, just 'Hi Jane' and the answer.\"",
          lessonId: L.janeShort,
          evidence: [F.janeTone],
        },
        {
          type: "lesson",
          statement: "For receipts, search Mail before the web.",
          because: 'You said: "Search my Mail before the web for receipts."',
          lessonId: L.mailFirst,
          evidence: [F.mailFirst],
        },
        {
          type: "question",
          statement: "Should I keep emails about the Lisbon trip shorter?",
          because: "You shortened 3 of my drafts there this week.",
          lessonId: null,
          evidence: [F.draftEdit1, F.draftEdit2, F.draftEdit3],
        },
        {
          type: "retire",
          statement: 'Still true? "Explain the reasoning, then the answer."',
          because: "I haven't used this since you asked for the answer first.",
          lessonId: L.answerFirstOld,
          evidence: [],
        },
      ],
    },
  };
}
