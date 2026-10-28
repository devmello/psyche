import type { Automation, DailyBrief, DailyFollowup } from "@psyche/protocol";

/** Morning brief with every section, for stories and tests. */
export function morningBrief(): DailyBrief {
  return {
    kind: "morning",
    date: "2026-10-28",
    summary: "A light morning: standup at 9:30, one contract waiting on you.",
    sections: [
      {
        id: "calendar",
        title: "Today",
        items: [
          { text: "09:30 Standup", link: "/feed/post_prep_standup" },
          { text: "13:00 Design review", link: "/feed/post_prep_design" },
        ],
      },
      {
        id: "mail",
        title: "Mail that matters",
        items: [{ text: "Ana: Sign the contract", link: "message://m1" }],
      },
      { id: "due", title: "Due", items: [{ text: "Pay rent" }] },
      {
        id: "followups",
        title: "Follow-ups",
        items: [{ text: "Send Ana the deck", followupId: "fu_1" }],
      },
      { id: "weather", title: "Weather", items: [{ text: "Sunny, 21°" }] },
    ],
  };
}

/** The same brief with no connectors: calendar and mail say so. */
export function morningBriefNoConnectors(): DailyBrief {
  return {
    kind: "morning",
    date: "2026-10-28",
    summary: "",
    sections: [
      { id: "calendar", title: "Today", items: [], unavailable: true },
      { id: "mail", title: "Mail that matters", items: [], unavailable: true },
      { id: "due", title: "Due", items: [] },
      { id: "followups", title: "Follow-ups", items: [] },
    ],
  };
}

export function eveningWrapup(): DailyBrief {
  return {
    kind: "evening",
    date: "2026-10-28",
    summary: "You shipped the release and have two things left.",
    sections: [
      {
        id: "done",
        title: "Done today",
        items: [{ text: "Shipped the release" }, { text: "3 file changes recorded" }],
      },
      {
        id: "open",
        title: "Still open",
        items: [{ text: "Write changelog" }, { text: "Reply to Ana", followupId: "fu_2" }],
      },
      { id: "tomorrow", title: "Tomorrow", items: [{ text: "09:00 Coffee with Sam" }] },
    ],
    carryOver: [{ text: "Reply to Ana", followupId: "fu_2" }],
  };
}

export function dailyFollowups(): DailyFollowup[] {
  const at = "2026-10-28T15:00:00.000Z";
  return [
    {
      id: "fu_1",
      text: "Send Ana the deck",
      source: "sent_mail",
      sourceLink: "message://s1",
      status: "open",
      createdAt: at,
    },
    { id: "fu_2", text: "Remind: call the dentist", source: "chat", status: "open", createdAt: at },
    {
      id: "fu_3",
      text: "Waiting for a reply from bob@acme.io: Quote request",
      source: "awaiting_reply",
      sourceLink: "message://s0",
      status: "open",
      createdAt: at,
    },
  ];
}

export function userAutomation(over: Partial<Automation> = {}): Automation {
  return {
    id: "auto_1",
    kind: "cron",
    title: "Weekly shipped summary",
    schedule: "0 17 * * 5",
    timezone: "America/Los_Angeles",
    sessionTarget: "isolated",
    delivery: {},
    prompt: "Summarise what I shipped this week.",
    scratch: null,
    enabled: true,
    nextRunAt: "2026-10-30T00:00:00.000Z",
    lastRunAt: null,
    lastStatus: null,
    createdAt: "2026-10-20T00:00:00.000Z",
    updatedAt: "2026-10-20T00:00:00.000Z",
    ...over,
  } as Automation;
}
