import type { Meta, StoryObj } from "@storybook/react-vite";
import { createFixtureWorld, IDS } from "../../fixtures/index.ts";
import { withWorld } from "../../stories/harness.tsx";
import { IdeaCard } from "./IdeaCard.tsx";
import { IdeasScreen, IdeasView } from "./IdeasScreen.tsx";

const world = createFixtureWorld();
const idea = (id: string) => {
  const i = world.ideas.find((x) => x.id === id);
  if (i === undefined) throw new Error(`fixture idea ${id} missing`);
  return i;
};

const meta = {
  title: "Screens/Ideas/Ideas",
  component: IdeasScreen,
  decorators: [withWorld()],
  args: { onEdit: () => {} },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof IdeasScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Proposed: Story = {};

export const Empty: Story = {
  decorators: [
    withWorld({
      edit: (w) => {
        w.ideas = [];
      },
    }),
  ],
};

export const Loading: Story = { render: () => <IdeasView ideas={[]} loading /> };

export const LoadError: Story = {
  render: () => <IdeasView ideas={[]} error="the Gateway timed out" onRetry={() => {}} />,
};

export const TaskCard: Story = {
  render: () => (
    <IdeaCard
      idea={idea(IDS.ideas.subscription)}
      onAccept={() => {}}
      onEdit={() => {}}
      onDismiss={() => {}}
      onOpenRoute={() => {}}
    />
  ),
};

export const SkillDraft: Story = {
  render: () => (
    <IdeaCard
      idea={idea(IDS.ideas.skill)}
      onAccept={() => {}}
      onEdit={() => {}}
      onDismiss={() => {}}
      onViewSkill={() => {}}
      onOpenRoute={() => {}}
    />
  ),
};

export const Busy: Story = {
  render: () => (
    <IdeaCard
      idea={idea(IDS.ideas.automation)}
      busy
      onAccept={() => {}}
      onEdit={() => {}}
      onDismiss={() => {}}
    />
  ),
};

/** The same screen in dark appearance (the visual baseline shoots Screens/* in light only). */
export const Dark: Story = { globals: { theme: "dark" } };

/** Compact width (web < 720 px, redesign §5.11): 16 px gutters, the same tokens. */
export const Compact: Story = {
  decorators: [
    (S) => (
      <div className="w-[390px]">
        <S />
      </div>
    ),
  ],
};
