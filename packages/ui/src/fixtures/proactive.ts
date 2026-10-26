import type { Automation, FeedPost, Goal, Idea, Notification } from "@psyche/protocol";
import { IDS, inMinutes, today } from "./ids.ts";

/** Notifications, Feed, Ideas, Goals and automations (UI design §3.9–§3.11, §3.16, §3.20). */

const N = IDS.notifications;

// --- Notifications --------------------------------------------------------------------------------

function notification(
  partial: Pick<Notification, "id" | "kind" | "title" | "body" | "route" | "createdAt"> &
    Partial<Notification>,
): Notification {
  return {
    taskId: null,
    approvalId: null,
    actions: [],
    surfaces: ["desktop"],
    delivered: { desktop: partial.createdAt },
    readAt: null,
    resolvedAt: null,
    ...partial,
  };
}

export function notifications(): Notification[] {
  return [
    notification({
      id: N.approval,
      kind: "approval",
      title: "Send email to jane.ortiz@example.com",
      body: "Confirming Tuesday 2:30 · Dentist booking",
      taskId: IDS.tasks.dentist,
      approvalId: IDS.approvals.sendEmail,
      route: `/chat/${IDS.threads.dentist}`,
      actions: [
        { id: "approve", label: "Approve" },
        { id: "deny", label: "Deny", destructive: true },
      ],
      surfaces: ["desktop", "notification", "telegram:you"],
      delivered: {
        desktop: today("10:10", "41"),
        notification: today("10:10", "42"),
        "telegram:you": today("10:10", "43"),
      },
      createdAt: today("10:10", "41"),
    }),
    notification({
      id: N.inputNeeded,
      kind: "input_needed",
      title: "Trip to Lisbon - which dates?",
      body: "Dates",
      route: `/chat/${IDS.threads.lisbon}`,
      actions: [{ id: "answer", label: "Answer" }],
      surfaces: ["desktop", "notification"],
      delivered: { desktop: today("09:22"), notification: today("09:22", "01") },
      createdAt: today("09:22"),
    }),
    notification({
      id: N.taskDone,
      kind: "task_done",
      title: "Price watch",
      body: "Headphones dropped to $189 (was $219).",
      taskId: IDS.tasks.priceWatch,
      route: `/agent/activity/${IDS.tasks.priceWatch}`,
      actions: [{ id: "open", label: "Open" }],
      readAt: today("10:10"),
      createdAt: today("10:09", "05"),
    }),
    notification({
      id: N.taskFailed,
      kind: "task_failed",
      title: "Subscription audit",
      body: "The StreamBox account page changed and the cancel button was not found. Nothing was cancelled.",
      taskId: IDS.tasks.subscriptionAudit,
      route: `/agent/activity/${IDS.tasks.subscriptionAudit}`,
      actions: [
        { id: "open", label: "Open" },
        { id: "retry", label: "Retry" },
      ],
      surfaces: ["desktop", "notification"],
      delivered: {
        desktop: "2026-10-01T09:04:12Z",
        notification: "2026-10-01T09:04:13Z",
      },
      readAt: "2026-10-01T12:00:00Z",
      createdAt: "2026-10-01T09:04:12Z",
    }),
    // A background specialist's result (docs/agent/specialists-2026.md §6.2).
    notification({
      id: N.specialistResult,
      kind: "specialist_result",
      title: "Researcher finished Apartments near the office",
      body: "Done · 3 findings · $0.84 · 22 min",
      route: "/inbox",
      actions: [{ id: "open", label: "Open" }],
      surfaces: ["desktop", "notification"],
      delivered: { desktop: "2026-10-01T08:12:00Z", notification: "2026-10-01T08:12:01Z" },
      readAt: "2026-10-01T09:00:00Z",
      createdAt: "2026-10-01T08:12:00Z",
    }),
    notification({
      id: N.proactive,
      kind: "proactive",
      title: "Cancel the unused streaming subscription",
      body: "Because: 3 charges in Gmail, no logins in 90 days.",
      route: "/ideas",
      actions: [{ id: "open", label: "Open" }],
      createdAt: today("08:15"),
    }),
    notification({
      id: N.briefing,
      kind: "briefing",
      title: "Brief ready",
      body: "Two things before your 10:00.",
      route: "/feed",
      actions: [{ id: "open", label: "Open" }],
      readAt: today("07:20"),
      resolvedAt: today("07:20"),
      createdAt: today("07:00"),
    }),
    notification({
      id: N.reminder,
      kind: "reminder",
      title: "Half marathon check-in",
      body: "Week 3 of 12. How did the long run go?",
      route: `/goals/${IDS.goals.halfMarathon}`,
      actions: [
        { id: "done", label: "Done" },
        { id: "snooze", label: "Snooze 1 h" },
      ],
      surfaces: ["desktop", "notification"],
      delivered: { desktop: today("08:00"), notification: today("08:00", "01") },
      createdAt: today("08:00"),
    }),
    notification({
      id: N.system,
      kind: "system",
      title: "Nightly memory job skipped",
      body: "The nightly job didn't run (Mac was asleep). Next: 06:00.",
      route: "/agent/soul",
      createdAt: today("06:30"),
      readAt: today("07:20"),
    }),
  ];
}

