import type { Meta, StoryObj } from "@storybook/react-vite";
import { withWorld } from "../stories/harness.tsx";
import { AgentHeader } from "./AgentHeader.tsx";

/** The chat column's toolbar content (redesign-2026 §4, §5.2). */
const meta = {
  title: "Agent/Header",
  decorators: [withWorld()],
  parameters: { layout: "fullscreen" },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

const handlers = {
  onOpenSheet: () => {},
  onModeChange: () => {},
  onOpenModelPicker: () => {},
  onOpenInbox: () => {},
  onExport: () => {},
  onDisclosureChange: () => {},
};

export const Toolbar: Story = {
  render: () => (
    <AgentHeader {...handlers} mode="balanced" model="anthropic/claude-sonnet-5-5" disclosure={1} />
  ),
};

export const Idle: Story = {
  decorators: [
    withWorld({
      edit: (w) => {
        w.approvals = w.approvals.filter((a) => a.status !== "pending");
        w.inputRequests = w.inputRequests.filter((q) => q.status !== "open");
        w.tasks = w.tasks.map((t) => ({ ...t, status: "done" as const }));
        w.runs = w.runs.map((r) => ({ ...r, status: "done" as const }));
      },
    }),
  ],
  render: () => <AgentHeader onOpenSheet={() => {}} mode="balanced" model="openai/gpt-5-mini" />,
};

export const Incognito: Story = {
  render: () => (
    <AgentHeader {...handlers} incognito mode="manual" model="anthropic/claude-haiku-5-5" />
  ),
};

export const Offline: Story = {
  decorators: [withWorld({ options: { connection: "offline" } })],
  render: () => <AgentHeader onOpenSheet={() => {}} />,
};

export const Dark: Story = {
  ...Toolbar,
  globals: { theme: "dark" },
};
