import type {
  Block,
  Message,
  MessageRole,
  Provenance,
  Run,
  RunStatus,
  ThreadListEntry,
  ToolCall,
  Usage,
} from "@psyche/protocol";
import { at, fakeSha, IDS, inMinutes, today } from "./ids.ts";

/**
 * Threads, messages, runs and tool calls. The Dentist side chat carries every block type
 * (UI design §3.2); the main chat holds the exec and tax-letter work; Lisbon holds the purchase
 * and Notion approvals; plus one archived and one incognito chat.
 */

const T = IDS.threads;
const M = IDS.messages;
const R = IDS.runs;
const TC = IDS.toolCalls;

const MODEL = "anthropic/claude-sonnet-5-5";

// --- Threads --------------------------------------------------------------------------------------

export function threads(): ThreadListEntry[] {
  return [
    {
      thread: {
        id: T.main,
        kind: "main",
        title: "Main chat",
        titleSource: "auto",
        parentThreadId: null,
        forkedFromMessageId: null,
        sessionKey: "owner:main",
        personaOverlay: null,
        permissionMode: "balanced",
        modelRef: MODEL,
        pinned: true,
        archivedAt: null,
        expiresAt: null,
        activeWriterRunId: null,
        createdAt: "2026-10-16T18:00:00Z",
        updatedAt: today("09:52", "30"),
        lastMessageAt: today("09:52", "30"),
      },
      activity: { running: 0, awaitingInput: 0, awaitingApproval: 2 },
    },
    {
      thread: {
        id: T.dentist,
        kind: "side",
        title: "Dentist booking",
        titleSource: "auto",
        parentThreadId: T.main,
        forkedFromMessageId: null,
        sessionKey: `owner:side:${T.dentist}`,
        personaOverlay: null,
        permissionMode: "balanced",
        modelRef: MODEL,
        pinned: false,
        archivedAt: null,
        expiresAt: null,
        activeWriterRunId: R.dentistBook,
        createdAt: today("10:02"),
        updatedAt: today("10:11", "45"),
        lastMessageAt: today("10:11", "45"),
      },
      activity: { running: 1, awaitingInput: 1, awaitingApproval: 2 },
    },
    {
      thread: {
        id: T.lisbon,
        kind: "side",
        title: "Lisbon trip",
        titleSource: "user",
        parentThreadId: T.main,
        forkedFromMessageId: null,
        sessionKey: `owner:side:${T.lisbon}`,
        personaOverlay: null,
        permissionMode: "balanced",
        modelRef: MODEL,
        pinned: false,
        archivedAt: null,
        expiresAt: null,
        activeWriterRunId: null,
        createdAt: today("09:20"),
        updatedAt: today("09:25", "10"),
        lastMessageAt: today("09:25", "10"),
      },
      activity: { running: 0, awaitingInput: 1, awaitingApproval: 2 },
    },
    {
      thread: {
        id: T.archived,
        kind: "side",
        title: "Permission slip",
        titleSource: "auto",
        parentThreadId: T.main,
        forkedFromMessageId: null,
        sessionKey: `owner:side:${T.archived}`,
        personaOverlay: null,
        permissionMode: "balanced",
        modelRef: null,
        pinned: false,
        archivedAt: "2026-10-05T16:20:00Z",
        expiresAt: null,
        activeWriterRunId: null,
        createdAt: "2026-10-02T15:10:00Z",
        updatedAt: "2026-10-05T16:20:00Z",
        lastMessageAt: "2026-10-02T15:11:30Z",
      },
      activity: { running: 0, awaitingInput: 0, awaitingApproval: 0 },
    },
    {
      thread: {
        id: T.incognito,
        kind: "incognito",
        title: "Incognito chat",
        titleSource: "auto",
        parentThreadId: null,
        forkedFromMessageId: null,
        sessionKey: `owner:incognito:${T.incognito}`,
        personaOverlay: null,
        permissionMode: "manual",
        modelRef: MODEL,
        pinned: false,
        archivedAt: null,
        expiresAt: inMinutes(60 * 24),
        activeWriterRunId: null,
        createdAt: today("10:00"),
        updatedAt: today("10:00", "40"),
        lastMessageAt: today("10:00", "40"),
      },
      activity: { running: 0, awaitingInput: 0, awaitingApproval: 0 },
    },
  ];
}

// --- Messages -------------------------------------------------------------------------------------