// --- Feed -----------------------------------------------------------------------------------------

export const NEXT_BRIEF_AT = "2026-10-19T07:00:00Z";

export function feed(): FeedPost[] {
  const P = IDS.feed;
  return [
    {
      id: P.briefing,
      title: "Two things before your 10:00",
      bodyMd:
        "Your dentist hold for Tuesday 2:30 still needs a confirmation [1]. Jane at the front desk replies within the hour on weekdays [2]. acme.com closes online booking for next week at 6 pm today [3].",
      citations: [
        {
          title: "Hold: dentist (Dr. Ortiz)",
          url: "psyche://calendar/evt_hold_dentist",
          source: "Calendar",
        },
        {
          title: "Re: Question about next week",
          url: "psyche://gmail/18c4f2a9e3b1d7c0",
          source: "Gmail",
        },
        { title: "Appointments", url: "https://acme.com/appointments", source: "acme.com" },
      ],
      cluster: null,
      score: 0.94,
      reasons: ["calendar: today", "open task: Dentist booking"],
      exploration: false,
      briefingId: IDS.briefing,
      feedback: null,
      createdAt: today("07:00"),
    },
    {
      id: P.reminder,
      title: "Intake form before Tuesday",
      bodyMd:
        "acme.com wants the intake form 24 hours ahead. I filled what I could; two fields need you. Because: the appointment is Tuesday at 2:30.",
      citations: [{ title: "acme-intake-form.pdf", url: "psyche://library/lib_intake_form" }],
      cluster: null,
      score: 0.81,
      reasons: ["open task: Dentist booking", "deadline 2026-10-19"],
      exploration: false,
      briefingId: IDS.briefing,
      feedback: null,
      createdAt: today("07:00"),
    },
    {
      id: P.suggestion,
      title: "Move Thursday's run to the morning",
      bodyMd:
        "Rain is forecast after 3 pm on Thursday, and your 10k pace drops in the wet. Because: your half marathon plan has a tempo run that day.",
      citations: [
        {
          title: "Forecast, Oct 19–25",
          url: "https://weather.example/sfo",
          source: "weather.example",
        },
      ],
      cluster: null,
      score: 0.66,
      reasons: ["goal: Run a half marathon in May", "weather"],
      exploration: false,
      briefingId: IDS.briefing,
      feedback: null,
      createdAt: today("07:00"),
    },
    {
      id: P.watch,
      title: "Headphones dropped to $189",
      bodyMd:
        "The Sonora H2 is $189 at shop.example, down from $219. Because: you asked me to watch for under $200.",
      citations: [
        { title: "Sonora H2", url: "https://shop.example/sonora-h2", source: "shop.example" },
      ],
      cluster: null,
      score: 0.88,
      reasons: ["watch: headphones", "threshold met"],
      exploration: false,
      briefingId: null,
      feedback: "like",
      createdAt: today("10:09", "05"),
    },
    {
      id: P.news,
      title: "Three labs publish manipulation benchmarks the same week",
      bodyMd:
        "Two of the three use the same household-object set, so results are finally comparable [1][2]. The third adds deformable objects like towels and cables [3].",
      citations: [
        {
          title: "A shared benchmark for household manipulation",
          url: "https://arxiv.example/2610.01234",
          source: "arXiv",
        },
        {
          title: "Robots fold laundry, slowly",
          url: "https://news.example/robots-laundry",
          source: "news.example",
        },
        {
          title: "Deformable-object tasks for robot arms",
          url: "https://lab.example/deformables",
          source: "lab.example",
        },
      ],
      cluster: {
        id: "cluster_robotics_benchmarks",
        topic: "robotics manipulation",
        size: 7,
        sources: ["arXiv", "news.example", "lab.example"],
        firstSeenAt: "2026-10-16T12:00:00Z",
      },
      score: 0.79,
      reasons: ["interest: robotics manipulation 0.9", "recency 20h"],
      exploration: false,
      briefingId: IDS.briefing,
      feedback: null,
      createdAt: today("07:00"),
    },
    {
      id: P.exploration,
      title: "Beekeepers on Lisbon rooftops",
      bodyMd:
        "Lisbon has a small rooftop beekeeping scene; a few hives sit above Alfama and offer tastings on weekends. Because: you're planning Lisbon and you liked a post about urban gardens.",
      citations: [
        {
          title: "Rooftop honey in Alfama",
          url: "https://travel.example/alfama-bees",
          source: "travel.example",
        },
      ],
      cluster: null,
      score: 0.41,
      reasons: ["exploration slot", "trip: Lisbon"],
      exploration: true,
      briefingId: IDS.briefing,
      feedback: null,
      createdAt: today("07:00"),
    },
    {
      id: P.lisbon,
      title: "Tram 28 runs a shorter route in November",
      bodyMd:
        "Tram 28 turns back at Graça from Nov 2 to Nov 20 for track work. Because: you're looking at Nov 5–10 in Lisbon.",
      citations: [
        {
          title: "Service changes",
          url: "https://transit.example/lisbon/28",
          source: "transit.example",
        },
      ],
      cluster: null,
      score: 0.58,
      reasons: ["trip: Lisbon", "dates overlap"],
      exploration: false,
      briefingId: IDS.briefing,
      feedback: null,
      createdAt: today("07:00"),
    },
  ];
}

