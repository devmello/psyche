import type { Meta, StoryObj } from "@storybook/react-vite";
import { IDS } from "../fixtures/index.ts";
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
    />
  ),
};

export const OfflineBannerOnly: Story = { render: () => <OfflineBanner state="offline" /> };