function message(
  id: string,
  threadId: string,
  seq: number,
  role: MessageRole,
  createdAt: string,
  blocks: Block[],
  extra: { runId?: string | null; provenance?: Provenance; replyTo?: string } = {},
): Message {
  return {
    id,
    threadId,
    seq,
    role,
    blocks,
    providerNative: null,
    provenance:
      extra.provenance ?? (role === "user" ? "owner" : role === "system" ? "system" : "agent"),
    replyToMessageId: extra.replyTo ?? null,
    channelRef: null,
    runId: extra.runId ?? null,
    createdAt,
  };
}

const SLOTS_MD = `Three slots work with your Tuesday focus block. Holding the earliest.

- **Tue Oct 20, 2:30 pm** with Dr. Ortiz (fits after your focus block)
- Wed Oct 21, 9:00 am, before standup
- Thu Oct 22, 4:15 pm, last slot of the day

The booking form on acme.com posts this:

\`\`\`json
{
  "provider": "dr-ortiz",
  "slot": "2026-10-20T14:30:00",
  "reason": "cleaning",
  "patient": "{{cred:acme-login.username}}"
}
\`\`\`

The *Preferred date* field was disabled, so I picked the slot from the calendar view instead.`;

export function messages(): Message[] {
  return [
    // Main chat
    message(M.mainBootstrap, T.main, 0, "agent", "2026-10-16T18:00:00Z", [
      {
        type: "text",
        md: "Hi, I'm Wren. I keep a small notebook about what you ask me to remember, and I ask before I send, buy or delete anything. What should I start with?",
      },
    ]),
    message(M.mainUser, T.main, 1, "user", today("09:40"), [
      { type: "text", md: "Install the dependencies for ~/Projects/psyche." },
    ]),
    message(
      M.mainAgent,
      T.main,
      2,
      "agent",
      today("09:41"),
      [
        {
          type: "text",
          md: "I need to run `npm install` in `~/Projects/psyche`. It writes `node_modules` and the lockfile.",
        },
        {
          type: "tool_call",
          toolCallId: TC.mainExec,
          tool: "exec",
          status: "pending",
          level1: "Run npm install in ~/Projects/psyche",
        },
        { type: "approval", approvalId: IDS.approvals.exec },
      ],
      { runId: R.main },
    ),
    message(M.mainUserTax, T.main, 3, "user", today("09:50"), [
      { type: "text", md: "Draft the letter to the tax office about the late notice." },
    ]),
    message(
      M.mainAgentTax,
      T.main,
      4,
      "agent",
      today("09:52", "30"),
      [
        {
          type: "text",
          md: "Drafted it from the notice in your Downloads. I want to save it next to the notice.",
        },
        { type: "task", taskId: IDS.tasks.tax },
        {
          type: "tool_call",
          toolCallId: TC.taxWrite,
          tool: "write_file",
          status: "pending",
          level1: "Write ~/Documents/Taxes/letter-to-tax-office.md",
        },
        { type: "approval", approvalId: IDS.approvals.fileWrite },
      ],
      { runId: R.tax },
    ),

    // Dentist booking
    message(M.dentistUser, T.dentist, 0, "user", today("10:02"), [
      { type: "text", md: "Book the dentist next week. Mornings are bad." },
    ]),
    message(
      M.dentistStart,
      T.dentist,
      1,
      "agent",
      today("10:02", "20"),
      [
        { type: "text", md: "On it. I'll check acme.com against your calendar." },
        { type: "task", taskId: IDS.tasks.dentist },
        { type: "plan", planId: IDS.tasks.dentist },
        {
          type: "tool_call",
          toolCallId: TC.dentistNavigate,
          tool: "browser.navigate",
          status: "ok",
          level1: "Opened acme.com/appointments",
        },
        {
          type: "tool_call",
          toolCallId: TC.dentistCalendar,
          tool: "calendar.list_events",
          status: "ok",
          level1: "Read your calendar for Oct 19–23",
        },
      ],
      { runId: R.dentistSearch },
    ),
    message(
      M.dentistSlots,
      T.dentist,
      2,
      "agent",
      today("10:03", "30"),
      [
        { type: "text", md: SLOTS_MD },
        {
          type: "tool_call",
          toolCallId: TC.dentistFillDate,
          tool: "browser.fill",
          status: "failed",
          level1: "Could not fill Preferred date (field disabled)",
        },
        {
          type: "tool_call",
          toolCallId: TC.dentistHold,
          tool: "calendar.create_event",
          status: "uncertain",
          level1: "Calendar hold for Tue 2:30 · outcome unknown · not retried",
        },
        { type: "receipt", receiptId: IDS.receipts.holdUncertain },
        {
          type: "checklist",
          items: [
            { text: "Find slots", status: "completed" },
            { text: "Hold the 2:30 slot", status: "in_progress" },
            { text: "Confirm with Jane", status: "pending" },
          ],
        },
      ],
      { runId: R.dentistSearch },
    ),
    message(M.dentistSystem, T.dentist, 3, "system", today("10:04", "10"), [
      { type: "text", md: "Permission mode is now balanced. Wren asks before every write." },
    ]),
    message(
      M.dentistQuestion,
      T.dentist,
      4,
      "agent",
      today("10:06"),
      [
        { type: "text", md: "Two quick answers before I confirm anything." },
        { type: "question", inputRequestId: IDS.inputRequests.dentistSlot },
      ],
      { runId: R.dentistSearch },
    ),
    message(
      M.dentistResults,
      T.dentist,
      5,
      "agent",
      today("10:07"),
      [
        {
          type: "text",
          md: "Asked Jane at the front desk whether Tuesday still has room, and filled the intake form. Tuesday is laid out below.",
        },
        {
          type: "tool_call",
          toolCallId: TC.dentistEmail,
          tool: "gmail.send",
          status: "ok",
          level1: "Sent to jane.ortiz@example.com",
        },
        { type: "receipt", receiptId: IDS.receipts.emailSent },
        { type: "file", libraryItemId: IDS.library.intakeForm },
        { type: "artifact", artifactId: IDS.artifacts.itinerary, preview: "itinerary" },
      ],
      { runId: R.dentistSearch },
    ),
    // Out-of-turn: posted by the background "Price watch" task, not by this thread's run.
    message(M.dentistPriceWatch, T.dentist, 6, "agent", today("10:09"), [
      { type: "task", taskId: IDS.tasks.priceWatch },
      {
        type: "text",
        md: "Headphones dropped to $189. Because: you asked me to tell you under $200.",
      },
    ]),
    message(
      M.dentistWrapUp,
      T.dentist,
      7,
      "agent",
      today("10:11", "45"),
      [
        {
          type: "text",
          md: "Jane replied that Tuesday 2:30 is open. I drafted the confirmation and I'm booking the slot now.",
        },
        {
          type: "tool_call",
          toolCallId: TC.dentistBook,
          tool: "browser.click",
          status: "running",
          level1: "Clicking Book",
        },
        {
          type: "tool_call",
          toolCallId: TC.dentistCredential,
          tool: "browser.fill_credential",
          status: "pending",
          level1: "Fill acme.com login from the vault",
        },
        { type: "approval", approvalId: IDS.approvals.credentialFill },
        {
          type: "tool_call",
          toolCallId: TC.dentistSendConfirm,
          tool: "gmail.send",
          status: "pending",
          level1: "Send Confirming Tuesday 2:30 to jane.ortiz@example.com",
        },
        { type: "approval", approvalId: IDS.approvals.sendEmail },
        {
          type: "wrap_up",
          recap:
            "Tuesday 2:30 with Dr. Ortiz is held on acme.com and the confirmation to Jane is drafted. Both wait on your approval below; nothing is booked until then.",
          ask: "Add a reminder the evening before?",
          actions: [
            { label: "Yes, at 18:00", message: "Remind me at 18:00 the evening before." },
            { label: "No reminder", message: "No reminder for the dentist, thanks." },
          ],
        },
      ],
      { runId: R.dentistBook },
    ),

    // Lisbon trip
    message(M.lisbonUser, T.lisbon, 0, "user", today("09:20"), [
      { type: "text", md: "Find flights to Lisbon for early November, and keep notes in Notion." },
    ]),
    message(
      M.lisbonAgent,
      T.lisbon,
      1,
      "agent",
      today("09:22"),
      [
        {
          type: "text",
          md: "Found two good windows. The cheaper one needs a Friday off.",
        },
        {
          type: "tool_call",
          toolCallId: TC.lisbonSearch,
          tool: "web.search",
          status: "ok",
          level1: "Searched flights SFO → LIS, Nov 5–12",
        },
        { type: "question", inputRequestId: IDS.inputRequests.lisbonDates },
      ],
      { runId: R.lisbon },
    ),
    message(
      M.lisbonApprovals,
      T.lisbon,
      2,
      "agent",
      today("09:25", "10"),
      [
        {
          type: "text",
          md: "I paused the research task until you pick dates. Two things wait for you: the fare hold and the Notion page.",
        },
        { type: "task", taskId: IDS.tasks.lisbon },
        {
          type: "tool_call",
          toolCallId: TC.lisbonPurchase,
          tool: "payments.checkout",
          status: "pending",
          level1: "Hold fare on atlantico-air.example for €412.80",
        },
        { type: "approval", approvalId: IDS.approvals.purchase },
        {
          type: "tool_call",
          toolCallId: TC.lisbonNotion,
          tool: "mcp__notion__create_page",
          status: "pending",
          level1: "Create Notion page Lisbon trip",
        },
        { type: "approval", approvalId: IDS.approvals.mcpTool },
      ],
      { runId: R.lisbon },
    ),

    // Archived
    message(M.archivedUser, T.archived, 0, "user", "2026-10-02T15:10:00Z", [
      { type: "text", md: "Fill in the permission slip for the museum trip." },
    ]),
    message(
      M.archivedAgent,
      T.archived,
      1,
      "agent",
      "2026-10-02T15:11:30Z",
      [
        {
          type: "text",
          md: "Filled 10 of 12 fields. Allergies and the emergency contact need you.",
        },
        { type: "file", libraryItemId: IDS.library.permissionSlip },
      ],
      { runId: R.archived },
    ),

    // Incognito
    message(M.incognitoUser, T.incognito, 0, "user", today("10:00"), [
      { type: "text", md: "What's a polite way to decline a wedding invite?" },
    ]),
    message(
      M.incognitoAgent,
      T.incognito,
      1,
      "agent",
      today("10:00", "40"),
      [
        {
          type: "text",
          md: "Keep it short and warm:\n\n> Thank you so much for including me. I can't make it, but I'll be celebrating you both from afar.\n\nNothing from this chat goes into memory.",
        },
      ],
      { runId: R.incognito },
    ),
  ];
}

