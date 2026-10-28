import type { Meta, StoryObj } from "@storybook/react-vite";
import { sampleEvents, sampleReport } from "./fixtures.ts";
import { foldResearch } from "./model.ts";
import { ResearchProgress } from "./ResearchProgress.tsx";
import { ResearchReport } from "./ResearchReport.tsx";

const meta = {
  title: "Chat/Deep research",
  parameters: { layout: "padded" },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const Running: Story = {
  render: () => <ResearchProgress view={foldResearch(sampleEvents)} onStop={() => {}} />,
};

export const Stopped: Story = {
  render: () => <ResearchProgress view={foldResearch([...sampleEvents, { type: "stopped" }])} />,
};

export const Done: Story = {
  render: () => (
    <ResearchProgress
      view={foldResearch([...sampleEvents, { type: "done", artifactId: "art_1" }])}
      onOpenReport={() => {}}
    />
  ),
};

export const Report: Story = {
  render: () => <ResearchReport report={sampleReport} onDigDeeper={() => {}} onAsk={() => {}} />,
};
