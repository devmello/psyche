import type { Meta, StoryObj } from "@storybook/react-vite";
import { IDS } from "../fixtures/index.ts";
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
