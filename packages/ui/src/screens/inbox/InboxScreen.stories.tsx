import type { Meta, StoryObj } from "@storybook/react-vite";
import { createFixtureWorld, IDS } from "../../fixtures/index.ts";
import { STORY_NOW, withWorld } from "../../stories/harness.tsx";
import { InboxRow, InboxScreen, InboxView } from "./InboxScreen.tsx";

const world = createFixtureWorld();
const notification = (id: string) => {
  const n = world.notifications.find((x) => x.id === id);
  if (n === undefined) throw new Error(`fixture notification ${id} missing`);
  return n;
};
const approval = (id: string) => {
  const a = world.approvals.find((x) => x.id === id);
  if (a === undefined) throw new Error(`fixture approval ${id} missing`);
  return a;
};

const meta = {
  title: "Screens/Inbox/Inbox",
  component: InboxScreen,
  decorators: [withWorld()],
  args: { now: STORY_NOW },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof InboxScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

export const AllKinds: Story = {};

export const StaleAfterRestart: Story = {
  decorators: [
    withWorld({
      edit: (w) => {
        for (const n of w.notifications)
          if (n.kind === "input_needed") {
            n.staleAt = "2026-10-18T10:00:00Z";
            n.staleReason = "the Gateway restarted; the question was re-asked in chat";
          }
      },
    }),
  ],
};

export const Empty: Story = {
  decorators: [
    withWorld({
      edit: (w) => {
        w.notifications = [];
      },
    }),
  ],
};

export const Loading: Story = {
  render: () => <InboxView notifications={[]} now={STORY_NOW} loading />,
};

export const LoadError: Story = {
  render: () => (
    <InboxView
      notifications={[]}
      now={STORY_NOW}
      error="the Gateway timed out"
      onRetryLoad={() => {}}
    />
  ),
};

export const ApprovalInline: Story = {
  render: () => (
    <InboxRow
      notification={notification(IDS.notifications.approval)}
      now={STORY_NOW}
      approval={{ approval: approval(IDS.approvals.sendEmail), canAnswer: true, stale: false }}
      onApprove={() => {}}
      onDeny={() => {}}
      onMarkRead={() => {}}
    />
  ),
};

export const ApprovalNeedsFullCard: Story = {
  render: () => (
    <InboxRow
      notification={{
        ...notification(IDS.notifications.approval),
        title: "Buy 2 tickets to Lisbon",
        approvalId: IDS.approvals.purchase,
      }}
      now={STORY_NOW}
      approval={{ approval: approval(IDS.approvals.purchase), canAnswer: true, stale: false }}
      onOpen={() => {}}
    />
  ),
};

export const ApprovalStale: Story = {
  render: () => (
    <InboxRow
      notification={notification(IDS.notifications.approval)}
      now={STORY_NOW}
      approval={{ approval: approval(IDS.approvals.sendEmail), canAnswer: false, stale: true }}
      onOpen={() => {}}
    />
  ),
};
