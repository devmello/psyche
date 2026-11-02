import type { NudgeItem } from "@psyche/protocol";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { FixtureWorld } from "../fixtures/index.ts";
import { PeopleScreen } from "../people/PeopleScreen.tsx";
import { STORY_NOW, withWorld } from "../stories/harness.tsx";
import { HomeScreen } from "./HomeScreen.tsx";

/**
 * Home (docs/design/consolidation-2026.md §3.1): the fixture world's day. Needs you is amber and
 * holds the one accent (the first Approve); the brief, suggestions, coming up, goals and keep in
 * touch follow. Two columns from 896 px of content, one below.
 */

const nudges: NudgeItem[] = [
  {
    id: "nd_unanswered",
    kind: "unanswered",
    entityId: "ent_priya",
    name: "Priya Rao",
    text: "You haven't replied to Priya Rao's message from 9 days ago.",
    daysAgo: 9,
    channel: "messages",
    date: null,
    overdue: false,
    starters: [
      {
        text: "Ask how the new job at Initech is going",
        evidence: "Employer: Initech · their own words, accepted by you · Oct 12",
      },
      {
        text: "You promised: “send the deck”",
        evidence: "Your promise · Oct 28",
      },
    ],
  },
  {
    id: "nd_birthday",
    kind: "birthday",
    entityId: "ent_alex",
    name: "Alex Kim",
    text: "Alex Kim's birthday is on Thursday",
    daysAgo: null,
    channel: null,
    date: "2026-11-05",
    overdue: false,
  },
];

const withNudges = (w: FixtureWorld) => {
  w.review = {
    ...(w.review ?? { items: [], quarantine: [], runs: [] }),
    nudges: { items: nudges, muted: [] },
  };
};

const meta = {
  title: "Screens/Home",
  component: HomeScreen,
  decorators: [withWorld({ edit: withNudges, slots: { prefillComposer: () => {} } })],
  args: { now: STORY_NOW, onNavigate: () => {} },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof HomeScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Day: Story = {};

/** Nothing waits on the owner: the first idea takes the accent. */
export const NothingNeedsYou: Story = {
  decorators: [
    withWorld({
      edit: (w) => {
        withNudges(w);
        w.notifications = w.notifications.filter(
          (n) => n.kind !== "approval" && n.kind !== "input_needed",
        );
      },
    }),
  ],
};

/** A quiet day: no brief yet, no suggestions, nothing scheduled, no goals. */
export const QuietDay: Story = {
  decorators: [
    withWorld({
      edit: (w) => {
        w.notifications = [];
        w.feed = [];
        w.ideas = [];
        w.goals = [];
        w.automations = [];
      },
    }),
  ],
};

/** A first visit: nothing said yet, so the Ask field offers things to try (consolidation §7). */
export const FirstVisit: Story = {
  decorators: [
    withWorld({
      edit: (w) => {
        w.notifications = [];
        w.feed = [];
        w.ideas = [];
        w.goals = [];
        w.automations = [];
        w.threads = w.threads
          .filter((e) => e.thread.kind === "main")
          .map((e) => ({ ...e, thread: { ...e.thread, lastMessageAt: null } }));
      },
    }),
  ],
};

export const Narrow: Story = {
  render: (args) => (
    <div className="max-w-[420px]">
      <HomeScreen {...args} />
    </div>
  ),
};

export const People: StoryObj<typeof PeopleScreen> = {
  render: () => <PeopleScreen onNavigate={() => {}} />,
};