// --- Ideas ----------------------------------------------------------------------------------------

export function ideas(): Idea[] {
  const I = IDS.ideas;
  return [
    {
      id: I.subscription,
      kind: "task",
      title: "Cancel the unused streaming subscription",
      bodyMd:
        "StreamBox charged you $15.99 three times since July and nobody has signed in for 90 days. I can cancel it and save the confirmation.",
      evidence: [
        { source: "gmail", text: "3 charges", ref: "gmail:18b2e1c7a9f04d31" },
        {
          source: "browser",
          text: "no logins in 90 days",
          ref: "https://streambox.example/account",
        },
      ],
      effort: "~10 min · needs 1 approval (email)",
      acceptanceProb: 0.72,
      status: "proposed",
      resultRef: null,
      createdAt: today("08:15"),
      decidedAt: null,
    },
    {
      id: I.skill,
      kind: "skill",
      title: 'Skill draft: "Weekly expense export"',
      bodyMd:
        "Export last week's receipts from Gmail, add them to the expenses sheet and file the PDFs in Library. Draft at `skills/weekly-expense-export/SKILL.md`.",
      evidence: [
        {
          source: "activity",
          text: "you did these 4 steps 3 times this month",
          ref: "tasks:expense-export",
        },
      ],
      effort: "~2 min to review · runs in 1 min",
      acceptanceProb: 0.55,
      status: "proposed",
      resultRef: "skills/weekly-expense-export/SKILL.md",
      createdAt: today("08:15"),
      decidedAt: null,
    },
    {
      id: I.automation,
      kind: "automation",
      title: "Friday afternoon week review",
      bodyMd: "A short recap every Friday at 16:00: what got done, what slipped, what's next week.",
      evidence: [
        {
          source: "chat",
          text: "you asked for a recap on 3 Fridays",
          ref: `thread:${IDS.threads.main}`,
        },
      ],
      effort: "~1 min to set up",
      acceptanceProb: 0.48,
      status: "proposed",
      resultRef: null,
      createdAt: "2026-10-17T08:15:00Z",
      decidedAt: null,
    },
    {
      id: I.connector,
      kind: "connector",
      title: "Reconnect Outlook",
      bodyMd:
        "Your work calendar stopped syncing on Oct 14. Reconnecting lets me check both calendars.",
      evidence: [
        {
          source: "connector",
          text: "needs sign-in since Oct 14",
          ref: `connector:${IDS.connectors.outlook}`,
        },
      ],
      effort: "~2 min",
      acceptanceProb: 0.35,
      status: "dismissed",
      resultRef: null,
      createdAt: "2026-10-15T08:15:00Z",
      decidedAt: "2026-10-15T12:00:00Z",
    },
    {
      id: I.accepted,
      kind: "task",
      title: "Book the dentist before the year ends",
      bodyMd: "Your last cleaning was in March. Most plans reset in January.",
      evidence: [
        { source: "gmail", text: "last visit receipt, March 12", ref: "gmail:17f9a0c2b4e6d813" },
      ],
      effort: "~15 min · 1–2 approvals",
      acceptanceProb: 0.64,
      status: "accepted",
      resultRef: `task:${IDS.tasks.dentist}`,
      createdAt: "2026-10-17T08:15:00Z",
      decidedAt: today("10:02"),
    },
  ];
}

