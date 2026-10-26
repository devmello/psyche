import type { Message, RunStep } from "@psyche/protocol";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { type createFixtureWorld, IDS } from "../../fixtures/index.ts";
import { runTraceWorld, TRACE_IDS } from "../../fixtures/runs.ts";
import { STORY_NOW, withWorld } from "../../stories/harness.tsx";
import { ChatThread } from "../Thread.tsx";
import { RunTrace } from "./RunTrace.tsx";

/** The chat's steps (docs/design/run-trace-2026.md §3.2), on the run-trace fixtures. */
const meta = { title: "Chat/Run steps", parameters: { layout: "fullscreen" } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

type World = ReturnType<typeof createFixtureWorld>;
const R = TRACE_IDS.runs;

/**
 * Puts the trace runs into the world and makes `runId` the thread's chat turn: its own runs end,
 * it holds the writer while live, and one reply message anchors it.
 */
function traceWorld(
  threadId: string,
  runId: string,
  options: {
    live?: boolean;
    steps?: (steps: RunStep[]) => RunStep[];
    incognito?: boolean;
  } = {},
) {
  return (w: World) => {
    const trace = runTraceWorld();
    const live = options.live ?? false;
    w.runs = [
      ...w.runs.map((r) => (r.threadId === threadId ? { ...r, status: "done" as const } : r)),
      ...trace.runs.map((r) =>
        r.id === runId
          ? {
              ...r,
              threadId,
              kind: "chat" as const,
              ...(live ? { status: "running" as const, endedAt: null } : {}),
            }
          : r,
      ),
    ];
    const steps = trace.runSteps;
    w.runSteps = options.steps ? options.steps(steps) : steps;
    w.runFrames = trace.runFrames;
    w.threads = w.threads.map((th) =>
      th.thread.id === threadId
        ? {
            ...th,
            thread: {
              ...th.thread,
              activeWriterRunId: live ? runId : null,
              ...(options.incognito ? { kind: "incognito" as const } : {}),
            },
          }
        : th,
    );
    const reply: Message = {
      id: `msg_story_${runId}`,
      threadId,
      seq: 990,
      role: "agent",
      blocks: [{ type: "text", md: live ? "On it." : "Here's what I found." }],
      providerNative: null,
      provenance: "agent",
      replyToMessageId: null,
      channelRef: null,
      runId,
      createdAt: new Date(STORY_NOW - 60_000).toISOString(),
    };
    w.messages.push(reply);
  };
}

/** Make the named steps (or all from `fromSeq`) still running. */
const running =
  (runId: string, ids: readonly string[]) =>
  (steps: RunStep[]): RunStep[] =>
    steps.map((s) =>
      s.runId === runId && ids.includes(s.id) ? { ...s, status: "running", endedAt: null } : s,
    );
const until =
  (runId: string, lastSeq: number, patch: (s: RunStep) => RunStep = (s) => s) =>
  (steps: RunStep[]): RunStep[] =>
    steps
      .filter((s) => s.runId !== runId || s.seq <= lastSeq)
      .map((s) => (s.runId === runId && s.seq === lastSeq ? patch(s) : s));

const thread =
  (threadId: string, now = STORY_NOW) =>
  () => (
    <div className="flex h-[720px] flex-col">
      <ChatThread threadId={threadId} now={now} />
    </div>
  );

export const LiveRun: Story = {
  decorators: [withWorld({ edit: traceWorld(IDS.threads.dentist, R.live, { live: true }) })],
  render: thread(IDS.threads.dentist),
};

export const ParallelGroup: Story = {
  decorators: [
    withWorld({
      edit: traceWorld(IDS.threads.lisbon, R.done, {
        live: true,
        steps: (s) =>
          running(R.done, ["stp_trace_lisbon_03", "stp_trace_lisbon_04"])(until(R.done, 4)(s)),
      }),
    }),
  ],
  render: thread(IDS.threads.lisbon, Date.parse("2026-10-18T09:20:12Z")),
};

export const Helper: Story = {
  decorators: [
    withWorld({
      edit: traceWorld(IDS.threads.lisbon, R.done, {
        live: true,
        steps: (s) =>
          running(R.helper, ["stp_trace_helper_02"])(
            running(R.done, ["stp_trace_lisbon_05"])(until(R.done, 5)(s)),
          ),
      }),
    }),
  ],
  render: thread(IDS.threads.lisbon, Date.parse("2026-10-18T09:20:45Z")),
};

export const ApprovalWait: Story = {
  decorators: [
    withWorld({
      edit: traceWorld(IDS.threads.lisbon, R.done, {
        live: true,
        steps: until(R.done, 6, (s) => ({ ...s, status: "waiting", endedAt: null })),
      }),
    }),
  ],
  render: thread(IDS.threads.lisbon, Date.parse("2026-10-18T09:21:00Z")),
};

export const Stalled: Story = {
  decorators: [withWorld({ edit: traceWorld(IDS.threads.dentist, R.live, { live: true }) })],
  render: thread(IDS.threads.dentist, Date.parse("2026-10-18T10:12:25Z")),
};

export const FailedWithRetry: Story = {
  decorators: [withWorld({ edit: traceWorld(IDS.threads.main, R.failed) })],
  render: thread(IDS.threads.main),
};

export const DoneSummary: Story = {
  decorators: [withWorld({ edit: traceWorld(IDS.threads.lisbon, R.done) })],
  render: thread(IDS.threads.lisbon),
};

export const DoneSummaryExpanded: Story = {
  decorators: [withWorld({ edit: traceWorld(IDS.threads.lisbon, R.done) })],
  render: () => (
    <div className="max-w-[680px] p-6">
      <RunTrace runId={R.done} defaultOpen now={STORY_NOW} />
    </div>
  ),
};

export const Incognito: Story = {
  decorators: [withWorld({ edit: traceWorld(IDS.threads.lisbon, R.done, { incognito: true }) })],
  render: thread(IDS.threads.lisbon),
};

export const ReducedMotion: Story = {
  ...LiveRun,
  globals: { motion: "reduced" },
};
