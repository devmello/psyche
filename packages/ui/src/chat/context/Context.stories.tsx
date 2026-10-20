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
  breakdown: {
    systemPrompt: 6_200,
    tools: 9_800,
    memory: 4_100,
    history: used - 6_200 - 9_800 - 4_100 - 900,
    currentMessage: 900,
  },
});

const compaction: CompactionView = {
  id: "msg_compaction_1",
  tokensBefore: 148_200,
  tokensAfter: 3_100,
  replacedCount: 42,
  summaryMd:
    "- Booked the dentist for **Tuesday 2:30** with Dr. Ortiz.\n- The owner prefers mornings; avoid Fridays.\n- Open: confirm the insurance form before Monday.",
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
