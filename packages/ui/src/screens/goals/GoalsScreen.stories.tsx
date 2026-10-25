import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { Button } from "../../components/ui/button.tsx";
import { createFixtureWorld, IDS } from "../../fixtures/index.ts";
import { withWorld } from "../../stories/harness.tsx";
import { GoalPage, GoalPageView } from "./GoalPage.tsx";
import { CandidateGoalCard, GoalsScreen, GoalsView } from "./GoalsScreen.tsx";
import { MilestoneTrack } from "./MilestoneTrack.tsx";

const world = createFixtureWorld();
const goal = (id: string) => {
  const g = world.goals.find((x) => x.id === id);
  if (g === undefined) throw new Error(`fixture goal ${id} missing`);
  return g;
};

/** The mock links tasks created from goals; mark two fixture tasks as such. */
const withGoalTasks = withWorld({
  edit: (w) => {
    for (const t of w.tasks)
      if (t.id === IDS.tasks.priceWatch || t.id === IDS.tasks.lisbon) t.createdFrom = "goal";
  },
});

const meta = {
  title: "Screens/Goals/Goals",
  component: GoalsScreen,
  decorators: [withWorld()],
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof GoalsScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

export const List: Story = {};

export const WithGoalPage: Story = {
  args: { selectedGoalId: IDS.goals.halfMarathon, onDeleteGoal: () => undefined },
  decorators: [withGoalTasks],
};

export const Empty: Story = {
  decorators: [
    withWorld({
      edit: (w) => {
        w.goals = [];
      },
    }),
  ],
};

export const OnlyCandidate: Story = {
  decorators: [
    withWorld({
      edit: (w) => {
        w.goals = w.goals.filter((g) => g.status === "candidate");
      },
    }),
  ],
};

export const Loading: Story = { render: () => <GoalsView goals={[]} loading /> };

export const LoadError: Story = {
  render: () => <GoalsView goals={[]} error="the Gateway timed out" onRetry={() => {}} />,
};

export const InferredGoalCard: Story = {
  render: () => (
    <CandidateGoalCard
      goal={goal(IDS.goals.candidate)}
      onDecide={() => {}}
      onOpenRoute={() => {}}
    />
  ),
};

export const GoalPageConnected: Story = {
  decorators: [withGoalTasks],
  render: () => <GoalPage goalId={IDS.goals.halfMarathon} onDelete={() => undefined} />,
};

export const GoalPageSparse: Story = {
  render: () => <GoalPage goalId={IDS.goals.career} onDelete={() => undefined} />,
};

export const GoalPageLoading: Story = {
  render: () => <GoalPageView goal={null} loading />,
};

export const GoalPageError: Story = {
  render: () => <GoalPageView goal={null} error="goal not found" onRetry={() => {}} />,
};

/** The split layout in dark appearance (Screens/* baselines shoot light only). */
export const Dark: Story = {
  ...WithGoalPage,
  globals: { theme: "dark" },
};

/** Compact width (§5.11): the list stacks above the goal page. */
export const Compact: Story = {
  ...WithGoalPage,
  decorators: [
    withGoalTasks,
    (S) => (
      <div className="w-[390px]">
        <S />
      </div>
    ),
  ],
};

/** The milestone track completing on spring.emphasis (a fade and an instant fill when reduced). */
export const MilestoneComplete: Story = {
  render: function Render() {
    const [done, setDone] = useState(2);
    const titles = ["10k", "15k", "18k", "Race day"];
    return (
      <div className="flex max-w-xl flex-col gap-4 p-6">
        <MilestoneTrack
          milestones={titles.map((title, i) => ({ title, done: i < done, dueAt: null }))}
        />
        <div className="flex gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setDone((n) => Math.max(0, n - 1))}
          >
            Undo
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => setDone((n) => Math.min(titles.length, n + 1))}
          >
            Complete next
          </Button>
        </div>
      </div>
    );
  },
};
