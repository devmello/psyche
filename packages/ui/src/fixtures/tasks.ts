import type {
  Artifact,
  InputRequest,
  LibraryItem,
  Receipt,
  Task,
  TaskAction,
} from "@psyche/protocol";
import { fakeHex, IDS, inMinutes, today } from "./ids.ts";

/** Tasks, the Dentist activity log, input requests, receipts, artifacts and the Library. */

const T = IDS.threads;
const K = IDS.tasks;

// --- Tasks ----------------------------------------------------------------------------------------

function task(
  partial: Pick<Task, "id" | "threadId" | "title" | "goal" | "status"> & Partial<Task>,
): Task {
  return {
    createdFrom: "chat",
    plan: null,
    checklist: [],
    currentStepId: null,
    attempt: 1,
    leaseOwner: null,
    leaseUntil: null,
    browserSessionId: null,
    sandboxId: null,
    summary: null,
    outcome: null,
    createdAt: today("10:02"),
    updatedAt: today("10:02"),
    completedAt: null,
    ...partial,
  };
}

export function tasks(): Task[] {
  return [
    task({
      id: K.dentist,
      threadId: T.dentist,
      title: "Dentist booking",
      goal: "Book a dentist appointment with Dr. Ortiz next week, not in the morning.",
      status: "running",
      plan: {
        approvedAt: today("10:02", "25"),
        steps: [
          { id: "step_find", title: "Find slots", status: "done", note: "3 slots fit" },
          { id: "step_hold", title: "Hold the 2:30 slot", status: "running" },
          { id: "step_confirm", title: "Confirm with Jane", status: "pending" },
        ],
      },
      checklist: [
        { text: "Find slots", status: "completed" },
        { text: "Hold the 2:30 slot", status: "in_progress" },
        { text: "Confirm with Jane", status: "pending" },
      ],
      currentStepId: "step_hold",
      leaseOwner: "gateway:local",
      leaseUntil: inMinutes(5),
      browserSessionId: IDS.browserSession,
      summary: "Holding the 2:30 slot",
      taint: true,
      createdAt: today("10:02", "20"),
      updatedAt: today("10:11", "45"),
    }),
    task({
      id: K.tax,
      threadId: T.main,
      title: "Tax letter",
      goal: "Draft a reply to the late-filing notice and save it next to the notice.",
      status: "awaiting_approval",
      checklist: [
        { text: "Read the notice", status: "completed" },
        { text: "Draft the letter", status: "completed" },
        { text: "Save it to Documents/Taxes", status: "in_progress" },
      ],
      summary: "Waiting for approval to save the letter",
      sandboxId: IDS.sandbox,
      createdAt: today("09:50", "10"),
      updatedAt: today("09:52", "30"),
    }),
    task({
      id: K.priceWatch,
      threadId: T.main,
      title: "Price watch",
      goal: "Tell me when the Sonora headphones drop under $200.",
      status: "done",
      createdFrom: "automation",
      summary: "Headphones dropped to $189 (was $219).",
      outcome: {
        price: 189,
        previous: 219,
        currency: "USD",
        url: "https://shop.example/sonora-h2",
      },
      createdAt: today("10:08", "40"),
      updatedAt: today("10:09", "05"),
      completedAt: today("10:09", "05"),
    }),
    task({
      id: K.subscriptionAudit,
      threadId: T.main,
      title: "Subscription audit",
      goal: "Find subscriptions you no longer use and cancel the ones you approve.",
      status: "failed",
      createdFrom: "automation",
      attempt: 2,
      checklist: [
        { text: "List recurring charges", status: "completed" },
        { text: "Cancel StreamBox", status: "in_progress" },
      ],
      summary: "Stopped: the StreamBox account page changed and the cancel button was not found.",
      outcome: { error: "selector_not_found", cancelled: 0, found: 4 },
      createdAt: "2026-10-01T09:00:00Z",
      updatedAt: "2026-10-01T09:04:12Z",
      completedAt: "2026-10-01T09:04:12Z",
    }),
    task({
      id: K.lisbon,
      threadId: T.lisbon,
      title: "Lisbon trip research",
      goal: "Find flights and a place to stay in Lisbon for early November.",
      status: "paused",
      plan: {
        approvedAt: null,
        steps: [
          { id: "step_flights", title: "Compare flights", status: "done" },
          { id: "step_dates", title: "Pick dates", status: "pending", note: "Waiting for you" },
          { id: "step_stay", title: "Shortlist places to stay", status: "pending" },
        ],
      },
      checklist: [
        { text: "Compare flights", status: "completed" },
        { text: "Pick dates", status: "pending" },
        { text: "Shortlist places to stay", status: "pending" },
      ],
      currentStepId: "step_dates",
      summary: "Paused until you pick dates",
      createdAt: today("09:20", "10"),
      updatedAt: today("09:25", "10"),
    }),
  ];
}