// --- Goals ----------------------------------------------------------------------------------------

export function goals(): Goal[] {
  const G = IDS.goals;
  return [
    {
      id: G.halfMarathon,
      title: "Run a half marathon in May",
      category: "health",
      status: "active",
      inferred: false,
      confirmedAt: "2026-10-04T08:00:00Z",
      plan: {
        milestones: [
          { title: "5k", done: true },
          { title: "10k", done: true },
          { title: "15k", done: false },
          { title: "21k", done: false },
        ],
        planArtifactId: IDS.artifacts.planPdf,
        notesMd:
          "- Long runs on Sunday mornings.\n- Left knee is fine on flats; avoid back-to-back hill days.",
        watches: [
          {
            title: "registration page",
            url: "https://race.example/sf-half-2027",
            condition: "price",
            lastValue: "$95 early bird",
          },
        ],
        checkins: [
          { at: "2026-10-12T08:00:00Z", status: "on track", note: "10k in 58:40." },
          { at: "2026-10-05T08:00:00Z", status: "on track", note: "First 5k without stopping." },
        ],
        taskIds: [],
      },
      cadence: "weekly Mon 08:00",
      nextCheckinAt: "2026-10-19T08:00:00Z",
      archivedAt: null,
      createdAt: "2026-10-04T08:00:00Z",
      updatedAt: "2026-10-12T08:05:00Z",
    },
    {
      id: G.sleep,
      title: "Sleep 7 hours on weeknights",
      category: "health",
      status: "active",
      inferred: false,
      confirmedAt: "2026-09-20T21:00:00Z",
      plan: {
        milestones: [
          { title: "Screens off at 22:30", done: true },
          { title: "5 nights in a row", done: false },
        ],
        notesMd: "",
        watches: [],
        checkins: [{ at: "2026-10-17T08:00:00Z", status: "slipping", note: "Two late nights." }],
      },
      cadence: "daily 08:00",
      nextCheckinAt: "2026-10-19T08:00:00Z",
      archivedAt: null,
      createdAt: "2026-09-20T21:00:00Z",
      updatedAt: "2026-10-17T08:00:00Z",
    },
    {
      id: G.emergencyFund,
      title: "Emergency fund: 3 months of expenses",
      category: "finance",
      status: "active",
      inferred: false,
      confirmedAt: "2026-08-01T10:00:00Z",
      plan: {
        milestones: [
          { title: "1 month", done: true },
          { title: "2 months", done: false },
          { title: "3 months", done: false },
        ],
        notesMd: "Auto-transfer on the 1st and the 15th.",
        watches: [],
        checkins: [{ at: "2026-10-01T09:00:00Z", status: "on track", note: "1.4 months saved." }],
      },
      cadence: "monthly 1st 09:00",
      nextCheckinAt: "2026-11-01T09:00:00Z",
      archivedAt: null,
      createdAt: "2026-08-01T10:00:00Z",
      updatedAt: "2026-10-01T09:00:00Z",
    },
    {
      id: G.career,
      title: "Ship the Psyche UI kit",
      category: "career",
      status: "active",
      inferred: false,
      confirmedAt: "2026-10-10T17:00:00Z",
      plan: {
        milestones: [
          { title: "Tokens and theme", done: true },
          { title: "Message blocks", done: false },
          { title: "Screens", done: false },
        ],
        notesMd: "",
        watches: [],
        checkins: [],
      },
      cadence: "weekly Fri 16:00",
      nextCheckinAt: "2026-10-23T16:00:00Z",
      archivedAt: null,
      createdAt: "2026-10-10T17:00:00Z",
      updatedAt: "2026-10-17T16:00:00Z",
    },
    {
      id: G.candidate,
      title: "Learn basic Portuguese before Lisbon",
      category: "learning",
      status: "candidate",
      inferred: true,
      confirmedAt: null,
      plan: {
        evidence: [
          {
            source: "chat",
            text: "asked how to order coffee in Portuguese",
            ref: `thread:${IDS.threads.lisbon}`,
          },
          { source: "browser", text: "opened 2 language-app pages", ref: "history:2026-10-17" },
        ],
      },
      cadence: null,
      nextCheckinAt: null,
      archivedAt: null,
      createdAt: today("08:15"),
      updatedAt: today("08:15"),
    },
  ];
}

