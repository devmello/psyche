import type { Meta, StoryObj } from "@storybook/react-vite";
import { createFixtureWorld, IDS } from "../../fixtures/index.ts";
import { FeedPostCard } from "./FeedPostCard.tsx";

const world = createFixtureWorld();
const post = (id: string) => {
  const p = world.feed.find((x) => x.id === id);
  if (p === undefined) throw new Error(`fixture post ${id} missing`);
  return p;
};

const meta = {
  title: "Screens/Feed/Post card",
  component: FeedPostCard,
  args: { post: post(IDS.feed.briefing), onFeedback: () => {}, onAsk: () => {} },
} satisfies Meta<typeof FeedPostCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Briefing: Story = {};
export const Reminder: Story = { args: { post: post(IDS.feed.reminder) } };
export const Suggestion: Story = { args: { post: post(IDS.feed.suggestion) } };
export const WatchResultLiked: Story = { args: { post: post(IDS.feed.watch) } };
export const NewsCluster: Story = { args: { post: post(IDS.feed.news) } };
export const ExplorationSlot: Story = { args: { post: post(IDS.feed.exploration) } };
export const Saved: Story = {
  args: { post: { ...post(IDS.feed.lisbon), feedback: "save" } },
};