// --- Activity log ---------------------------------------------------------------------------------

export function taskActions(): TaskAction[] {
  const line = (
    idx: number,
    createdAt: string,
    level1: string,
    level2: TaskAction["level2"],
    toolCallId: string | null,
    level3Ref: string | null,
  ): TaskAction => ({
    id: `ta_dentist_${String(idx).padStart(2, "0")}`,
    taskId: K.dentist,
    idx,
    toolCallId,
    level1,
    level2,
    level3Ref,
    createdAt,
  });
  const TC = IDS.toolCalls;
  return [
    line(
      0,
      today("10:02", "34"),
      "Opened acme.com/appointments",
      { tool: "browser.navigate", target: "acme.com/appointments", outcome: "ok · 12s · r-101" },
      TC.dentistNavigate,
      "replay/task_dentist/0000.json",
    ),
    line(
      1,
      today("10:02", "37"),
      "Read your calendar for Oct 19–23",
      { tool: "calendar.list_events", target: "Google Calendar", outcome: "ok · 14 events" },
      TC.dentistCalendar,
      "results/tc_dentist_calendar.json",
    ),
    line(
      2,
      today("10:03", "04"),
      "Could not fill Preferred date",
      {
        tool: "browser.fill",
        target: "acme.com · Preferred date",
        outcome: "failed · field disabled",
      },
      TC.dentistFillDate,
      "replay/task_dentist/0002.json",
    ),
    line(
      3,
      today("10:03", "40"),
      "Calendar hold for Tue 2:30",
      {
        tool: "calendar.create_event",
        target: "Google Calendar",
        outcome: "outcome unknown · not retried",
      },
      TC.dentistHold,
      "results/tc_dentist_hold.json",
    ),
    line(
      4,
      today("10:06", "42"),
      "Sent to jane.ortiz@example.com",
      { tool: "gmail.send", target: "jane.ortiz@example.com", outcome: "ok · r-107" },
      TC.dentistEmail,
      "receipts/rc_email_sent.json",
    ),
    line(
      5,
      today("10:11", "40"),
      "Clicking Book",
      { tool: "browser.click", target: "acme.com · Book" },
      TC.dentistBook,
      null,
    ),
    line(
      6,
      today("10:11", "45"),
      "Waiting for approval: fill acme.com login",
      { tool: "browser.fill_credential", target: "acme.com", outcome: "waiting" },
      TC.dentistCredential,
      null,
    ),
  ];
}

// --- Input requests -------------------------------------------------------------------------------

export function inputRequests(): InputRequest[] {
  return [
    {
      id: IDS.inputRequests.dentistSlot,
      taskId: K.dentist,
      threadId: T.dentist,
      questions: [
        {
          question: "Which slot should I hold?",
          header: "Slot",
          options: [
            { label: "Tue 2:30", description: "recommended - fits your focus block" },
            { label: "Wed 9:00" },
            { label: "Thu 4:15" },
          ],
          multiSelect: false,
        },
        {
          question: "Who gets the confirmation?",
          header: "Notify",
          options: [{ label: "You" }, { label: "Sam" }, { label: "Nobody" }],
          multiSelect: true,
        },
      ],
      status: "open",
      answer: null,
      createdAt: today("10:06"),
      answeredAt: null,
      answeredByDeviceId: null,
    },
    {
      id: IDS.inputRequests.lisbonDates,
      taskId: null,
      threadId: T.lisbon,
      questions: [
        {
          question: "Which dates work for Lisbon?",
          header: "Dates",
          options: [
            {
              label: "Thu Nov 5 – Mon Nov 9",
              description: "Cheapest. Needs Friday off.",
              preview:
                "Out  Thu Nov 5  SFO 07:05 → LIS 08:40+1  1 stop\nBack Mon Nov 9  LIS 11:20 → SFO 16:55  1 stop\nTotal €412.80",
            },
            {
              label: "Fri Nov 6 – Tue Nov 10",
              description: "Direct both ways, €96 more.",
              preview:
                "Out  Fri Nov 6  SFO 18:30 → LIS 13:15+1  direct\nBack Tue Nov 10  LIS 12:00 → SFO 15:40  direct\nTotal €508.80",
            },
            {
              label: "Wait a week",
              description: "Prices for Nov 12–16 usually fall after Halloween.",
            },
          ],
          multiSelect: false,
        },
      ],
      status: "open",
      answer: null,
      createdAt: today("09:22"),
      answeredAt: null,
      answeredByDeviceId: null,
    },
    {
      id: IDS.inputRequests.answered,
      taskId: null,
      threadId: T.main,
      questions: [
        {
          question: "Which calendar should holds go on?",
          header: "Calendar",
          options: [{ label: "Personal" }, { label: "Work" }],
          multiSelect: false,
        },
      ],
      status: "answered",
      answer: { Calendar: "Personal" },
      createdAt: "2026-10-17T16:40:00Z",
      answeredAt: "2026-10-17T16:41:12Z",
      answeredByDeviceId: IDS.devices.iphone,
    },
  ];
}

