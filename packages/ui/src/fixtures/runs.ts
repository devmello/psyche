import type { AutomationRun, Run, RunFrame, RunStep, Usage } from "@psyche/protocol";
import { at, IDS, today } from "./ids.ts";

/**
 * Run-trace fixtures (docs/design/run-trace-2026.md §5.3): steps for the chat's step log (T2) and
 * the agent sheet's Timeline and Activity (T3). T1 creates this file; the other workstreams
 * append what their stories need. Every timestamp is relative to FIXTURE_NOW.
 *
 * - `done`: Lisbon research. Thinking, a parallel group of three searches, a helper (its own run
 *   with two steps), an approval, and the written reply.
 * - `failed`: the subscription audit. A tool step retried once, then failed for good.
 * - `live`: dentist booking, in progress: a finished step, a running one with progress.
 * - `automation`: the morning brief's last 10 runs (durations for "usually takes about…").
 */

const MODEL = "anthropic/claude-sonnet-5-5";
const T = IDS.threads;

export const TRACE_IDS = {
  runs: {
    done: "run_trace_lisbon",
    helper: "run_trace_lisbon_helper",
    failed: "run_trace_audit",
    live: "run_trace_dentist",
    automation: (n: number) => `run_trace_brief_${String(n).padStart(2, "0")}`,
  },
  automationRuns: (n: number) => `ar_trace_brief_${String(n).padStart(2, "0")}`,
  groups: { searches: "grp_trace_searches" },
} as const;

const R = TRACE_IDS.runs;

function usage(input: number, output: number, costUsd: number): Usage {
  return { input, output, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd };
}

function traceRun(
  partial: Pick<Run, "id" | "threadId" | "status" | "startedAt" | "endedAt"> & Partial<Run>,
): Run {
  return {
    modelRef: MODEL,
    attempt: 1,
    error: null,
    usage: usage(0, 0, 0),
    parentRunId: null,
    rootRunId: null,
    taskId: null,
    automationRunId: null,
    currentStepId: null,
    lastStepAt: partial.endedAt ?? null,
    deadline: null,
    origin: "owner",
    ...partial,
  };
}

let seqByRun: Record<string, number> = {};

function step(
  runId: string,
  partial: Pick<RunStep, "id" | "kind" | "status" | "label" | "startedAt"> & Partial<RunStep>,
): RunStep {
  seqByRun[runId] = (seqByRun[runId] ?? 0) + 1;
  return { runId, seq: seqByRun[runId], endedAt: null, attempt: 1, ...partial };
}

export function traceRuns(): Run[] {
  const brief = Array.from({ length: 10 }, (_, i) => {
    const n = i + 1;
    // One run a day at 07:00 for the last 10 days; 50–95 s each.
    const start = at(-(n * 86_400) - 3 * 3600 - 720);
    const durationS = 50 + ((n * 37) % 46);
    return traceRun({
      id: R.automation(n),
      threadId: T.main,
      kind: "automation",
      origin: "automation",
      title: "Morning brief",
      automationRunId: TRACE_IDS.automationRuns(n),
      status: "done",
      startedAt: start,
      endedAt: new Date(Date.parse(start) + durationS * 1000).toISOString().replace(".000Z", "Z"),
      stepCount: 4,
      usage: usage(4200, 610, 0.012),
    });
  });
  return [
    traceRun({
      id: R.done,
      threadId: T.lisbon,
      kind: "chat",
      title: "Lisbon research",
      status: "done",
      startedAt: today("09:20"),
      endedAt: today("09:21", "34"),
      stepCount: 9,
      rootRunId: null,
      usage: usage(21_400, 1830, 0.094),
    }),
    traceRun({
      id: R.helper,
      threadId: T.lisbon,
      kind: "subagent",
      origin: "subagent",
      title: "Compare neighbourhoods",
      parentRunId: R.done,
      rootRunId: R.done,
      status: "done",
      startedAt: today("09:20", "21"),
      endedAt: today("09:20", "52"),
      stepCount: 2,
      usage: usage(6100, 420, 0.021),
    }),
    traceRun({
      id: R.failed,
      threadId: T.main,
      kind: "task",
      title: "Subscription audit",
      taskId: IDS.tasks.subscriptionAudit,
      status: "failed",
      error: "The bank's site kept timing out.",
      startedAt: today("08:30"),
      endedAt: today("08:31", "45"),
      stepCount: 3,
      usage: usage(8800, 540, 0.031),
    }),
    traceRun({
      id: R.live,
      threadId: T.dentist,
      kind: "task",
      title: "Dentist booking",
      taskId: IDS.tasks.dentist,
      status: "running",
      startedAt: today("10:10", "30"),
      endedAt: null,
      stepCount: 3,
      currentStepId: "stp_trace_dentist_03",
      lastStepAt: today("10:11", "40"),
      budget: {
        limit: { steps: 40, wallMs: 15 * 60_000 },
        used: { steps: 3, tokens: 9200, wallMs: 90_000, costUsd: 0.04 },
      },
      usage: usage(9200, 380, 0.04),
    }),
    ...brief,
  ];
}

