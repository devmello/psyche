import type { Meta, StoryObj } from "@storybook/react-vite";
import { growthFeedPost } from "../fixtures/index.ts";
import { FeedPostCard } from "../screens/feed/FeedPostCard.tsx";
import { LearningGroup } from "../screens/settings/LearningGroup.tsx";
import { withWorld } from "../stories/harness.tsx";
import { GrowthPanel } from "./GrowthPanel.tsx";

/** Growth, the weekly card and the Learning settings (docs/agent/teaching-loop-2026.md §5.3–5.4, §8). */
const meta = {
  title: "Teaching/Growth",
  decorators: [withWorld()],
  parameters: { layout: "padded" },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

const panel = (width = "max-w-[400px]") => (
  <div className={width}>
    <GrowthPanel />
  </div>
);

/** Thirty days: lessons and milestones by week, then what got better. */
export const Populated: Story = { render: () => panel() };

/** Nothing learned yet: one sentence, no action. */
export const Empty: Story = {
  decorators: [
    withWorld({
      edit: (w) => {
        w.lessons = [];
        w.milestones = [];
      },
    }),
  ],
  render: () => panel(),
};

export const Loading: Story = {
  decorators: [withWorld({ options: { latency: 60_000 } })],
  render: () => panel(),
};

export const LoadError: Story = {
  decorators: [
    withWorld({ onGateway: (g) => g.failNext("growth.summary", "unavailable", "offline") }),
  ],
  render: () => panel(),
};

export const Dark: Story = { ...Populated, globals: { theme: "dark" } };

/** The narrow sheet: rows wrap, the period control stays on one line. */
export const Compact: Story = { render: () => panel("max-w-[320px]") };

/** The weekly "What I learned" Feed post: lessons, a question, a retirement. */
export const WeeklyCard: Story = {
  render: () => (
    <div className="max-w-[560px]">
      <FeedPostCard post={growthFeedPost()} />
    </div>
  ),
};

export const WeeklyCardDark: Story = { ...WeeklyCard, globals: { theme: "dark" } };

/** Settings → Data controls → Learning. */
export const Settings: Story = {
  render: () => (
    <div className="max-w-[560px]">
      <LearningGroup
        values={{}}
        onChange={() => {}}
        persona="Wren"
        onOpenGrowth={() => {}}
        onForgetAll={() => {}}
      />
    </div>
  ),
};