// --- Receipts -------------------------------------------------------------------------------------

export function receipts(): Receipt[] {
  return [
    {
      id: IDS.receipts.browserRead,
      shortId: "r-101",
      kind: "browser_read",
      taskId: K.dentist,
      toolCallId: IDS.toolCalls.dentistNavigate,
      approvalId: null,
      outcome: "ok",
      summary: "Read acme.com/appointments",
      externalRefs: { url: "https://acme.com/appointments", status: 200 },
      payload: null,
      createdAt: today("10:02", "34"),
    },
    {
      id: IDS.receipts.emailSent,
      shortId: "r-107",
      kind: "send_email",
      taskId: K.dentist,
      toolCallId: IDS.toolCalls.dentistEmail,
      approvalId: null,
      outcome: "ok",
      summary: "Sent to jane.ortiz@example.com · Question about next week",
      externalRefs: { gmailId: "18c4f2a9e3b1d7c0", gmailThreadId: "18c4f2a9e3b1d7c0" },
      payload: { to: ["jane.ortiz@example.com"], subject: "Question about next week" },
      createdAt: today("10:06", "42"),
    },
    {
      id: IDS.receipts.holdUncertain,
      shortId: "r-104",
      kind: "calendar_write",
      taskId: K.dentist,
      toolCallId: IDS.toolCalls.dentistHold,
      approvalId: IDS.approvals.approvedOnIphone,
      outcome: "uncertain",
      summary: "Calendar hold for Tue 2:30 · outcome unknown · not retried",
      externalRefs: {},
      payload: { reason: "Connection dropped before Google Calendar answered." },
      createdAt: today("10:03", "40"),
    },
    {
      id: IDS.receipts.cancelFailed,
      shortId: "r-088",
      kind: "browser_submit",
      taskId: K.subscriptionAudit,
      toolCallId: null,
      approvalId: null,
      outcome: "failed",
      summary: "Cancel StreamBox subscription · failed: cancel button not found",
      externalRefs: { url: "https://streambox.example/account" },
      payload: { attempt: 2 },
      createdAt: "2026-10-01T09:04:12Z",
    },
    {
      id: IDS.receipts.calendarWrite,
      shortId: "r-079",
      kind: "calendar_write",
      taskId: null,
      toolCallId: null,
      approvalId: null,
      outcome: "ok",
      summary: "Added Call Sam on Thu Oct 22, 17:00",
      externalRefs: { eventId: "evt_7h2k9q", calendar: "primary" },
      payload: null,
      createdAt: "2026-10-17T16:41:30Z",
    },
  ];
}

// --- Artifacts and Library ------------------------------------------------------------------------

export function artifacts(): Artifact[] {
  return [
    {
      id: IDS.artifacts.itinerary,
      libraryItemId: IDS.library.itinerary,
      type: "itinerary",
      title: "Tuesday, Oct 20",
      version: 2,
      nameSlug: "tuesday-oct-20",
      sourceRef: "artifacts/tuesday-oct-20/itinerary.json",
      updatedAt: today("10:07"),
    },
    {
      id: IDS.artifacts.planPdf,
      libraryItemId: IDS.library.planPdf,
      type: "pdf",
      title: "Half marathon · 12-week plan",
      version: 1,
      nameSlug: "half-marathon-plan",
      sourceRef: "artifacts/half-marathon-plan/plan.md",
      updatedAt: "2026-10-04T08:30:00Z",
    },
    {
      id: IDS.artifacts.auditHtml,
      libraryItemId: IDS.library.auditHtml,
      type: "html",
      title: "Subscription audit · October",
      version: 1,
      nameSlug: "subscription-audit-october",
      sourceRef: "artifacts/subscription-audit-october/index.html",
      updatedAt: "2026-10-01T09:03:00Z",
    },
  ];
}