/** The automation runs behind `traceRuns()`'s morning briefs. */
export function traceAutomationRuns(): AutomationRun[] {
  return traceRuns()
    .filter((r) => r.kind === "automation")
    .map((r, i) => ({
      id: TRACE_IDS.automationRuns(i + 1),
      automationId: IDS.automations.morningBrief,
      threadId: r.threadId,
      taskId: null,
      trigger: "schedule",
      scheduledFor: r.startedAt,
      coalesced: 1,
      startedAt: r.startedAt,
      endedAt: r.endedAt ?? null,
      status: "done",
      summary: "Brief ready",
      notificationId: null,
      runId: r.id,
      usage: r.usage,
    }));
}

export function traceSteps(): RunStep[] {
  seqByRun = {};
  const g = TRACE_IDS.groups.searches;
  const done: RunStep[] = [
    step(R.done, {
      id: "rsn_trace_lisbon_01",
      kind: "thinking",
      status: "ok",
      label: "Thinking",
      startedAt: today("09:20"),
      endedAt: today("09:20", "04"),
      text: {
        summary: "Search flights, hotels and neighbourhoods at once",
        full: "Jane wants three nights in Lisbon in May. Flights, hotels and neighbourhoods are independent, so I'll search them together and ask a helper to compare neighbourhoods.",
        expiresAt: at(7 * 86_400),
      },
    }),
    ...(
      [
        ["stp_trace_lisbon_02", "Searching flights", "Searched flights", "google.com/flights", 14],
        ["stp_trace_lisbon_03", "Searching hotels", "Searched hotels", "booking.com", 19],
        ["stp_trace_lisbon_04", "Reading reviews", "Read reviews", "tripadvisor.com", 11],
      ] as const
    ).map(([id, label, doneLabel, target, s]) =>
      step(R.done, {
        id,
        kind: "tool",
        status: "ok",
        groupId: g,
        label,
        doneLabel,
        target,
        startedAt: today("09:20", "05"),
        endedAt: today("09:20", String(5 + s).padStart(2, "0")),
        toolCallId: `tc_${id}`,
        preview: { input: `{"query":"Lisbon ${label.split(" ")[1]}"}`, output: "12 results" },
        payloadRef: { input: `pl_${id}_in`, output: `pl_${id}_out` },
      }),
    ),
    step(R.done, {
      id: "stp_trace_lisbon_05",
      kind: "subagent",
      status: "ok",
      label: "Asking a helper to compare neighbourhoods",
      doneLabel: "A helper compared neighbourhoods",
      startedAt: today("09:20", "21"),
      endedAt: today("09:20", "52"),
      childRunId: R.helper,
    }),
    step(R.done, {
      id: "stp_trace_lisbon_06",
      kind: "approval",
      status: "ok",
      label: "Waiting for you to approve saving to Notion",
      doneLabel: "You approved saving to Notion",
      startedAt: today("09:20", "53"),
      endedAt: today("09:21", "20"),
      approvalId: IDS.approvals.mcpTool,
    }),
    step(R.done, {
      id: "stp_trace_lisbon_07",
      kind: "tool",
      status: "ok",
      label: "Saving to Notion",
      doneLabel: "Saved to Notion",
      target: "notion.so",
      startedAt: today("09:21", "20"),
      endedAt: today("09:21", "24"),
      toolCallId: "tc_stp_trace_lisbon_07",
    }),
    step(R.done, {
      id: "stp_trace_lisbon_08",
      kind: "model",
      status: "ok",
      label: "Writing",
      startedAt: today("09:21", "24"),
      endedAt: today("09:21", "33"),
      modelRef: MODEL,
      usage: usage(15_300, 1410, 0.073),
    }),
    step(R.done, {
      id: "stp_trace_lisbon_09",
      kind: "text",
      status: "ok",
      label: "Replied",
      startedAt: today("09:21", "33"),
      endedAt: today("09:21", "34"),
    }),
  ];
  const helper: RunStep[] = [
    step(R.helper, {
      id: "stp_trace_helper_01",
      kind: "tool",
      status: "ok",
      parentStepId: "stp_trace_lisbon_05",
      label: "Reading about Alfama and Príncipe Real",
      doneLabel: "Read about Alfama and Príncipe Real",
      target: "wikivoyage.org",
      startedAt: today("09:20", "22"),
      endedAt: today("09:20", "40"),
    }),
    step(R.helper, {
      id: "stp_trace_helper_02",
      kind: "text",
      status: "ok",
      parentStepId: "stp_trace_lisbon_05",
      label: "Reported back",
      startedAt: today("09:20", "50"),
      endedAt: today("09:20", "52"),
    }),
  ];
  const failed: RunStep[] = [
    step(R.failed, {
      id: "stp_trace_audit_01",
      kind: "tool",
      status: "ok",
      label: "Opening your bank",
      doneLabel: "Opened your bank",
      target: "bank.example",
      startedAt: today("08:30", "02"),
      endedAt: today("08:30", "09"),
    }),
    step(R.failed, {
      id: "stp_trace_audit_02",
      kind: "tool",
      status: "failed",
      label: "Reading statements",
      doneLabel: "Couldn't read statements",
      target: "bank.example",
      startedAt: today("08:30", "40"),
      endedAt: today("08:31", "40"),
      attempt: 2,
      attempts: [
        {
          startedAt: today("08:30", "10"),
          endedAt: today("08:30", "40"),
          status: "failed",
          error: { code: "timeout", message: "The page took too long to load.", retryable: true },
        },
      ],
      error: { code: "timeout", message: "The page took too long to load.", retryable: false },
      frames: { first: 1, last: 2 },
    }),
    step(R.failed, {
      id: "stp_trace_audit_03",
      kind: "note",
      status: "ok",
      label: "Stopped after two tries",
      startedAt: today("08:31", "41"),
      endedAt: today("08:31", "45"),
    }),
  ];
  const live: RunStep[] = [
    step(R.live, {
      id: "stp_trace_dentist_01",
      kind: "tool",
      status: "ok",
      label: "Opening Dr. Ortiz's booking page",
      doneLabel: "Opened Dr. Ortiz's booking page",
      target: "ortizdental.example",
      startedAt: today("10:10", "31"),
      endedAt: today("10:10", "38"),
      frames: { first: 1, last: 1 },
    }),
    step(R.live, {
      id: "rsn_trace_dentist_02",
      kind: "thinking",
      status: "ok",
      label: "Thinking",
      startedAt: today("10:10", "38"),
      endedAt: today("10:10", "41"),
      text: { summary: "Afternoon slots only" },
    }),
    step(R.live, {
      id: "stp_trace_dentist_03",
      kind: "tool",
      status: "running",
      label: "Checking open slots",
      doneLabel: "Checked open slots",
      target: "ortizdental.example",
      startedAt: today("10:11", "40"),
      progress: { message: "Week 2 of 3", fraction: 0.66 },
    }),
  ];
  const brief = traceRuns()
    .filter((r) => r.kind === "automation")
    .flatMap((r) => [
      step(r.id, {
        id: `stp_${r.id}_01`,
        kind: "tool",
        status: "ok",
        label: "Reading your calendar",
        doneLabel: "Read your calendar",
        startedAt: r.startedAt,
        endedAt: r.startedAt,
      }),
    ]);
  return [...done, ...helper, ...failed, ...live, ...brief];
}

