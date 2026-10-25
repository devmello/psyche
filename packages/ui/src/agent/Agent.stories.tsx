import type { Meta, StoryObj } from "@storybook/react-vite";
import { withWorld } from "../stories/harness.tsx";
import { AgentHeader } from "./AgentHeader.tsx";

const meta = {
  title: "Agent/Header and sheet",
  decorators: [withWorld()],
  parameters: { layout: "fullscreen" },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const Header: Story = {
  render: () => (
    <AgentHeader
      onOpenSheet={() => {}}
      mode="balanced"
      onModeChange={() => {}}
      model="anthropic/claude-sonnet-5-5"
      onOpenModelPicker={() => {}}
      onOpenInbox={() => {}}
    />
  ),
};

export const HeaderIdle: Story = {
  decorators: [
    withWorld({
      edit: (w) => {
        w.approvals = w.approvals.filter((a) => a.status !== "pending");
        w.inputRequests = w.inputRequests.filter((q) => q.status !== "open");
        w.tasks = w.tasks.map((t) => ({ ...t, status: "done" as const }));
      },
    }),
  ],
  render: () => <AgentHeader onOpenSheet={() => {}} mode="balanced" />,
};

export const HeaderOffline: Story = {
  decorators: [withWorld({ options: { connection: "offline" } })],
  render: () => <AgentHeader onOpenSheet={() => {}} />,
};
