import type { Meta, StoryObj } from "@storybook/react-vite";
import { IDS } from "../fixtures/index.ts";
import { StoryWorld } from "../stories/harness.tsx";
import { PlanForkCard } from "./ForkCard.tsx";
import { seedPlanForks } from "./mock-plan-fork.ts";
import { PlansView } from "./PlansView.tsx";
import { PlanForkStartSheet } from "./StartSheet.tsx";

/**
 * Fork a plan (docs/design/fork-a-plan-2026.md §5): the fork card in the transcript, the Plans
 * view with its lanes and comparison, and the start sheet, over the mock `planForks.*` handlers.
 */
const meta = {
  title: "Chat/Fork a plan",
  parameters: { layout: "padded" },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const RunningCard: Story = {
  render: () => (
    <StoryWorld
      edit={(w) => {
        w.planForks = seedPlanForks("running", IDS.threads.main);
      }}
    >
      <PlanForkCard forkId="fork_1" now={Date.parse("2026-11-25T09:01:05Z")} />
    </StoryWorld>
  ),
};

export const ReadyCard: Story = {
  render: () => (
    <StoryWorld
      edit={(w) => {
        w.planForks = seedPlanForks("ready", IDS.threads.main);
      }}
    >
      <PlanForkCard forkId="fork_1" />
    </StoryWorld>
  ),
};

export const PlansColumns: Story = {
  render: () => (
    <StoryWorld
      edit={(w) => {
        w.planForks = seedPlanForks("ready", IDS.threads.main);
      }}
    >
      <PlansView forkId="fork_1" onBack={() => {}} layout="columns" />
    </StoryWorld>
  ),
};

export const PlansTabs: Story = {
  render: () => (
    <StoryWorld
      edit={(w) => {
        w.planForks = seedPlanForks("ready", IDS.threads.main);
      }}
    >
      <PlansView forkId="fork_1" onBack={() => {}} layout="tabs" />
    </StoryWorld>
  ),
};

export const StartSheet: Story = {
  render: () => (
    <StoryWorld
      edit={(w) => {
        w.planForks = { forks: [], branches: [], staged: {} };
      }}
    >
      <PlanForkStartSheet
        open
        onOpenChange={() => {}}
        threadId={IDS.threads.main}
        messageId={IDS.messages.mainAgent}
        onStarted={() => {}}
      />
    </StoryWorld>
  ),
};