// --- Runs -----------------------------------------------------------------------------------------

function usage(input: number, output: number, cacheRead: number, costUsd: number): Usage {
  return { input, output, cacheRead, cacheWrite: 0, reasoning: 0, costUsd };
}

function run(
  id: string,
  threadId: string,
  status: RunStatus,
  startedAt: string,
  endedAt: string | null,
  u: Usage,
  error: string | null = null,
): Run {
  return { id, threadId, status, modelRef: MODEL, attempt: 1, startedAt, endedAt, error, usage: u };
}

export function runs(): Run[] {
  return [
    run(
      R.main,
      T.main,
      "awaiting_approval",
      today("09:40", "05"),
      null,
      usage(6120, 210, 4800, 0.021),
    ),
    run(
      R.tax,
      T.main,
      "awaiting_approval",
      today("09:50", "05"),
      null,
      usage(9400, 1320, 6100, 0.047),
    ),
    run(
      R.dentistSearch,
      T.dentist,
      "done",
      today("10:02", "05"),
      today("10:07", "30"),
      usage(18_200, 1640, 12_900, 0.083),
    ),
    run(
      R.dentistBook,
      T.dentist,
      "running",
      today("10:10", "30"),
      null,
      usage(7300, 410, 6200, 0.029),
    ),
    run(
      R.lisbon,
      T.lisbon,
      "awaiting_input",
      today("09:20", "05"),
      null,
      usage(11_800, 980, 7400, 0.051),
    ),
    run(
      R.priceWatch,
      T.main,
      "done",
      today("10:08", "40"),
      today("10:09", "05"),
      usage(2100, 90, 1800, 0.006),
    ),
    {
      ...run(
        R.subscriptionAudit,
        T.main,
        "failed",
        "2026-10-01T09:00:00Z",
        "2026-10-01T09:04:12Z",
        usage(14_300, 870, 9000, 0.058),
        "The StreamBox account page changed and the cancel button was not found.",
      ),
      attempt: 2,
    },
    run(
      R.archived,
      T.archived,
      "done",
      "2026-10-02T15:10:05Z",
      "2026-10-02T15:11:30Z",
      usage(8800, 640, 0, 0.034),
    ),
    run(
      R.incognito,
      T.incognito,
      "done",
      today("10:00", "05"),
      today("10:00", "40"),
      usage(1200, 85, 0, 0.004),
    ),
  ];
}

