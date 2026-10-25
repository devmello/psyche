import type { Meta, StoryObj } from "@storybook/react-vite";
import { createFixtureWorld } from "../../fixtures/index.ts";
import { withWorld } from "../../stories/harness.tsx";
import { FeedScreen, FeedView } from "./FeedScreen.tsx";

const world = createFixtureWorld();

const meta = {
  title: "Screens/Feed/Feed",
  component: FeedScreen,
  decorators: [withWorld()],
  args: { onAsk: () => {}, onEditInstructions: () => {}, onSchedule: () => {} },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof FeedScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Today: Story = {};

export const WithFeedback: Story = {
  decorators: [
    withWorld({
      edit: (w) => {
        for (const p of w.feed) if (p.feedback === null && p.exploration) p.feedback = "save";
      },
    }),
  ],
};

export const FirstRun: Story = {
  decorators: [
    withWorld({
      edit: (w) => {
        w.feed = [];
      },
    }),
  ],
};

export const SourceFailures: Story = {
  args: {
    sourceFailures: [
      { source: "Outlook", reason: "needs sign-in", route: "/settings/connectors" },
      { source: "news.example", reason: "timed out" },
    ],
  },
};

export const Generating: Story = {
  render: () => <FeedView posts={[]} nextBriefAt={world.nextBriefAt} generating />,
};

export const Loading: Story = {
  render: () => <FeedView posts={[]} nextBriefAt={null} loading />,
};

export const LoadError: Story = {
  render: () => (
    <FeedView posts={[]} nextBriefAt={null} error="the Gateway timed out" onRetry={() => {}} />
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