// --- Automations ----------------------------------------------------------------------------------

export function automations(): Automation[] {
  const A = IDS.automations;
  const base = {
    timezone: "Etc/UTC",
    scratch: null,
    enabled: true,
    createdAt: "2026-10-16T18:30:00Z",
    updatedAt: "2026-10-16T18:30:00Z",
  };
  return [
    {
      ...base,
      id: A.morningBrief,
      kind: "briefing",
      title: "Morning brief",
      schedule: "0 7 * * 1-5",
      sessionTarget: "main",
      delivery: { thread: IDS.threads.main },
      prompt: "Write the morning brief: calendar, inbox, open tasks, watches and interests.",
      nextRunAt: NEXT_BRIEF_AT,
      lastRunAt: today("07:00"),
      lastStatus: "delivered",
    },
    {
      ...base,
      id: A.subscriptionAudit,
      kind: "cron",
      title: "Subscription audit",
      schedule: "0 9 1 * *",
      sessionTarget: "isolated",
      delivery: { thread: IDS.threads.main },
      prompt:
        "List recurring charges, flag the ones not used in 60 days and propose cancellations.",
      nextRunAt: "2026-11-01T09:00:00Z",
      lastRunAt: "2026-10-01T09:00:00Z",
      lastStatus: "NO_REPLY",
    },
    {
      ...base,
      id: A.headphonesWatch,
      kind: "watch",
      title: "Watch: headphones",
      schedule: "PT6H",
      sessionTarget: "isolated",
      delivery: { thread: IDS.threads.main },
      prompt: "Check https://shop.example/sonora-h2 and tell me when the price is under $200.",
      scratch: "last: $219 · backoff 2x",
      nextRunAt: inMinutes(6 * 60 - 3),
      lastRunAt: today("10:08", "40"),
      lastStatus: "$189 · below $200",
    },
    {
      ...base,
      id: A.heartbeat,
      kind: "heartbeat",
      title: "Heartbeat",
      schedule: "PT45M",
      sessionTarget: "main",
      delivery: { none: true },
      prompt: "Check open tasks, watches and the inbox; say nothing unless something needs you.",
      nextRunAt: inMinutes(33),
      lastRunAt: today("09:57"),
      lastStatus: "NO_REPLY",
    },
    {
      ...base,
      id: A.reminder,
      kind: "cron",
      title: "Reminder: call Sam",
      schedule: "0 17 22 10 *",
      sessionTarget: "main",
      delivery: { thread: IDS.threads.main, channel: IDS.channels.telegram },
      prompt: "Remind me to call Sam about the projector.",
      nextRunAt: "2026-10-22T17:00:00Z",
      lastRunAt: null,
      lastStatus: null,
      createdAt: "2026-10-17T16:41:30Z",
      updatedAt: "2026-10-17T16:41:30Z",
    },
  ];
}
