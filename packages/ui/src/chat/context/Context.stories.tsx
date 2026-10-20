import type { Meta, StoryObj } from "@storybook/react-vite";
import { withWorld } from "../../stories/harness.tsx";
import { CompactionMarker } from "./CompactionMarker.tsx";
import { ContextMeter } from "./ContextMeter.tsx";
import type { CompactionView, ContextUsageView } from "./types.ts";

const usage = (used: number, exact = true): ContextUsageView => ({
  used,
  limit: 200_000,
  compactAt: 160_000,
  exact,
  limitFrom: "model",
  breakdown: {
    system: 6_200,
    tools: 9_800,
    context: 4_100,
    history: used - 6_200 - 9_800 - 4_100 - 900,
    current: 900,
  },
});

const compaction: CompactionView = {
  id: "cmp_1",
  trigger: "auto",
  tokensBefore: 148_200,
  tokensAfter: 3_100,
  replacedTurns: 42,
  summary: {
    facts: [
      "The dentist appointment is Tuesday 2:30 with Dr. Ortiz.",
      "The owner prefers mornings.",
    ],
    decisions: ["Avoid Fridays for appointments."],
    openTasks: ["Confirm the insurance form before Monday."],
    pinnedInstructions: ["Always give times in 24-hour format."],
  },
  createdAt: "2026-10-20T10:00:00Z",
};

const meta = {
  title: "Chat/Context",
  decorators: [withWorld()],
  parameters: { layout: "padded" },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const MeterLow: Story = {
  render: () => <ContextMeter usage={usage(42_000)} onCompact={() => {}} />,
};
export const MeterNearThreshold: Story = {
  render: () => <ContextMeter usage={usage(141_000)} onCompact={() => {}} />,
};
export const MeterPastThreshold: Story = {
  render: () => <ContextMeter usage={usage(171_000)} onCompact={() => {}} />,
};
export const MeterThreadLimit: Story = {
  render: () => (
    <ContextMeter
      usage={{ ...usage(41_000), limit: 64_000, compactAt: 51_200, limitFrom: "thread" }}
      onCompact={() => {}}
      onEditLimits={() => {}}
    />
  ),
};
export const MeterEstimate: Story = { render: () => <ContextMeter usage={usage(58_000, false)} /> };
export const MeterCompacting: Story = {
  render: () => <ContextMeter usage={usage(171_000)} onCompact={() => {}} compacting />,
};
export const CompactionCollapsed: Story = {
  render: () => <CompactionMarker compaction={compaction} onShowReplaced={() => {}} />,
};
export const CompactionExpanded: Story = {
  render: () => <CompactionMarker compaction={compaction} onShowReplaced={() => {}} defaultOpen />,
};