function item(
  partial: Pick<LibraryItem, "id" | "kind" | "name" | "mime" | "path" | "size" | "origin"> &
    Partial<LibraryItem>,
): LibraryItem {
  return {
    sha256: fakeHex(`library:${partial.id}`),
    threadId: null,
    taskId: null,
    tags: [],
    textExtractRef: null,
    createdAt: today("09:00"),
    ...partial,
  };
}

export function library(): LibraryItem[] {
  const L = IDS.library;
  return [
    item({
      id: L.intakeForm,
      kind: "document",
      name: "acme-intake-form.pdf",
      mime: "application/pdf",
      path: "documents/acme-intake-form.pdf",
      size: 184_320,
      origin: "agent",
      threadId: T.dentist,
      taskId: K.dentist,
      tags: ["dentist", "form"],
      textExtractRef: "extracts/lib_intake_form.txt",
      createdAt: today("10:06", "55"),
    }),
    item({
      id: L.permissionSlip,
      kind: "document",
      name: "permission-slip.pdf",
      mime: "application/pdf",
      path: "documents/permission-slip.pdf",
      size: 96_512,
      origin: "upload",
      threadId: T.archived,
      tags: ["school"],
      textExtractRef: "extracts/lib_permission_slip.txt",
      createdAt: "2026-10-02T15:10:00Z",
    }),
    item({
      id: L.avatar,
      kind: "image",
      name: "wren.png",
      mime: "image/png",
      path: "images/avatar/wren.png",
      size: 48_210,
      origin: "agent",
      tags: ["avatar"],
      createdAt: "2026-10-16T17:58:00Z",
    }),
    item({
      id: L.receiptScan,
      kind: "image",
      name: "pharmacy-receipt.jpg",
      mime: "image/jpeg",
      path: "images/pharmacy-receipt.jpg",
      size: 1_204_880,
      origin: "channel",
      tags: ["receipt"],
      createdAt: "2026-10-14T19:22:00Z",
    }),
    item({
      id: L.itinerary,
      kind: "artifact",
      name: "Tuesday, Oct 20",
      mime: "application/vnd.psyche.itinerary+json",
      path: "artifacts/tuesday-oct-20/itinerary.json",
      size: 3_410,
      origin: "agent",
      threadId: T.dentist,
      taskId: K.dentist,
      tags: ["itinerary"],
      createdAt: today("10:07"),
    }),
    item({
      id: L.planPdf,
      kind: "artifact",
      name: "half-marathon-plan.pdf",
      mime: "application/pdf",
      path: "artifacts/half-marathon-plan/plan.pdf",
      size: 212_004,
      origin: "agent",
      tags: ["goal", "running"],
      createdAt: "2026-10-04T08:30:00Z",
    }),
    item({
      id: L.auditHtml,
      kind: "artifact",
      name: "Subscription audit · October",
      mime: "text/html",
      path: "artifacts/subscription-audit-october/index.html",
      size: 18_930,
      origin: "agent",
      threadId: T.main,
      taskId: K.subscriptionAudit,
      tags: ["finance"],
      createdAt: "2026-10-01T09:03:00Z",
    }),
    item({
      id: L.invoiceDownload,
      kind: "download",
      name: "invoice.pdf",
      mime: "application/pdf",
      path: "downloads/invoice.pdf",
      size: 72_118,
      origin: "download",
      threadId: T.dentist,
      taskId: K.dentist,
      quarantined: true,
      createdAt: today("10:05", "20"),
    }),
    ...(
      [
        [L.soul, "SOUL.md", 6_240],
        [L.identity, "IDENTITY.md", 412],
        [L.user, "USER.md", 1_380],
        [L.memory, "MEMORY.md", 2_960],
        [L.agents, "AGENTS.md", 1_105],
      ] as const
    ).map(([id, name, size]) =>
      item({
        id,
        kind: "system",
        name,
        mime: "text/markdown",
        path: `system/${name}`,
        size,
        origin: "agent",
        tags: ["workspace"],
        createdAt: "2026-10-16T17:58:00Z",
      }),
    ),
    item({
      id: L.dailyNote,
      kind: "system",
      name: "2026-10-18.md",
      mime: "text/markdown",
      path: "system/memory/2026-10-18.md",
      size: 640,
      origin: "agent",
      tags: ["daily-note"],
      createdAt: today("07:00"),
    }),
  ];
}
