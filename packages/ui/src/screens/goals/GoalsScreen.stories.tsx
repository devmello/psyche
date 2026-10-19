import type { Meta, StoryObj } from "@storybook/react-vite";
import { createFixtureWorld, IDS } from "../../fixtures/index.ts";
import { withWorld } from "../../stories/harness.tsx";
import { GoalPage, GoalPageView } from "./GoalPage.tsx";
import { CandidateGoalCard, GoalsScreen, GoalsView } from "./GoalsScreen.tsx";

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
