import type { Meta, StoryObj } from "@storybook/react-vite";
import { type createFixtureWorld, IDS } from "../fixtures/index.ts";
import { addLongConversation } from "../fixtures/long-thread.ts";
import { STORY_NOW, withWorld } from "../stories/harness.tsx";
import { FollowUpQueue } from "./FollowUpQueue.tsx";
import { OfflineBanner } from "./OfflineBanner.tsx";
import { ChatThread } from "./Thread.tsx";

const meta = { title: "Chat/Thread", parameters: { layout: "fullscreen" } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const DentistBooking: Story = {
  decorators: [withWorld()],
  render: () => (
    <div className="h-[900px]">
      <ChatThread threadId={IDS.threads.dentist} now={STORY_NOW} />
    </div>
  ),
};

/** Redesign 2026 §5.2: the main chat at rest (no run, nothing pending). */
export const Idle: Story = {
  decorators: [
    withWorld({
      edit: (w) => {
        w.runs = w.runs.map((r) => ({ ...r, status: "done" as const }));
        w.approvals = w.approvals.map((a) =>
          a.status === "pending" ? { ...a, status: "approved" as const } : a,
        );
      },
    }),
  ],
  render: () => (
    <div className="flex h-[720px] flex-col">
      <ChatThread threadId={IDS.threads.main} now={STORY_NOW} />
    </div>
  ),
};

/** Before the first message: the 64 px avatar, the name and three suggestion chips. */
export const EmptySideChat: Story = {
  decorators: [
    withWorld({
      edit: (w) => {
        w.messages = w.messages.filter((m) => m.threadId !== IDS.threads.lisbon);
        w.approvals = w.approvals.filter((a) => a.requestedBy.threadId !== IDS.threads.lisbon);
      },
    }),
  ],
  render: () => (
    <div className="flex h-[720px] flex-col">
      <ChatThread threadId={IDS.threads.lisbon} now={STORY_NOW} />
    </div>
  ),
};

/** The column at 390 px (web compact, §5.11). */
export const CompactWidth: Story = {
  decorators: [withWorld()],
  render: () => (
    <div className="flex h-[720px] w-[390px] flex-col">
      <ChatThread threadId={IDS.threads.dentist} now={STORY_NOW} />
    </div>
  ),
};

/** Three pending approvals: the most urgent card in full, two edges peeking, "2 more" (§5.3). */
export const ApprovalsDeck: Story = {
  decorators: [
    withWorld({
      edit: (w) => {
        const base = w.approvals.find((a) => a.id === IDS.approvals.sendEmail);
        if (base)
          w.approvals.push({
            ...base,
            id: "ap_story_third",
            summary: "Add Tuesday 2:30 to your calendar",
            expiresAt: new Date(Date.parse(base.expiresAt) + 600_000).toISOString(),
          });
      },
    }),
  ],
  render: DentistBooking.render,
};

/** Answered approvals: one-line result rows in the transcript, the dock empty (§5.3). */
export const Answered: Story = {
  decorators: [
    withWorld({
      edit: (w) => {
        w.approvals = w.approvals.map((a) =>
          a.status === "pending" && a.requestedBy.threadId === IDS.threads.dentist
            ? { ...a, status: "approved" as const, scopeGranted: "once" as const }
            : a,
        );
      },
    }),
  ],
  render: DentistBooking.render,
};

/** A run with four steps for the step-log stories; `quietFor` seconds since its last event. */
function runWithSteps(quietFor: number) {
  return (w: ReturnType<typeof createFixtureWorld>) => {
    const base = w.runs[0];
    const call = w.toolCalls[0];
    if (base === undefined || call === undefined) return;
    const at = (s: number) => new Date(STORY_NOW - s * 1000).toISOString();
    const run = {
      ...base,
      id: "run_story_steps",
      threadId: IDS.threads.main,
      status: "running" as const,
      startedAt: at(60),
      endedAt: null,
      error: null,
    };
    w.runs = [...w.runs.filter((r) => r.threadId !== IDS.threads.main), run];
    const tool = (id: string, status: typeof call.status, start: number, end: number | null) => ({
      ...call,
      id,
      runId: run.id,
      tool: "web.fetch",
      target: null,
      status,
      startedAt: at(start),
      endedAt: end === null ? null : at(end),
    });
    w.toolCalls.push(
      tool("st_1", "ok", 50, 48),
      tool("st_2", "failed", 40, 39),
      tool("st_3", "ok", 30, 26),
      tool("st_4", "running", 12, null),
    );
    w.threads = w.threads.map((th) =>
      th.thread.id === IDS.threads.main
        ? { ...th, thread: { ...th.thread, activeWriterRunId: run.id } }
        : th,
    );
    w.messages.push({
      id: "msg_story_steps",
      threadId: IDS.threads.main,
      seq: 990,
      role: "agent",
      blocks: [
        { type: "text", md: "Checking the current Node.js LTS before I update the lockfile." },
        {
          type: "tool_call",
          toolCallId: "st_1",
          tool: "web.search",
          status: "ok",
          level1: 'Searched the web for "Node.js LTS"',
        },
        {
          type: "tool_call",
          toolCallId: "st_2",
          tool: "web.fetch",
          status: "failed",
          level1: "Read nodejs.org/en/about/previous-releases (timed out)",
        },
        {
          type: "tool_call",
          toolCallId: "st_3",
          tool: "web.fetch",
          status: "ok",
          level1: "Read nodejs.org",
        },
        {
          type: "tool_call",
          toolCallId: "st_4",
          tool: "exec",
          status: "running",
          level1: "Run npm install in ~/Projects/psyche",
        },
      ],
      providerNative: null,
      provenance: "agent",
      replyToMessageId: null,
      channelRef: null,
      runId: run.id,
      createdAt: at(quietFor),
    });
  };
}

/** #623: a run's step log while it works: past steps, the current one, a failure (§5.2). */
export const RunInProgress: Story = {
  decorators: [withWorld({ edit: runWithSteps(8) })],
  render: () => (
    <div className="flex h-[720px] flex-col">
      <ChatThread threadId={IDS.threads.main} now={STORY_NOW} />
    </div>
  ),
};

/** #633: reasoning streamed by `chat.reasoning` shows as Thinking steps among the tool steps. */
export const RunThinking: Story = {
  decorators: [
    withWorld({
      edit: runWithSteps(8),
      onGateway: (g) => {
        setTimeout(() => {
          const send = (stepId: string, payload: { delta?: string; done?: boolean }) =>
            g.emit("chat.reasoning", {
              threadId: IDS.threads.main,
              runId: "run_story_steps",
              stepId,
              ...payload,
            });
          send("rs_story_1", {
            delta:
              "The lockfile pins Node 24; the owner wants the current LTS.\nCheck nodejs.org first.",
          });
          send("rs_story_1", { done: true });
          send("rs_story_2", { delta: "npm install is running; waiting before I commit." });
        }, 0);
      },
    }),
  ],
  render: RunInProgress.render,
};

/** #623: nothing has happened for 55 s, so the log says so (a freeze is visible). */
export const RunStalled: Story = {
  decorators: [withWorld({ edit: runWithSteps(55) })],
  render: RunInProgress.render,
};

/** Reduced motion: fades only, no movement, static working pulse (motion.md §7). */
export const ReducedMotion: Story = {
  ...DentistBooking,
  globals: { motion: "reduced" },
};

/** Dark appearance: surfaces step up instead of deepening shadows (§3.5). */
export const Dark: Story = {
  ...DentistBooking,
  globals: { theme: "dark" },
};

/** #548: fifty messages scroll inside the viewport; the composer stays pinned. */
export const LongThread: Story = {
  decorators: [withWorld({ edit: (w) => addLongConversation(w, IDS.threads.main, 50) })],
  render: () => (
    <div className="flex h-[600px] flex-col">
      <ChatThread threadId={IDS.threads.main} now={STORY_NOW} />
    </div>
  ),
};

export const Streaming: Story = {
  decorators: [
    withWorld({
      onGateway: (g) => {
        setTimeout(() => {
          g.emit("chat.delta", {
            threadId: IDS.threads.main,
            messageId: "msg_streaming",
            delta: "Looking at your calendar for **next",
          });
        }, 0);
      },
    }),
  ],
  render: () => (
    <div className="h-[600px]">
      <ChatThread threadId={IDS.threads.main} now={STORY_NOW} />
    </div>
  ),
};

export const Offline: Story = {
  decorators: [withWorld({ options: { connection: "offline" } })],
  render: () => (
    <div className="h-[600px]">
      <ChatThread threadId={IDS.threads.dentist} now={STORY_NOW} />
    </div>
  ),
};

export const Queue: Story = {
  render: () => (
    <FollowUpQueue
      items={[
        {
          id: "q1",
          threadId: "t",
          content: "also check Thursday",
          mode: "followUp",
          replyToMessageId: null,
        },
        {
          id: "q2",
          threadId: "t",
          content: "use my work calendar",
          mode: "steer",
          replyToMessageId: null,
        },
      ]}
      onRemove={() => {}}
      onSendNow={() => {}}
    />
  ),
};

export const OfflineBannerOnly: Story = { render: () => <OfflineBanner state="offline" /> };

/** The column follows the chat container, not the window: narrow, medium and very wide. */
function widthStory(width: number): Story {
  return {
    decorators: [withWorld()],
    render: () => (
      <div className="h-[800px] overflow-hidden" style={{ width }}>
        <ChatThread threadId={IDS.threads.main} now={STORY_NOW} />
      </div>
    ),
  };
}
export const Width600: Story = widthStory(600);
export const Width960: Story = widthStory(960);
export const Width1600: Story = widthStory(1600);