export function traceFrames(): Record<string, RunFrame[]> {
  return {
    [R.failed]: [
      { seq: 1, at: today("08:30", "15"), stepId: "stp_trace_audit_02", width: 1280, height: 800 },
      { seq: 2, at: today("08:31", "20"), stepId: "stp_trace_audit_02", width: 1280, height: 800 },
    ],
    [R.live]: [
      {
        seq: 1,
        at: today("10:10", "36"),
        stepId: "stp_trace_dentist_01",
        width: 1280,
        height: 800,
      },
    ],
  };
}

/** Tool inputs and outputs behind `payloadRef`, by `<runId>/<stepId>` (redacted, as stored). */
export function tracePayloads(): Record<string, { input?: unknown; output?: unknown }> {
  return {
    [`${R.done}/stp_trace_lisbon_02`]: {
      input: { query: "Lisbon flights", from: "SFO", month: "May" },
      output: { results: 12, cheapest: "$612 TAP nonstop" },
    },
    [`${R.done}/stp_trace_lisbon_07`]: {
      input: { page: "Lisbon trip", token: "‹vault: notion›" },
      output: { ok: true },
    },
  };
}

/** The run-trace part of a world, for stories and tests that show steps. */
export function runTraceWorld() {
  return {
    runs: traceRuns(),
    runSteps: traceSteps(),
    runFrames: traceFrames(),
    runPayloads: tracePayloads(),
    automationRuns: traceAutomationRuns(),
  };
}