// --- Tool calls -----------------------------------------------------------------------------------

function toolCall(
  partial: Pick<ToolCall, "id" | "runId" | "messageId" | "tool" | "paramsRedacted" | "status"> &
    Partial<ToolCall>,
): ToolCall {
  return {
    paramsHash: fakeSha(`params:${partial.id}`),
    sideEffect: "read",
    target: null,
    decision: "allow",
    decisionRule: "balanced:read",
    approvalId: null,
    taintIn: false,
    taintOut: false,
    resultRef: null,
    provenanceOut: "trusted",
    receiptId: null,
    startedAt: at(0),
    endedAt: null,
    ...partial,
  };
}

export function toolCalls(): ToolCall[] {
  return [
    toolCall({
      id: TC.dentistNavigate,
      runId: R.dentistSearch,
      messageId: M.dentistStart,
      tool: "browser.navigate",
      paramsRedacted: { url: "https://acme.com/appointments", tabId: "tab_1" },
      target: { kind: "origin", value: "https://acme.com", display: "acme.com" },
      decisionRule: "grant:site",
      taintOut: true,
      provenanceOut: "untrusted",
      resultRef: "results/tc_dentist_navigate.json",
      receiptId: IDS.receipts.browserRead,
      startedAt: today("10:02", "22"),
      endedAt: today("10:02", "34"),
      status: "ok",
    }),
    toolCall({
      id: TC.dentistCalendar,
      runId: R.dentistSearch,
      messageId: M.dentistStart,
      tool: "calendar.list_events",
      paramsRedacted: {
        account: "google:you@gmail.com",
        from: "2026-10-19T00:00:00Z",
        to: "2026-10-24T00:00:00Z",
      },
      target: { kind: "account", value: "google:you@gmail.com", display: "Google Calendar" },
      decisionRule: "connector:gmail:calendar.read=allow",
      taintIn: true,
      resultRef: "results/tc_dentist_calendar.json",
      startedAt: today("10:02", "35"),
      endedAt: today("10:02", "37"),
      status: "ok",
    }),
    toolCall({
      id: TC.dentistFillDate,
      runId: R.dentistSearch,
      messageId: M.dentistSlots,
      tool: "browser.fill",
      paramsRedacted: { tabId: "tab_1", ref: "e14", label: "Preferred date", value: "2026-10-20" },
      sideEffect: "write",
      target: { kind: "origin", value: "https://acme.com", display: "acme.com" },
      decisionRule: "grant:site",
      taintIn: true,
      resultRef: "results/tc_dentist_fill_date.json",
      startedAt: today("10:03", "02"),
      endedAt: today("10:03", "04"),
      status: "failed",
    }),
    toolCall({
      id: TC.dentistHold,
      runId: R.dentistSearch,
      messageId: M.dentistSlots,
      tool: "calendar.create_event",
      paramsRedacted: {
        account: "google:you@gmail.com",
        calendarId: "primary",
        title: "Hold: dentist (Dr. Ortiz)",
        start: "2026-10-20T14:30:00Z",
        end: "2026-10-20T15:30:00Z",
      },
      sideEffect: "write",
      target: { kind: "account", value: "google:you@gmail.com", display: "Google Calendar" },
      decisionRule: `grant:${IDS.grants.calendarOnce}`,
      approvalId: IDS.approvals.approvedOnIphone,
      taintIn: true,
      receiptId: IDS.receipts.holdUncertain,
      startedAt: today("10:03", "10"),
      endedAt: today("10:03", "40"),
      status: "uncertain",
    }),
    toolCall({
      id: TC.dentistEmail,
      runId: R.dentistSearch,
      messageId: M.dentistResults,
      tool: "gmail.send",
      paramsRedacted: {
        account: "gmail:you@gmail.com",
        to: ["jane.ortiz@example.com"],
        subject: "Question about next week",
        bodyHash: fakeSha("body:question-next-week"),
      },
      sideEffect: "write",
      target: { kind: "recipient", value: "jane.ortiz@example.com" },
      decisionRule: `grant:${IDS.grants.dentistTask}`,
      taintIn: true,
      receiptId: IDS.receipts.emailSent,
      startedAt: today("10:06", "40"),
      endedAt: today("10:06", "42"),
      status: "ok",
    }),
    toolCall({
      id: TC.dentistBook,
      runId: R.dentistBook,
      messageId: M.dentistWrapUp,
      tool: "browser.click",
      paramsRedacted: { tabId: "tab_1", ref: "e31", label: "Book" },
      sideEffect: "write",
      target: { kind: "origin", value: "https://acme.com", display: "acme.com" },
      decisionRule: "grant:site",
      taintIn: true,
      startedAt: today("10:11", "40"),
      status: "running",
    }),
    toolCall({
      id: TC.dentistCredential,
      runId: R.dentistBook,
      messageId: M.dentistWrapUp,
      tool: "browser.fill_credential",
      paramsRedacted: {
        tabId: "tab_1",
        origin: "https://acme.com",
        fields: { username: "{{cred:acme-login.username}}", password: "{{cred:acme-login}}" },
      },
      sideEffect: "write",
      target: { kind: "origin", value: "https://acme.com", display: "acme.com" },
      decision: "ask",
      decisionRule: "always-ask:credential_fill",
      approvalId: IDS.approvals.credentialFill,
      taintIn: true,
      startedAt: today("10:11", "45"),
      status: "pending",
    }),
    toolCall({
      id: TC.dentistSendConfirm,
      runId: R.dentistBook,
      messageId: M.dentistWrapUp,
      tool: "gmail.send",
      paramsRedacted: {
        account: "gmail:you@gmail.com",
        to: ["jane.ortiz@example.com"],
        subject: "Confirming Tuesday 2:30",
        bodyHash: fakeSha("body:confirming-tuesday"),
      },
      sideEffect: "write",
      target: { kind: "recipient", value: "jane.ortiz@example.com" },
      decision: "ask",
      decisionRule: "balanced:write+taint",
      approvalId: IDS.approvals.sendEmail,
      taintIn: true,
      startedAt: today("10:10", "41"),
      status: "pending",
    }),
    toolCall({
      id: TC.mainExec,
      runId: R.main,
      messageId: M.mainAgent,
      tool: "exec",
      paramsRedacted: { argv: ["npm", "install"], cwd: "~/Projects/psyche" },
      sideEffect: "write",
      target: { kind: "command", value: "npm install", display: "npm install" },
      decision: "ask",
      decisionRule: "balanced:exec",
      approvalId: IDS.approvals.exec,
      startedAt: today("09:41"),
      status: "pending",
    }),
    toolCall({
      id: TC.taxWrite,
      runId: R.tax,
      messageId: M.mainAgentTax,
      tool: "write_file",
      paramsRedacted: {
        path: "~/Documents/Taxes/letter-to-tax-office.md",
        contentHash: fakeSha("content:tax-letter"),
        mode: "create",
      },
      sideEffect: "write",
      target: {
        kind: "path",
        value: "/Users/you/Documents/Taxes/letter-to-tax-office.md",
        display: "~/Documents/Taxes/letter-to-tax-office.md",
      },
      decision: "ask",
      decisionRule: "balanced:write",
      approvalId: IDS.approvals.fileWrite,
      startedAt: today("09:52", "30"),
      status: "pending",
    }),
    toolCall({
      id: TC.lisbonSearch,
      runId: R.lisbon,
      messageId: M.lisbonAgent,
      tool: "web.search",
      paramsRedacted: { query: "flights SFO to LIS November 5-12" },
      decisionRule: "balanced:read",
      taintOut: true,
      provenanceOut: "untrusted",
      resultRef: "results/tc_lisbon_search.json",
      startedAt: today("09:20", "30"),
      endedAt: today("09:21", "10"),
      status: "ok",
    }),
    toolCall({
      id: TC.lisbonPurchase,
      runId: R.lisbon,
      messageId: M.lisbonApprovals,
      tool: "payments.checkout",
      paramsRedacted: {
        merchant: "https://booking.atlantico-air.example",
        amount: 412.8,
        currency: "EUR",
        paymentMethod: "{{cred:stripe-link}}",
      },
      sideEffect: "financial",
      target: {
        kind: "origin",
        value: "https://booking.atlantico-air.example",
        display: "atlantico-air.example",
      },
      decision: "ask",
      decisionRule: "always-ask:financial",
      approvalId: IDS.approvals.purchase,
      taintIn: true,
      startedAt: today("09:25"),
      status: "pending",
    }),
    toolCall({
      id: TC.lisbonNotion,
      runId: R.lisbon,
      messageId: M.lisbonApprovals,
      tool: "mcp__notion__create_page",
      paramsRedacted: {
        parent: { database_id: "trips-db" },
        properties: { title: "Lisbon trip", dates: "Nov 6–10" },
      },
      sideEffect: "write",
      target: { kind: "app", value: "mcp:notion", display: "Notion" },
      decision: "ask",
      decisionRule: "connector:notion:read-only",
      approvalId: IDS.approvals.mcpTool,
      startedAt: today("09:25", "05"),
      status: "pending",
    }),
  ];
}
